"""Signal extraction: everything is reduced to one value per second of video."""

from __future__ import annotations

import re
import subprocess

import numpy as np

from .utils import log, require_binary

SR = 8000  # audio sample rate used for analysis (enough for loudness)

# Words/expressions that usually mark a highlight (reactions, hype, fails) — EN + FR.
HYPE_WORDS = [
    "no way", "oh my god", "omg", "what the", "wtf", "let's go", "lets go", "holy", "insane",
    "crazy", "bro", "dude", "look at that", "are you kidding", "did you see", "clip that",
    "wow", "yo", "run", "hide", "help", "police", "cops", "wanted", "chase", "crash", "boom",
    "c'est pas possible", "oh mon dieu", "putain", "incroyable", "t'as vu", "regarde", "allez",
    "trop fort", "dingue", "énorme", "la police", "les flics", "course-poursuite", "explosion",
]


def audio_energy(path: str, duration: float) -> np.ndarray:
    """Per-second loudness *relative to the local baseline* (z-score vs. a rolling median).
    Shouting, explosions and crowd reactions stand out even if the whole video is loud."""
    require_binary("ffmpeg")
    n = int(np.ceil(duration))
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
        capture_output=True,
    )
    pcm = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    if pcm.size == 0:
        return np.zeros(n)
    hop = SR // 4  # 250 ms frames
    frames = pcm[: (pcm.size // hop) * hop].reshape(-1, hop)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-10)
    db = 20 * np.log10(rms)
    # 4 frames per second → peak (max) per second keeps short spikes (gunshots, screams)
    per_sec = np.full(n, db.min() if db.size else -100.0)
    m = min(n, db.size // 4)
    if m:
        per_sec[:m] = db[: m * 4].reshape(m, 4).max(axis=1)
    baseline = rolling_median(per_sec, 61)
    spread = np.std(per_sec) + 1e-6
    rel = (per_sec - baseline) / spread
    return np.clip(rel, 0, None)


def quietness(path: str, duration: float) -> np.ndarray:
    """Per-second mean loudness (dB), used to snap clip boundaries onto pauses."""
    n = int(np.ceil(duration))
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
        capture_output=True,
    )
    pcm = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    out = np.zeros(n)
    m = min(n, pcm.size // SR)
    if m:
        sec = pcm[: m * SR].reshape(m, SR)
        out[:m] = 20 * np.log10(np.sqrt(np.mean(sec ** 2, axis=1) + 1e-10))
    return out


def scene_cuts(path: str, duration: float, threshold: float = 0.3) -> np.ndarray:
    """Per-second count of visual scene changes. Lots of quick cuts / sudden visual
    changes = action (crashes, explosions, fast camera)."""
    require_binary("ffmpeg")
    n = int(np.ceil(duration))
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", path, "-an",
         "-vf", f"fps=6,scale=192:-2,select='gt(scene,{threshold})',showinfo",
         "-f", "null", "-"],
        capture_output=True,
    )
    times = [float(t) for t in re.findall(r"pts_time:([0-9.]+)", proc.stderr.decode(errors="replace"))]
    counts = np.zeros(n)
    for t in times:
        i = int(t)
        if 0 <= i < n:
            counts[i] += 1
    return counts


def heatmap_signal(heatmap: list[dict], duration: float) -> np.ndarray:
    """YouTube 'Most replayed' graph (0..1) resampled to one value per second."""
    n = int(np.ceil(duration))
    out = np.zeros(n)
    for seg in heatmap or []:
        a, b = int(seg.get("start_time", 0)), int(np.ceil(seg.get("end_time", 0)))
        out[max(0, a): min(n, b)] = max(out[max(0, a): min(n, b)].max(initial=0), float(seg.get("value", 0)))
    return out


def transcribe(path: str, model_size: str = "small", language: str | None = None) -> list[dict]:
    """Speech-to-text with faster-whisper (optional). Returns [{start, end, text}]."""
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        log("   (faster-whisper non installé → pas de transcription ni de sous-titres)")
        return []
    log(f"🗣  Transcription (whisper {model_size})…")
    model = WhisperModel(model_size, device="auto", compute_type="int8")
    segments, _ = model.transcribe(path, language=language, word_timestamps=True, vad_filter=True)
    out = []
    for s in segments:
        words = [{"start": w.start, "end": w.end, "text": w.word} for w in (s.words or [])]
        out.append({"start": s.start, "end": s.end, "text": s.text.strip(), "words": words})
    return out


def keyword_signal(transcript: list[dict], duration: float, extra: list[str] | None = None) -> np.ndarray:
    n = int(np.ceil(duration))
    out = np.zeros(n)
    words = [w.lower() for w in HYPE_WORDS + (extra or [])]
    for seg in transcript:
        text = seg["text"].lower()
        hits = sum(text.count(w) for w in words)
        hits += text.count("!")
        if hits:
            a, b = int(seg["start"]), int(np.ceil(seg["end"]))
            out[max(0, a): min(n, b)] += hits
    return out


def rolling_median(x: np.ndarray, win: int) -> np.ndarray:
    if x.size == 0:
        return x
    half = win // 2
    padded = np.pad(x, half, mode="edge")
    view = np.lib.stride_tricks.sliding_window_view(padded, win)
    return np.median(view, axis=1)[: x.size]
