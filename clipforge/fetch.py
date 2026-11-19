"""Discover trending videos and download sources with yt-dlp (optional dependency)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .utils import ClipForgeError, log


def _yt_dlp():
    try:
        import yt_dlp  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise ClipForgeError("yt-dlp n'est pas installé : pip install yt-dlp") from exc
    return yt_dlp


def is_url(s: str) -> bool:
    return s.startswith(("http://", "https://"))


def download(url: str, out_dir: Path, max_height: int = 1080) -> tuple[Path, dict]:
    """Download a video and return (local_path, metadata). Metadata includes YouTube's
    'Most replayed' heatmap when available — the strongest signal of what viewers liked."""
    yt_dlp = _yt_dlp()
    out_dir.mkdir(parents=True, exist_ok=True)
    opts = {
        "format": f"bv*[height<={max_height}]+ba/b[height<={max_height}]/b",
        "merge_output_format": "mp4",
        "outtmpl": str(out_dir / "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    log(f"⬇  Téléchargement : {url}")
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        path = Path(ydl.prepare_filename(info))
    if not path.exists():
        candidates = sorted(out_dir.glob(f"{info['id']}.*"))
        if not candidates:
            raise ClipForgeError("Téléchargement terminé mais fichier introuvable.")
        path = candidates[0]
    meta = {
        "id": info.get("id"),
        "title": info.get("title"),
        "uploader": info.get("uploader"),
        "webpage_url": info.get("webpage_url", url),
        "view_count": info.get("view_count"),
        "heatmap": info.get("heatmap") or [],
    }
    if meta["heatmap"]:
        log(f"   ✓ Heatmap « Most replayed » récupérée ({len(meta['heatmap'])} points)")
    return path, meta


def discover(query: str, limit: int = 20, min_duration: int = 120, max_age_days: int | None = 14) -> list[dict]:
    """Search YouTube and rank results by view velocity (views per hour since upload).
    Fast-growing videos are the best clipping targets: the topic is hot right now."""
    yt_dlp = _yt_dlp()
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "ignoreerrors": True}
    search = f"ytsearch{limit}:{query}"
    log(f"🔎 Recherche : {query!r} ({limit} résultats)")
    with yt_dlp.YoutubeDL(opts) as ydl:
        res = ydl.extract_info(search, download=False) or {}
    now = datetime.now(timezone.utc)
    rows = []
    for e in res.get("entries") or []:
        if not e:
            continue
        dur = e.get("duration") or 0
        if dur and dur < min_duration:
            continue
        ts = e.get("timestamp")
        if ts:
            uploaded = datetime.fromtimestamp(ts, timezone.utc)
        elif e.get("upload_date"):
            uploaded = datetime.strptime(e["upload_date"], "%Y%m%d").replace(tzinfo=timezone.utc)
        else:
            uploaded = None
        age_h = max(1.0, (now - uploaded).total_seconds() / 3600) if uploaded else None
        if max_age_days and age_h and age_h > max_age_days * 24:
            continue
        views = e.get("view_count") or 0
        likes = e.get("like_count") or 0
        comments = e.get("comment_count") or 0
        velocity = views / age_h if age_h else 0.0
        engagement = (likes + 3 * comments) / views if views else 0.0
        rows.append({
            "title": e.get("title"),
            "url": e.get("webpage_url") or e.get("url"),
            "channel": e.get("channel") or e.get("uploader"),
            "duration": dur,
            "views": views,
            "age_hours": round(age_h, 1) if age_h else None,
            "views_per_hour": round(velocity, 1),
            "engagement": round(engagement, 4),
            "has_heatmap": bool(e.get("heatmap")),
            # Velocity dominates; engagement and heatmap availability break ties.
            "score": round(velocity * (1 + 5 * engagement) * (1.15 if e.get("heatmap") else 1.0), 1),
        })
    rows.sort(key=lambda r: r["score"], reverse=True)
    return rows
