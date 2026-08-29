#!/usr/bin/env python3
"""Reperage des moments MARQUANTS d'une saison, par singularite visuelle.

    python find_moments.py --slug cyberpunk-edgerunners --season saison1 \
        --lang vostfr --start 1 --end 10 --top 10 --out out/cyberpunk.json

Sortie : un JSON par moment retenu — {ep, start, end, score} — que
`extract_loops.py` transforme en boucles WebM + posters JPEG.

CE QUE CE N'EST PAS : un detecteur de generique. Pour l'OP/ED, voir
`tools/opening-detector`, qui ancre sur les references AnimeThemes. Ici on
cherche l'inverse : les plans que personne n'a annotes nulle part.

POURQUOI LA PALETTE ET PAS LA DENSITE DE COUPES
-----------------------------------------------
La premiere version comptait les changements de plan (ffmpeg `scdet`). Ca
marche, c'est meme joli sur un graphe — mais ca mesure le RYTHME DE MONTAGE,
pas l'importance. Mesure du 27/08/2026 sur Cyberpunk saison 1 : le classement
par coupes ne contenait PAS la scene de la Lune (ep10, 24:09), la plus connue
de la serie, parce qu'elle est faite de plans longs et tenus. Elle etait en bas
du classement sur le seul critere mesure.

Ce qui rend un plan memorable, c'est qu'il ne ressemble a rien d'autre dans son
episode. Ca se mesure : on caracterise chaque image cle par sa palette (moyenne
et ecart-type RVB, saturation, luminance) et on classe par ecart robuste a la
MEDIANE de l'episode. La Lune — un gris-blanc desature au milieu d'un episode
sature de neon — occupe alors 3 places du top 10. Verifie a l'image, pas au
chiffre.

Bonus : c'est aussi BEAUCOUP moins de donnees. La densite de coupes exige de
decoder toutes les frames ; ici une image cle en 64x36 suffit. Le temps de
traitement reste domine par le TELECHARGEMENT du fichier, identique dans les
deux cas (mesure : 11 min pour 10 episodes a 3 flux).

C'est le meme principe que `pick_landmarks` dans le detecteur OP/ED : ce qui
est RARE est ce qui compte. Une frame banale ne se relocalise pas, et ne marque
pas non plus.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

W, H = 64, 36                    # une palette n'a pas besoin de mieux
FRAME_BYTES = W * H * 3
MIN_CLIP, MAX_CLIP = 8.0, 15.0   # bornes d'une boucle utilisable
EXTENT_RATIO = 0.55              # on etend tant que le voisin garde 55 % du pic
HEAD_SKIP, TAIL_SKIP = 75.0, 45.0  # generiques : hors concours

ROOT = Path(__file__).resolve().parents[2]
RESOLVER = Path(__file__).resolve().parent / "resolve.mjs"   # le notre, pas celui du detecteur

def resolve(slug: str, season: str, lang: str, a: int, b: int, host: str) -> dict[int, dict]:
    """Les episodes a..b chez `host` : {ep: {url, referer}}.

    Le `referer` voyage avec l'URL et n'est pas optionnel : la famille Vidmoly
    refuse les segments (403) sans lui. Une URL parfaitement resolue que ffmpeg
    ne peut pas lire ressemble a une panne d'hote — ca a coute un diagnostic.
    """
    p = subprocess.run(
        ["node", str(RESOLVER), slug, season, lang, str(a), str(b), host],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    line = (p.stdout or "").strip().splitlines()
    if not line:
        return {}
    try:
        d = json.loads(line[-1])
    except json.JSONDecodeError:
        return {}
    return {int(e["ep"]): {"url": e["url"], "referer": e.get("referer")}
            for e in (d.get("episodes") or [])}


def sample(ep_info: dict, dst: Path) -> tuple[np.ndarray, np.ndarray] | None:
    """Une image cle sur deux dimensions reduites, plus son instant exact.

    `-skip_frame nokey` : on ne decode QUE les images cles. Sur un episode de
    ~35 000 frames ca change tout, et une palette n'a rien a y perdre.
    """
    url, ref = ep_info["url"], ep_info.get("referer")
    head = ["-headers", f"Referer: {ref}\r\n"] if ref else []
    rgb, tsv = dst.with_suffix(".rgb"), dst.with_suffix(".t")

    # -nostdin est INDISPENSABLE : lance depuis une boucle qui lit un fichier,
    # ffmpeg herite du flux d'entree, le prend pour des touches clavier et sort
    # en deux secondes — avec un code de SUCCES et une sortie vide, ce qui
    # ressemble trait pour trait a « aucun moment trouve ».
    r = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
         "-skip_frame", "nokey", *head, "-i", url,
         "-vsync", "0", "-vf", f"scale={W}:{H}",
         "-f", "rawvideo", "-pix_fmt", "rgb24", str(rgb), "-y"],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not rgb.exists() or rgb.stat().st_size < FRAME_BYTES:
        print(f"  [echec] {(r.stderr or '').strip().splitlines()[-1:] or 'sortie vide'}",
              file=sys.stderr)
        return None

    # Les pts des memes images cles : sans eux les timecodes seraient deduits
    # d'une cadence supposee, alors que l'espacement des images cles varie.
    q = subprocess.run(
        ["ffprobe", "-v", "error", "-skip_frame", "nokey", "-select_streams", "v:0",
         *head, "-show_entries", "frame=best_effort_timestamp_time",
         "-of", "csv=p=0", url],
        capture_output=True, text=True,
    )
    times = [float(x) for x in (q.stdout or "").replace(",", " ").split()
             if x.replace(".", "", 1).isdigit()]
    if not times:
        return None

    data = np.fromfile(rgb, dtype=np.uint8)
    n = min(len(data) // FRAME_BYTES, len(times))
    if n < 10:
        return None
    frames = data[: n * FRAME_BYTES].reshape(n, H, W, 3).astype(np.float32)
    tsv.write_text("\n".join(f"{t:.3f}" for t in times[:n]), encoding="utf-8")
    return frames, np.array(times[:n])


def score(frames: np.ndarray, times: np.ndarray, top: int) -> list[dict]:
    """Les `top` moments les plus atypiques d'un episode, avec leur etendue."""
    mean = frames.mean(axis=(1, 2))
    std = frames.std(axis=(1, 2))
    mx, mn = frames.max(axis=3), frames.min(axis=3)
    sat = ((mx - mn) / (mx + 1e-6)).mean(axis=(1, 2))[:, None] * 255
    lum = frames.mean(axis=3).mean(axis=(1, 2))[:, None]
    feat = np.hstack([mean, std, sat, lum])

    # Mediane + MAD, pas moyenne + ecart-type : un seul plan tres atypique
    # tirerait la moyenne vers lui et se masquerait lui-meme.
    med = np.median(feat, axis=0)
    mad = np.median(np.abs(feat - med), axis=0) + 1e-6
    sc = (np.abs(feat - med) / mad).mean(axis=1)

    dur = float(times.max())
    ok = (times > HEAD_SKIP) & (times < dur - TAIL_SKIP)
    order = np.argsort(-np.where(ok, sc, -1.0))

    out: list[dict] = []
    for i in order:
        if not ok[i]:
            continue
        if any(abs(times[i] - o["peak"]) <= 30 for o in out):
            continue  # jamais deux fois la meme scene
        # ETENDUE : on elargit tant que les voisines restent atypiques. Quand
        # le plan singulier est isole entre deux images cles, l'etendue vaut 0
        # et on retombe sur une fenetre fixe centree — mieux qu'un instant sans
        # duree, qui ne fait pas une boucle.
        thr = EXTENT_RATIO * sc[i]
        a = b = int(i)
        while a - 1 >= 0 and sc[a - 1] > thr:
            a -= 1
        while b + 1 < len(sc) and sc[b + 1] > thr:
            b += 1
        s0, s1 = float(times[a]), float(times[b])
        if s1 - s0 < MIN_CLIP:
            mid = (s0 + s1) / 2
            s0, s1 = mid - MIN_CLIP / 2, mid + MIN_CLIP / 2
        elif s1 - s0 > MAX_CLIP:
            s0, s1 = float(times[i]) - MAX_CLIP / 2, float(times[i]) + MAX_CLIP / 2
        out.append({"peak": float(times[i]), "start": max(0.0, round(s0, 2)),
                    "end": round(s1, 2), "score": round(float(sc[i]), 2)})
        if len(out) >= top:
            break
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--slug", required=True, help="slug anime-sama")
    ap.add_argument("--season", default="saison1")
    ap.add_argument("--lang", default="vostfr")
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--end", type=int, default=12)
    ap.add_argument("--host", default="ansembed",
                    help="ansembed par defaut : sibnet renvoie 403 des le 3e flux parallele")
    ap.add_argument("--workers", type=int, default=3,
                    help="flux simultanes — au-dela de 3 les hotes limitent")
    ap.add_argument("--per-episode", type=int, default=4)
    ap.add_argument("--top", type=int, default=10, help="moments gardes pour la saison")
    ap.add_argument("--cache", default="cache", help="dossier des echantillons bruts")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)

    urls = resolve(args.slug, args.season, args.lang, args.start, args.end, args.host)
    if not urls:
        print(f"aucun episode resolu chez {args.host}", file=sys.stderr)
        return 1
    print(f"{len(urls)} episode(s) resolu(s) chez {args.host}")

    found: list[dict] = []

    def one(ep: int) -> None:
        got = sample(urls[ep], cache / f"{args.slug}-{args.lang}-ep{ep}")
        if not got:
            print(f"  ep{ep}: echec", file=sys.stderr)
            return
        frames, times = got
        moments = score(frames, times, args.per_episode)
        for m in moments:
            m["ep"] = ep
        found.extend(moments)
        print(f"  ep{ep}: {len(frames)} images cles, {len(moments)} moment(s)")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(one, sorted(urls)))

    found.sort(key=lambda m: -m["score"])
    top = found[: args.top]
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(
        json.dumps({"slug": args.slug, "season": args.season, "lang": args.lang,
                    "host": args.host, "moments": top}, indent=1, ensure_ascii=False),
        encoding="utf-8")

    print(f"\ntop {len(top)} :")
    for r, m in enumerate(top, 1):
        s, e = m["start"], m["end"]
        print(f"  {r:>2}. ep{m['ep']:<3} {int(s//60)}:{s%60:05.2f} -> "
              f"{int(e//60)}:{e%60:05.2f}  ({e-s:.1f}s, ecart {m['score']})")
    print(f"-> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
