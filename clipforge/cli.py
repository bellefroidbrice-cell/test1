"""Command-line interface.

    python -m clipforge discover "GTA 6" --days 7
    python -m clipforge clip https://youtube.com/watch?v=... -n 5 --length 30
    python -m clipforge clip ma_session.mp4 --title "LA POLICE M'A EU 😭" --subs
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

import numpy as np

from . import analyze, fetch, render, score
from .utils import ClipForgeError, fmt_ts, log, probe

HASHTAGS = "#gta6 #gtavi #gta #gaming #rockstargames #viceCity #fyp #shorts"


def sparkline(x: np.ndarray, width: int = 60) -> str:
    if x.size == 0:
        return ""
    bars = " ▁▂▃▄▅▆▇█"
    chunks = np.array_split(x, min(width, x.size))
    vals = np.array([c.max() for c in chunks])
    vals = vals / (vals.max() or 1)
    return "".join(bars[int(v * (len(bars) - 1))] for v in vals)


def slug(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", s).strip("_")[:60] or "video"


# ----------------------------------------------------------------------------- discover
def cmd_discover(a: argparse.Namespace) -> int:
    rows = fetch.discover(a.query, limit=a.limit, min_duration=a.min_duration,
                          max_age_days=a.days if a.days > 0 else None)
    if not rows:
        log("Aucun résultat.")
        return 1
    print(f"\n{'#':>2}  {'score':>9}  {'vues/h':>9}  {'vues':>10}  {'âge':>6}  {'durée':>6}  HM  titre")
    for i, r in enumerate(rows[: a.top], 1):
        age = f"{r['age_hours'] / 24:.1f}j" if r["age_hours"] else "?"
        print(f"{i:>2}  {r['score']:>9.0f}  {r['views_per_hour']:>9.0f}  {r['views']:>10,}  {age:>6}  "
              f"{fmt_ts(r['duration'] or 0):>6}  {'✓' if r['has_heatmap'] else ' '}   {(r['title'] or '')[:70]}")
        print(f"{'':>14}{r['url']}  — {r['channel']}")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "discover.json").write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    with open(out / "discover.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    log(f"\n💾 {out / 'discover.csv'}  — passe les URLs à `clip` pour les découper.")
    return 0


# ----------------------------------------------------------------------------- clip
def process_source(source: str, a: argparse.Namespace) -> dict:
    out_root = Path(a.out)
    meta: dict = {}
    if fetch.is_url(source):
        path, meta = fetch.download(source, out_root / "_sources", max_height=a.max_height)
    else:
        path = Path(source)
        if not path.exists():
            raise ClipForgeError(f"Fichier introuvable : {source}")
    info = probe(path)
    if not info["has_video"]:
        raise ClipForgeError(f"Pas de piste vidéo dans {path}")
    dur = info["duration"]
    name = slug(meta.get("title") or path.stem)
    out_dir = out_root / name
    log(f"\n🎬 {meta.get('title') or path.name}  ({fmt_ts(dur)}, {info['width']}x{info['height']})")

    signals: dict[str, np.ndarray] = {}
    log("🔊 Analyse audio…")
    signals["audio"] = analyze.audio_energy(str(path), dur) if info["has_audio"] else np.zeros(int(np.ceil(dur)))
    loud = analyze.quietness(str(path), dur) if info["has_audio"] else np.zeros(int(np.ceil(dur)))
    log("🎞  Détection des changements de plan…")
    signals["scene"] = analyze.scene_cuts(str(path), dur, threshold=a.scene_threshold)
    if meta.get("heatmap"):
        signals["heatmap"] = analyze.heatmap_signal(meta["heatmap"], dur)
    transcript: list[dict] = []
    if a.subs or a.keywords:
        transcript = analyze.transcribe(str(path), a.whisper_model, a.lang)
        if transcript:
            signals["keywords"] = analyze.keyword_signal(transcript, dur, a.extra_words)

    weights = {k: float(v) for k, v in (kv.split("=") for kv in a.weight)} if a.weight else None
    total = score.combine(signals, weights)
    clips = score.pick_clips(total, signals, loud, count=a.count, length=min(a.length, int(dur)),
                             min_gap=a.gap, hook_position=a.hook)

    log(f"\n   intensité  |{sparkline(total)}|")
    for c in clips:
        log(f"   #{c.rank}  {fmt_ts(c.start)} → {fmt_ts(c.end)}  score {c.score:5.1f}  · {', '.join(c.reasons)}")

    rendered = []
    if not a.dry_run:
        for c in clips:
            log(f"✂  Rendu clip #{c.rank} ({a.format})…")
            title = a.title.replace("{n}", str(c.rank)) if a.title else None
            p = render.render_clip(str(path), c, out_dir, fmt=a.format, zoom=a.zoom, title=title,
                                   font=a.font, transcript=transcript if a.subs else None, crf=a.crf)
            rendered.append(str(p))

    report = {
        "source": source,
        "file": str(path),
        "title": meta.get("title"),
        "uploader": meta.get("uploader"),
        "duration": dur,
        "signals_used": [k for k, v in signals.items() if np.any(v)],
        "clips": [{**c.to_dict(), "file": rendered[i] if i < len(rendered) else None,
                   "start_ts": fmt_ts(c.start), "end_ts": fmt_ts(c.end),
                   "source_link": f"{meta['webpage_url']}&t={int(c.start)}s" if meta.get("webpage_url") else None}
                  for i, c in enumerate(clips)],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    write_markdown(report, out_dir / "report.md")
    log(f"💾 {out_dir}/")
    return report


def write_markdown(r: dict, path: Path) -> None:
    lines = [f"# {r.get('title') or Path(r['file']).name}", ""]
    if r.get("uploader"):
        lines += [f"Source : {r['source']} — **{r['uploader']}** (crédite le créateur dans ta description)", ""]
    lines += [f"Signaux utilisés : {', '.join(r['signals_used'])}", "",
              "| # | Début | Fin | Durée | Score | Pourquoi | Fichier |", "|---|---|---|---|---|---|---|"]
    for c in r["clips"]:
        lines.append(f"| {c['rank']} | {c['start_ts']} | {c['end_ts']} | {c['duration']:.0f}s | {c['score']} | "
                     f"{', '.join(c['reasons'])} | {Path(c['file']).name if c['file'] else '—'} |")
    lines += ["", "## Légende suggérée", "",
              "```", "Ce moment sur GTA 6 😳 attends la fin…", "",
              *([f"🎥 Crédit : {r['uploader']}"] if r.get("uploader") else []), HASHTAGS, "```", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def cmd_clip(a: argparse.Namespace) -> int:
    sources = list(a.sources)
    if a.from_discover:
        rows = json.loads(Path(a.from_discover).read_text(encoding="utf-8"))
        sources += [r["url"] for r in rows[: a.top]]
    ok = 0
    for s in sources:
        try:
            process_source(s, a)
            ok += 1
        except ClipForgeError as e:
            log(f"❌ {s}: {e}")
    return 0 if ok else 1


# ----------------------------------------------------------------------------- parser
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="clipforge", description="Trouve et découpe les meilleurs moments d'une vidéo.")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("discover", help="trouver les vidéos qui montent le plus vite")
    d.add_argument("query", nargs="?", default="GTA 6")
    d.add_argument("--limit", type=int, default=40, help="nombre de résultats à analyser")
    d.add_argument("--top", type=int, default=15, help="nombre de lignes affichées")
    d.add_argument("--days", type=int, default=7, help="âge max des vidéos en jours (0 = illimité)")
    d.add_argument("--min-duration", type=int, default=180, help="ignore les vidéos plus courtes (s)")
    d.add_argument("--out", default="output")
    d.set_defaults(func=cmd_discover)

    c = sub.add_parser("clip", help="analyser et découper une ou plusieurs vidéos (URL ou fichier)")
    c.add_argument("sources", nargs="*")
    c.add_argument("--from-discover", metavar="JSON", help="utiliser les URLs d'un discover.json")
    c.add_argument("--top", type=int, default=3, help="avec --from-discover : nb de vidéos à traiter")
    c.add_argument("-n", "--count", type=int, default=5, help="nombre de clips par vidéo")
    c.add_argument("-l", "--length", type=int, default=30, help="durée d'un clip (s)")
    c.add_argument("--gap", type=int, default=10, help="écart minimum entre deux clips (s)")
    c.add_argument("--hook", type=float, default=0.35, help="position du pic dans le clip (0-1)")
    c.add_argument("--format", choices=["vertical", "crop", "original"], default="vertical",
                   help="vertical = 9:16 fond flouté, crop = 9:16 recadré au centre")
    c.add_argument("--zoom", type=float, default=1.0, help="zoom de l'image en mode vertical (ex: 1.4)")
    c.add_argument("--title", help="texte incrusté en haut ({n} = numéro du clip)")
    c.add_argument("--font", help="chemin d'une police .ttf pour le titre")
    c.add_argument("--subs", action="store_true", help="sous-titres auto incrustés (faster-whisper)")
    c.add_argument("--keywords", action="store_true", help="utiliser la transcription pour le scoring")
    c.add_argument("--extra-words", nargs="*", default=[], help="mots-clés de hype supplémentaires")
    c.add_argument("--whisper-model", default="small")
    c.add_argument("--lang", default=None, help="langue de la vidéo (fr, en…) — auto sinon")
    c.add_argument("--scene-threshold", type=float, default=0.3)
    c.add_argument("--weight", action="append", metavar="SIGNAL=W",
                   help="poids d'un signal, ex: --weight audio=2 (audio, scene, heatmap, keywords)")
    c.add_argument("--max-height", type=int, default=1080)
    c.add_argument("--crf", type=int, default=20)
    c.add_argument("--dry-run", action="store_true", help="analyser sans exporter")
    c.add_argument("--out", default="output")
    c.set_defaults(func=cmd_clip)
    return p


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    try:
        return a.func(a)
    except ClipForgeError as e:
        log(f"❌ {e}")
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
