"""P1 — la continuite audio separe-t-elle les vrais generiques des musiques reprises ?

Pour chaque episode de la liste : empreinte de l'episode complet (un lecteur),
comparaison dense contre TOUTES les references AnimeThemes de la serie,
toutes les apparitions trouvees avec leurs mesures de continuite.

Sorties : out/p1/results.jsonl (une ligne par apparition) et une planche PNG
par episode (courbe des bits differents de chaque apparition).

    python -m spike.p1 [--cases 16498:2,42310:1] [--lang vostfr]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from fetch import SAMPLE_RATE
from fetch.adapter_aniscroll import resolve_episodes_multi
from fetch.audio import decode_audio_abs
from fetch.probe import probe_duration
from fp.chroma import FRAME_S, decode_file, fingerprint
from match.ber import MATCH_BITS, occurrences
from refs.animethemes import download, fetch_themes, media_duration

ANIME_LIST = Path(__file__).resolve().parents[2] / "opening-detector" / "datasets" / "anime.gt10.json"
HOST_PREF = ["ansembed", "frembed", "sibnet", "megaplay", "vidmoly-va", "uqload"]
CASES = [
    # vrais generiques « propres »
    (16498, 2), (38000, 2), (40748, 2), (52991, 2), (42310, 2), (16049, 2), (47194, 2),
    # pieges connus (verdicts v3) : chanson en musique de scene, OP en generique
    # de fin, ED sur l'epilogue, ED special sur scenes inedites
    (42310, 1), (16049, 24), (47194, 25), (47194, 3), (38000, 1), (38000, 26),
    (16498, 25), (40748, 24), (52991, 28), (60334, 1),
]
OUT = Path("out/p1")


def episode_fp(entry: dict, ep: int, lang: str) -> tuple[str, float, np.ndarray]:
    """(lecteur, duree, empreinte) de l'episode complet, en cache."""
    cache = Path("cache/ep")
    hit = sorted(cache.glob(f"{entry['mal_id']}_{lang}_ep{ep}_*.npz"))
    if hit:
        z = np.load(hit[0])
        return hit[0].stem.split("_", 3)[3], float(z["duration"]), z["fp"]
    season = next(s for s in entry["seasons"] if s["lang"] == lang)
    streams = resolve_episodes_multi(
        entry["slug"], season["season_dir"], lang, ep, ep, mal_id=entry["mal_id"],
        va_slug=season.get("va_slug") or entry.get("va_slug") or entry["slug"],
        frembed=season.get("frembed")).get(ep, [])
    streams.sort(key=lambda s: HOST_PREF.index(s["host"]) if s["host"] in HOST_PREF else 99)
    for s in streams:
        try:
            dur = probe_duration(s["url"], s.get("referer"))
            pcm, t0 = decode_audio_abs(s["url"], 0.0, dur, sample_rate=SAMPLE_RATE,
                                       referer=s.get("referer"))
            if abs(t0) > 0.5:
                pcm = np.concatenate([np.zeros(int(t0 * SAMPLE_RATE), np.float32), pcm]) if t0 > 0 \
                    else pcm[int(-t0 * SAMPLE_RATE):]
            fp = fingerprint(pcm)
        except Exception as exc:
            print(f"  {s['host']}: echec {type(exc).__name__}: {str(exc)[:120]}")
            continue
        cache.mkdir(parents=True, exist_ok=True)
        np.savez(cache / f"{entry['mal_id']}_{lang}_ep{ep}_{s['host']}.npz", fp=fp, duration=dur)
        return s["host"], dur, fp
    raise RuntimeError("aucun lecteur exploitable")


def ref_fp(ref) -> tuple[float, np.ndarray]:
    cache = Path("cache/refs/fp") / f"{ref.key}.npz"
    if cache.exists():
        z = np.load(cache)
        return float(z["duration"]), z["fp"]
    path = download(ref.audio_link, "audio")
    dur = media_duration(path)
    fp = fingerprint(decode_file(path))
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez(cache, fp=fp, duration=dur)
    return dur, fp


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:04.1f}"


def plate(path: Path, title: str, rows: list[tuple[str, np.ndarray]]) -> None:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return
    W, H, L = 1100, 70, 330
    img = Image.new("RGB", (W, 24 + H * len(rows)), "white")
    d = ImageDraw.Draw(img)
    d.text((6, 6), title, fill="black")
    for r, (label, curve) in enumerate(rows):
        y0 = 24 + r * H
        d.text((6, y0 + 4), label[:52], fill="black")
        n = len(curve)
        sx = (W - L - 10) / max(n, 1)
        thr = y0 + H - 8 - MATCH_BITS / 32 * (H - 12)
        d.line([(L, thr), (W - 10, thr)], fill=(200, 200, 255))
        for i, b in enumerate(curve):
            x = L + i * sx
            y = y0 + H - 8 - b / 32 * (H - 12)
            d.line([(x, y0 + H - 8), (x, y)], fill=(40, 150, 60) if b <= MATCH_BITS else (210, 60, 60))
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", help="mal:ep,mal:ep")
    ap.add_argument("--lang", default="vostfr")
    a = ap.parse_args(argv)
    cases = [tuple(map(int, c.split(":"))) for c in a.cases.split(",")] if a.cases else CASES
    anime = {e["mal_id"]: e for e in json.load(open(ANIME_LIST, encoding="utf-8"))}
    OUT.mkdir(parents=True, exist_ok=True)
    out = open(OUT / "results.jsonl", "a", encoding="utf-8")
    for mal, ep in cases:
        entry = anime[mal]
        print(f"\n== {entry['title']} ep{ep} ({a.lang})")
        try:
            host, dur, efp = episode_fp(entry, ep, a.lang)
        except Exception as exc:
            print(f"  EPISODE INDISPONIBLE : {exc}")
            continue
        rows = []
        for ref in fetch_themes(mal):
            rdur, rfp = ref_fp(ref)
            for o in occurrences(rfp, efp):
                rec = {"mal": mal, "ep": ep, "lang": a.lang, "host": host, "ep_dur": round(dur, 2),
                       "ref": ref.key, "kind": ref.kind, "ref_dur": round(rdur, 2), **o.as_dict()}
                out.write(json.dumps(rec) + "\n")
                print(f"  {ref.key:<34} {mmss(rec['matched_start_s']):>7}-{mmss(rec['matched_end_s']):<7}"
                      f" cov={o.coverage:.2f} gap={o.longest_gap_s:4.1f}s n_gaps={o.n_gaps}"
                      f" head={o.head_miss_s:4.1f} tail={o.tail_miss_s:4.1f} med={o.median_bits:4.1f}"
                      f" drift={o.drift_frames}")
                rows.append((f"{ref.key} @{mmss(o.start_s)} cov={o.coverage:.2f}", o.curve))
        out.flush()
        plate(OUT / f"{mal}_ep{ep}_{a.lang}.png", f"{entry['title']} ep{ep} {a.lang} [{host}] {mmss(dur)}", rows)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
