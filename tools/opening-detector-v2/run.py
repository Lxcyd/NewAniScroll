"""Lot v2 : liste d'animes -> JSONL par episode, par lecteur.

    python run.py --anime-list ../opening-detector/datasets/anime.gt10.json --out out/gt10.jsonl

Reprend la ou il s'est arrete (episodes deja ecrits sautes). Le format
per_host est celui de scripts/oped/import-oped-host-skips.mjs ; en plus,
chaque lecteur porte ses `candidates` (tout ce qui a ete vu, retenu ou non,
avec la raison) pour le diagnostic.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

import decide
from fetch.episode import fingerprint_stream, resolve
from match.ber import occurrences
from match.edges import extend_start, refine_end
from match.image import FPS, MATCH_NCC, compare, episode_frames, ref_frames
from refs.animethemes import download
from refs.bank import load

ALGO_VERSION = 100  # v2 ; la v1 est en 1-2
_write = threading.Lock()
RETRY_DELAY_S = 15


def image_score(stream: dict, cand: decide.Candidate, videos):
    """(part des images concordantes, sim, temps, images de reference)."""
    ef, et = episode_frames(stream["url"], cand.start, cand.ref_dur, referer=stream.get("referer"))
    refs = [ref_frames(download(v.link, "video")) for v in videos]
    sim = compare(ef, et, cand.start, refs)
    valid = sim[~np.isnan(sim)]
    frac = float((valid >= MATCH_NCC).mean()) if len(valid) else 0.0
    return frac, sim, et, refs


def edges(stream: dict, c: decide.Candidate, sim, et, refs, ep_dur: float) -> tuple[float, float]:
    """Bords a l'image pres (match/edges.py). En cas d'echec, les bords audio."""
    file_end = min(c.start + c.ref_dur, ep_dur)
    ok = np.nan_to_num(sim, nan=0.0) >= MATCH_NCC
    last = np.flatnonzero(ok)
    coarse = min(float(et[last[-1]]) + 1.0 / FPS, file_end) if len(last) else file_end
    ref = stream.get("referer")
    try:
        end = refine_end(stream["url"], c.start, coarse, refs, referer=ref) or coarse
        start = extend_start(stream["url"], c.start, refs, referer=ref)
    except Exception:
        return c.start, file_end
    return max(0.0, start), min(end, file_end)


def detect_host(mal: int, lang: str, ep: int, stream: dict, refs) -> dict:
    dur, efp = fingerprint_stream(mal, lang, ep, stream)
    cands: list[decide.Candidate] = []
    for r in refs:
        for o in occurrences(r.fp, efp):
            if o.coverage >= decide.REPORT_COVERAGE:
                cands.append(decide.Candidate(r.theme.key, r.theme.kind, r.duration, o))
    served = []
    for c in cands:
        if not c.audio_ok():
            continue
        videos = next(r.theme.videos for r in refs if r.theme.key == c.ref)
        try:
            c.img, c.sim, c.times, c.refimgs = image_score(stream, c, videos)
        except Exception as exc:
            c.reasons.append(f"image_indisponible: {str(exc)[:80]}")
            continue
        if c.img < decide.MIN_IMAGE:
            c.reasons.append("image")
            continue
        served.append(c)
    slots, notes = decide.pick(served, dur)
    entry = {"duration": round(dur, 3), "algo_version": ALGO_VERSION,
             "candidates": [c.as_dict(dur) for c in cands], "notes": notes}
    for slot, c in slots.items():
        start, end = edges(stream, c, c.sim, c.times, c.refimgs, dur)
        hit = {"start": round(start, 2), "end": round(end, 2), "votes": None,
               "audio_start": round(c.start, 2), "file_end": round(c.end(dur), 2),
               "source": "v2-audio+image", "confirmed_by_video": True, "serve": True,
               "ref": c.ref, "kind": c.kind, "coverage": round(c.occ.coverage, 3), "img": round(c.img, 3)}
        if slot == "ed":
            hit["from_end_start"] = round(dur - hit["start"], 2)
            hit["from_end_end"] = round(dur - hit["end"], 2)
        entry[slot] = hit
    return entry


def detect_episode(entry: dict, season: dict, ep: int) -> dict:
    mal, lang = entry["mal_id"], season["lang"]
    refs = load(mal)
    rec = {"mal_id": mal, "episode": ep, "lang": lang, "n_refs": len(refs), "per_host": {}}
    if not refs:
        rec["error"] = "aucune_reference"
        return rec
    for stream in resolve(entry, season, ep):
        host = stream["host"]
        try:
            rec["per_host"][host] = detect_host(mal, lang, ep, stream, refs)
        except Exception as exc:
            rec["per_host"][host] = {"detect_error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    # Second essai des lecteurs en panne, URL fraiches : sur gt10, les echecs
    # etaient transitoires (ffprobe megaplay > 30 s, 502 ansembed). Une panne
    # n'est JAMAIS une absence de generique : elle reste marquee detect_error.
    failed = [h for h, e in rec["per_host"].items() if "detect_error" in e]
    if failed:
        time.sleep(RETRY_DELAY_S)
        for stream in resolve(entry, season, ep, hosts=failed, fresh=True):
            try:
                rec["per_host"][stream["host"]] = detect_host(mal, lang, ep, stream, refs) | {"retried": True}
            except Exception as exc:
                rec["per_host"][stream["host"]]["detect_error_retry"] = f"{type(exc).__name__}: {str(exc)[:200]}"
    return rec


def summary(rec: dict) -> str:
    parts = []
    for h, e in rec["per_host"].items():
        if "detect_error" in e:
            parts.append(f"{h}:ERR")
            continue
        s = "".join(k.upper() if k in e else "-" for k in ("op", "ed"))
        parts.append(f"{h}:{s}")
    return " ".join(parts) or rec.get("error", "aucun lecteur")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--anime-list", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--lang", choices=["vostfr", "vf"])
    a = ap.parse_args(argv)

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():
        for line in out.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            done.add((r["mal_id"], r["episode"], r["lang"]))

    tasks = []
    for entry in json.load(open(a.anime_list, encoding="utf-8")):
        for season in entry["seasons"]:
            if a.lang and season["lang"] != a.lang:
                continue
            eps = season.get("episodes") or range(season["ep_start"], season["ep_end"] + 1)
            for ep in eps:
                if (entry["mal_id"], ep, season["lang"]) not in done:
                    tasks.append((entry, season, ep))
    print(f"{len(tasks)} episodes a traiter ({len(done)} deja faits)", flush=True)

    def work(t):
        entry, season, ep = t
        try:
            rec = detect_episode(entry, season, ep)
        except Exception:
            print(f"!! {entry['mal_id']} ep{ep} {season['lang']}\n{traceback.format_exc()}", flush=True)
            return
        with _write, open(out, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"{entry['title'][:26]:<26} ep{ep:<3} {season['lang']:<6} {summary(rec)}", flush=True)

    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        list(pool.map(work, tasks))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
