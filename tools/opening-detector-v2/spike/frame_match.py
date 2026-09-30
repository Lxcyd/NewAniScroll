"""Compare ce que le LECTEUR affiche (tools/browser-check/frame-truth.mjs) a ce
que le detecteur decode, variante par variante.

    python -m spike.frame_match <mal> <ep> <lang> <host> <dossier truth> [--list f.json]

Pour chaque capture : on decode chaque variante du maitre (PTS absolus,
cadence native) autour du temps « Flux » annonce, et on cherche l'image la
plus ressemblante. Imprime, par variante, « PTS trouve - Flux ». Un ecart nul
a une image pres = le panneau « Flux » et le detecteur parlent de la meme
horloge ; sinon il donne l'ecart exact et son sens.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

import numpy as np
from PIL import Image

from fetch.episode import resolve, season_of
from match.image import episode_frames

ANIME = Path(__file__).resolve().parents[2] / "opening-detector" / "datasets" / "anime.gt10.json"
W, H = 32, 18
SEARCH_S = 5.0


def flux_s(txt: str) -> float:
    m, s = txt.split(":")
    return int(m) * 60 + float(s)


def variants(url: str, referer) -> list[str]:
    h = {"User-Agent": "Mozilla/5.0"}
    if referer:
        h["Referer"] = referer
    try:
        m = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60).read().decode()
    except Exception:
        return [url]
    if "#EXT-X-STREAM-INF" not in m:
        return [url]
    return [urljoin(url, l) for l in m.splitlines() if l and not l.startswith("#")]


def small(img: Image.Image) -> np.ndarray:
    a = np.asarray(img.convert("L").resize((W, H), Image.BILINEAR), dtype=np.float32)
    return a


def main(argv) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mal", type=int); ap.add_argument("ep", type=int); ap.add_argument("lang"); ap.add_argument("host")
    ap.add_argument("truth"); ap.add_argument("--list")
    a = ap.parse_args(argv)
    entry = next(x for x in json.load(open(a.list or ANIME, encoding="utf-8")) if x["mal_id"] == a.mal)
    s = next(x for x in resolve(entry, season_of(entry, a.lang), a.ep, hosts=[a.host]) if x["host"] == a.host)
    truth = json.load(open(Path(a.truth) / "truth.json", encoding="utf-8"))
    caps = [(r, small(Image.open(Path(a.truth) / r["png"]))) for r in truth["releves"] if r.get("flux") and r["flux"] != "—"]
    if not caps:
        print("aucune capture avec « Flux »")
        return 1
    lo = min(flux_s(r["flux"]) for r, _ in caps) - SEARCH_S
    hi = max(flux_s(r["flux"]) for r, _ in caps) + SEARCH_S
    for v in variants(s["url"], s.get("referer")):
        name = v.split("?")[0].split("/")[-1]
        try:
            ef, et = episode_frames(v, lo, hi - lo, referer=s.get("referer"), fps=None)
        except Exception as exc:
            print(f"{name}: decodage impossible ({str(exc)[:80]})")
            continue
        if not len(et):
            print(f"{name}: aucune image")
            continue
        ef = ef.reshape(len(ef), H, W).astype(np.float32) if ef.ndim == 3 else ef
        print(f"== {name}  ({len(et)} images, {et[0]:.2f}-{et[-1]:.2f})")
        for r, c in caps:
            d = np.abs(ef - c[None]).mean(axis=(1, 2))
            k = int(d.argmin())
            f = flux_s(r["flux"])
            second = np.sort(d)[min(3, len(d) - 1)]
            print(f"   Flux {r['flux']:>9}  -> PTS {et[k]:9.3f}  ecart {et[k] - f:+.3f} s  (err {d[k]:.1f}, 4e {second:.1f})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
