#!/usr/bin/env python3
"""Decoupe les moments reperes en boucles WebM + posters JPEG.

    python extract_loops.py --in out/cyberpunk.json --out-dir out/loops

Format de sortie volontairement calque sur celui d'anilay : une VIDEO plus un
POSTER separe. Le poster s'affiche pendant que la boucle charge — sans lui, un
fond animé montre un cadre vide au premier affichage.

POURQUOI PAS DE GIF. Mesure du 26/08/2026, meme plan de Cyberpunk :

    WebM VP9  1280x720, 14,5 s  ->    591 Ko
    GIF        640 px,   5,0 s  ->  5 281 Ko

Dix fois plus lourd, pour deux fois moins de definition et trois fois moins de
duree. Le GIF plafonne a 256 couleurs : sur du neon et des degrades, il rend
une bouillie. Aucun navigateur cible n'a besoin de GIF pour jouer une boucle.

`-an` : un fond n'a pas de son, et l'enlever economise la piste entiere.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESOLVER = Path(__file__).resolve().parent / "resolve.mjs"


def resolve(slug: str, season: str, lang: str, eps: list[int], host: str) -> dict[int, dict]:
    p = subprocess.run(
        ["node", str(RESOLVER), slug, season, lang, str(min(eps)), str(max(eps)), host],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    lines = (p.stdout or "").strip().splitlines()
    if not lines:
        return {}
    try:
        d = json.loads(lines[-1])
    except json.JSONDecodeError:
        return {}
    return {int(e["ep"]): {"url": e["url"], "referer": e.get("referer")}
            for e in (d.get("episodes") or [])}


def cut(info: dict, start: float, end: float, base: Path, width: int, crf: int) -> bool:
    # Le referer voyage avec l'URL : sans lui la famille Vidmoly renvoie 403 sur
    # les segments, et une URL parfaitement resolue devient illisible.
    url, ref = info["url"], info.get("referer")
    head = ["-headers", f"Referer: {ref}\r\n"] if ref else []
    # -ss AVANT -i : ffmpeg saute directement dans le fichier au lieu de le lire
    # depuis le debut. Sur un flux distant c'est la difference entre quelques
    # secondes et plusieurs minutes.
    v = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
         "-ss", f"{start:.2f}", "-to", f"{end:.2f}", *head, "-i", url, "-an",
         "-vf", f"scale={width}:-2,fps=24",
         "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(crf), "-row-mt", "1",
         "-y", str(base.with_suffix(".webm"))],
        capture_output=True, text=True,
    )
    if v.returncode != 0:
        print(f"  [echec video] {(v.stderr or '').strip().splitlines()[-1:]}", file=sys.stderr)
        return False
    # Le poster est pris au MILIEU du clip : son premier cadre est souvent une
    # transition, et une vignette de transition ne represente pas la scene.
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
         "-ss", f"{(start + end) / 2:.2f}", *head, "-i", url, "-frames:v", "1",
         "-vf", f"scale={width}:-2", "-q:v", "3",
         "-y", str(base.with_suffix(".jpg"))],
        capture_output=True, text=True,
    )
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--in", dest="src", required=True, help="JSON produit par find_moments.py")
    ap.add_argument("--out-dir", default="out/loops")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--crf", type=int, default=34, help="34 = bon compromis poids/qualite")
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    doc = json.loads(Path(args.src).read_text(encoding="utf-8"))
    moments = doc["moments"]
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    urls = resolve(doc["slug"], doc["season"], doc["lang"],
                   [m["ep"] for m in moments], doc["host"])
    if not urls:
        print("resolution impossible", file=sys.stderr)
        return 1

    def one(item: tuple[int, dict]) -> None:
        i, m = item
        info = urls.get(m["ep"])
        if not info:
            print(f"  #{i}: ep{m['ep']} non resolu", file=sys.stderr)
            return
        base = out / f"{doc['slug']}-ep{m['ep']:02d}-{int(m['start'])}"
        if cut(info, m["start"], m["end"], base, args.width, args.crf):
            kb = base.with_suffix(".webm").stat().st_size / 1024
            print(f"  #{i:>2} ep{m['ep']:<3} {m['end']-m['start']:.1f}s  {kb:>7.1f} Ko  {base.name}")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(one, enumerate(moments, 1)))

    print(f"-> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
