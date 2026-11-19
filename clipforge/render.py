"""Cut and format clips with ffmpeg (vertical 9:16 for TikTok / Shorts / Reels)."""

from __future__ import annotations

import os
from pathlib import Path

from .score import Clip
from .utils import log, require_binary, run

W, H = 1080, 1920

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


def find_font(user_font: str | None = None) -> str | None:
    for f in ([user_font] if user_font else []) + FONT_CANDIDATES:
        if f and os.path.exists(f):
            return f
    return None


def _esc(path: str) -> str:
    """Escape a path for use inside an ffmpeg filter argument."""
    return path.replace("\\", "/").replace(":", r"\:").replace("'", r"\'")


def build_filter(fmt: str, zoom: float, title_file: str | None, font: str | None, srt_name: str | None) -> str:
    if fmt == "vertical":
        fg_w = int(W * zoom) // 2 * 2
        chain = (
            f"[0:v]split=2[bgsrc][fgsrc];"
            f"[bgsrc]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=25:3,eq=brightness=-0.08[bg];"
            f"[fgsrc]scale={fg_w}:-2,crop=min(iw\\,{W}):ih[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2"
        )
    elif fmt == "crop":
        chain = f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"
    else:  # original
        chain = "[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2"
    chain += ",setsar=1"
    if title_file and font:
        chain += (
            f",drawtext=fontfile='{_esc(font)}':textfile='{_esc(title_file)}':"
            "fontcolor=white:fontsize=h/24:borderw=6:bordercolor=black:"
            "x=(w-text_w)/2:y=h*0.11:line_spacing=12"
        )
    if srt_name:
        style = "Fontname=DejaVu Sans,Fontsize=15,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=70"
        chain += f",subtitles='{_esc(srt_name)}':force_style='{style}'"
    return chain + "[v]"


def write_srt(transcript: list[dict], start: float, end: float, path: Path, words_per_line: int = 3) -> bool:
    """Short, punchy word-group captions (TikTok style), times relative to the clip."""
    words = []
    for seg in transcript:
        if seg["end"] < start or seg["start"] > end:
            continue
        if seg.get("words"):
            words += [w for w in seg["words"] if start <= w["start"] < end]
        else:
            words.append({"start": max(seg["start"], start), "end": min(seg["end"], end), "text": seg["text"]})
    if not words:
        return False

    def ts(t: float) -> str:
        t = max(0.0, t - start)
        ms = int(round(t * 1000))
        h, ms = divmod(ms, 3600000)
        m, ms = divmod(ms, 60000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    lines = []
    for i in range(0, len(words), words_per_line):
        grp = words[i: i + words_per_line]
        text = " ".join(w["text"].strip() for w in grp).upper()
        lines.append(f"{len(lines) + 1}\n{ts(grp[0]['start'])} --> {ts(min(grp[-1]['end'], end))}\n{text}\n")
    path.write_text("\n".join(lines), encoding="utf-8")
    return True


def render_clip(
    src: str,
    clip: Clip,
    out_dir: Path,
    *,
    fmt: str = "vertical",
    zoom: float = 1.0,
    title: str | None = None,
    font: str | None = None,
    transcript: list[dict] | None = None,
    crf: int = 20,
    preset: str = "veryfast",
) -> Path:
    require_binary("ffmpeg")
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"clip_{clip.rank:02d}"
    out = out_dir / f"{stem}.mp4"

    title_file = None
    if title:
        tf = out_dir / f"{stem}_title.txt"
        clean = "".join(ch for ch in title if ord(ch) < 0x2000).strip()  # most fonts lack emoji glyphs
        tf.write_text(clean or title, encoding="utf-8")
        title_file = tf.name
    srt_name = None
    if transcript:
        srt = out_dir / f"{stem}.srt"
        if write_srt(transcript, clip.start, clip.end, srt):
            srt_name = srt.name

    font = find_font(font) if title_file else None
    if title_file and not font:
        log("   ⚠ Aucune police trouvée → titre ignoré (utilise --font)")
    vf = build_filter(fmt, zoom, title_file, font, srt_name)

    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{clip.start:.3f}", "-i", os.path.abspath(src), "-t", f"{clip.duration:.3f}",
        "-filter_complex", vf, "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p", "-r", "30",
        "-c:a", "aac", "-b:a", "160k", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
        "-movflags", "+faststart", out.name,
    ]
    # run inside out_dir so the subtitle/title paths are simple relative names
    run(cmd, cwd=out_dir)

    thumb_t = max(0.0, clip.peak - clip.start)
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{thumb_t:.2f}", "-i", out.name,
         "-frames:v", "1", "-q:v", "3", f"{stem}.jpg"], cwd=out_dir)
    if title_file:
        (out_dir / title_file).unlink(missing_ok=True)
    return out
