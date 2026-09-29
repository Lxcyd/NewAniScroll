"""P1b — le controle image separe-t-il « meme chanson, memes images » de
« meme chanson, autres images » ?

Reprend les apparitions audio quasi completes de out/p1/results.jsonl
(couverture >= 0.9), extrait les images de l'episode sur la duree de la
reference, et les compare a la video AnimeThemes au meme temps relatif.

    python -m spike.p1b
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from fetch.adapter_aniscroll import resolve_episodes_multi
from match.image import MATCH_NCC, compare, episode_frames, ref_frames
from refs.animethemes import download, fetch_themes
from spike.p1 import ANIME_LIST, OUT, mmss

MIN_COV = 0.9
BLOCK_S = 5.0


def stream_for(entry: dict, ep: int, lang: str, host: str) -> dict:
    season = next(s for s in entry["seasons"] if s["lang"] == lang)
    streams = resolve_episodes_multi(
        entry["slug"], season["season_dir"], lang, ep, ep, hosts=[host], mal_id=entry["mal_id"],
        va_slug=season.get("va_slug") or entry.get("va_slug") or entry["slug"],
        frembed=season.get("frembed")).get(ep, [])
    return next(s for s in streams if s["host"] == host)


def profile(sim: np.ndarray, times: np.ndarray, t0: float) -> str:
    """Un caractere par bloc de BLOCK_S : # concorde, . ne concorde pas, ? sans reference."""
    out = []
    rel = times - t0
    for a in np.arange(0, rel.max() + 1e-6, BLOCK_S):
        m = (rel >= a) & (rel < a + BLOCK_S)
        v = sim[m]
        v = v[~np.isnan(v)]
        out.append("?" if len(v) == 0 else "#" if (v >= MATCH_NCC).mean() >= 0.5 else ".")
    return "".join(out)


def main(argv: list[str]) -> int:
    anime = {e["mal_id"]: e for e in json.load(open(ANIME_LIST, encoding="utf-8"))}
    recs = [json.loads(l) for l in open(OUT / "results.jsonl", encoding="utf-8")]
    seen, todo = set(), []
    for r in recs:
        k = (r["mal"], r["ep"], r["lang"], r["ref"], round(r["start_s"]))
        if r["coverage"] >= MIN_COV and k not in seen:
            seen.add(k)
            todo.append(r)
    out = open(OUT / "image.jsonl", "w", encoding="utf-8")
    for r in todo:
        entry = anime[r["mal"]]
        ref = next(x for x in fetch_themes(r["mal"]) if x.key == r["ref"])
        try:
            s = stream_for(entry, r["ep"], r["lang"], r["host"])
            t0 = r["start_s"]
            ef, et = episode_frames(s["url"], t0, r["ref_dur"], referer=s.get("referer"))
            refs = [ref_frames(download(v.link, "video")) for v in ref.videos]
        except Exception as exc:
            print(f"{r['mal']} ep{r['ep']} {r['ref']}: ECHEC {type(exc).__name__}: {str(exc)[:150]}")
            continue
        sim = compare(ef, et, t0, refs)
        valid = sim[~np.isnan(sim)]
        frac = float((valid >= MATCH_NCC).mean()) if len(valid) else 0.0
        prof = profile(sim, et, t0)
        rec = {**{k: r[k] for k in ("mal", "ep", "lang", "host", "ref", "kind", "start_s", "coverage")},
               "img_frac": round(frac, 3), "img_median": round(float(np.median(valid)), 3) if len(valid) else None,
               "n_frames": int(len(et)), "profile": prof,
               "videos": [f"{v.basename} nc={v.nc} ov={v.overlap}" for v in ref.videos]}
        out.write(json.dumps(rec) + "\n")
        out.flush()
        print(f"{entry['title'][:22]:<22} ep{r['ep']:<3} {r['ref']:<30} @{mmss(t0):>7} "
              f"img={frac:.2f} med={rec['img_median']}  {prof}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
