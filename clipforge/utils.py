"""Small helpers around ffmpeg/ffprobe."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


class ClipForgeError(RuntimeError):
    pass


def require_binary(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise ClipForgeError(
            f"'{name}' est introuvable. Installe FFmpeg (https://ffmpeg.org/download.html) "
            "et assure-toi qu'il est dans le PATH."
        )
    return path


def run(cmd: list[str], *, capture: bool = True, cwd: str | Path | None = None) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=capture, cwd=cwd)
    if proc.returncode != 0:
        err = proc.stderr.decode(errors="replace")[-2000:] if capture and proc.stderr else ""
        raise ClipForgeError(f"Commande échouée ({proc.returncode}): {' '.join(cmd[:6])} …\n{err}")
    return proc


def probe(path: str | Path) -> dict:
    require_binary("ffprobe")
    out = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]).stdout
    data = json.loads(out)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    duration = float(data.get("format", {}).get("duration") or 0.0)
    if not duration and video and video.get("duration"):
        duration = float(video["duration"])
    return {
        "duration": duration,
        "width": int(video["width"]) if video else 0,
        "height": int(video["height"]) if video else 0,
        "has_audio": audio is not None,
        "has_video": video is not None,
    }


def fmt_ts(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)
