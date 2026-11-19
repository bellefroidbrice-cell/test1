"""Combine signals and pick the best non-overlapping clip windows."""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np

DEFAULT_WEIGHTS = {"audio": 1.0, "scene": 0.6, "heatmap": 1.6, "keywords": 0.8}


@dataclass
class Clip:
    rank: int
    start: float
    end: float
    score: float
    peak: float
    reasons: list[str]

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict:
        d = asdict(self)
        d["duration"] = round(self.duration, 2)
        return d


def normalize(x: np.ndarray) -> np.ndarray:
    if x.size == 0 or np.allclose(x.max(), x.min()):
        return np.zeros_like(x, dtype=float)
    # robust: clip at 99th percentile so a single outlier doesn't flatten everything
    hi = np.percentile(x, 99) or x.max()
    return np.clip((x - x.min()) / (hi - x.min() + 1e-9), 0, 1)


def smooth(x: np.ndarray, k: int = 3) -> np.ndarray:
    if k <= 1 or x.size == 0:
        return x
    kernel = np.ones(k) / k
    return np.convolve(x, kernel, mode="same")


def combine(signals: dict[str, np.ndarray], weights: dict[str, float] | None = None) -> np.ndarray:
    weights = {**DEFAULT_WEIGHTS, **(weights or {})}
    n = max(s.size for s in signals.values())
    total = np.zeros(n)
    wsum = 0.0
    for name, sig in signals.items():
        if sig.size == 0 or not np.any(sig):
            continue
        w = weights.get(name, 1.0)
        s = np.zeros(n)
        s[: sig.size] = normalize(smooth(sig, 3))
        total += w * s
        wsum += w
    return total / wsum if wsum else total


def pick_clips(
    score: np.ndarray,
    signals: dict[str, np.ndarray],
    loudness: np.ndarray,
    count: int = 5,
    length: int = 30,
    min_gap: int = 10,
    hook_position: float = 0.35,
) -> list[Clip]:
    """Greedy selection of the `count` best windows of `length` seconds.

    Window score = 70% mean intensity + 30% peak, so a clip needs a strong moment
    *and* enough action around it. The peak is placed ~35% into the clip: a short
    lead-in for context, then the payoff, then the reaction."""
    n = score.size
    length = max(5, min(length, n))
    if n == 0:
        return []
    mean = np.convolve(score, np.ones(length) / length, mode="valid")  # index = window start
    used = np.zeros(n, dtype=bool)
    clips: list[Clip] = []
    order_peaks = np.argsort(score)[::-1]

    floor = 0.25 * float(score.max())  # ignore moments far weaker than the best one
    for peak_idx in order_peaks:
        if len(clips) >= count or score[peak_idx] < floor:
            break
        if used[peak_idx] or score[peak_idx] <= 0:
            continue
        start = int(round(peak_idx - hook_position * length))
        start = max(0, min(start, n - length))
        end = start + length
        lo, hi = max(0, start - min_gap), min(n, end + min_gap)
        if used[lo:hi].any():
            continue
        start = snap_to_pause(loudness, start, radius=2, lower=0)
        end = snap_to_pause(loudness, start + length, radius=2, upper=n)
        win_mean = float(mean[min(start, mean.size - 1)])
        s = 0.7 * win_mean + 0.3 * float(score[peak_idx])
        reasons = explain(signals, start, end)
        clips.append(Clip(0, float(start), float(end), round(s * 100, 1), float(peak_idx), reasons))
        used[start:end] = True

    clips.sort(key=lambda c: c.score, reverse=True)
    for i, c in enumerate(clips, 1):
        c.rank = i
    return clips


def snap_to_pause(loudness: np.ndarray, t: int, radius: int = 2, lower: int | None = None, upper: int | None = None) -> int:
    """Move a cut point to the quietest second nearby so we don't cut mid-sentence."""
    if loudness.size == 0:
        return t
    a = max(0 if lower is None else lower, t - radius)
    b = min(loudness.size if upper is None else upper, t + radius + 1)
    if b <= a:
        return t
    return int(a + np.argmin(loudness[a:b])) if b - a > 0 else t


LABELS = {
    "audio": "pic sonore (cris / explosions / réaction)",
    "scene": "action visuelle rapide",
    "heatmap": "passage le plus revu sur YouTube",
    "keywords": "réactions verbales fortes",
}


def explain(signals: dict[str, np.ndarray], start: int, end: int) -> list[str]:
    out = []
    for name, sig in signals.items():
        if sig.size == 0 or not np.any(sig):
            continue
        seg = sig[start:end]
        if seg.size and seg.mean() > 1.5 * (sig.mean() + 1e-9):
            out.append(LABELS.get(name, name))
    return out or ["intensité globale élevée"]
