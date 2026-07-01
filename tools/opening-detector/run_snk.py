"""End-to-end SnK S1 ep1-5 run:
  resolve (anime-sama→Sibnet) → audio → fingerprint → cross-episode match →
  OP/ED candidates → compare vs AniSkip (MAL 16498).

This is a first real-data cut of Etape 2: each episode is matched against its
neighbours (N-2..N+2). Repeated segments >= MIN_SEG_S are OP/ED candidates,
disambiguated by position (OP early, ED late).

Run:  python run_snk.py
"""

from __future__ import annotations

import json
import sys
import urllib.request

import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.adapter_aniscroll import resolve_episodes
from oped.audio import load_audio
from oped.fingerprint import fingerprint
from oped.matcher import all_matches
from oped.refine import refine_left_edge

MAL_ID = 16498           # Shingeki no Kyojin S1
SLUG = "shingeki-no-kyojin"
SEASON = "saison1"
LANG = "vostfr"
EP_START, EP_END = 1, 2

MIN_SEG_S = 80.0         # OP/ED duration floor (spec)
NEIGHBOR_RADIUS = 2


def aniskip(ep: int) -> dict:
    """Ground-truth OP/ED intervals (seconds) for an episode, or {}."""
    url = (
        f"https://api.aniskip.com/v2/skip-times/{MAL_ID}/{ep}"
        "?types=op&types=ed&episodeLength=0"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "oped-detector"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)
    out = {}
    for res in data.get("results", []):
        iv = res["interval"]
        out[res["skipType"]] = (iv["startTime"], iv["endTime"])
    return out


def candidates_for(ep_idx: int, fps: list, durations: list[float]) -> list:
    """Match episode ep_idx against neighbours; return EVERY repeated segment
    (q_start, q_end, votes, partner_ep) >= MIN_SEG_S, in QUERY time.

    Uses all_matches (not best_match) so both the OP and the ED surface — they
    live in separate offset bins and a top-1 match would only ever return one.
    """
    out = []
    n = len(fps)
    for j in range(max(0, ep_idx - NEIGHBOR_RADIUS), min(n, ep_idx + NEIGHBOR_RADIUS + 1)):
        if j == ep_idx:
            continue
        for m in all_matches(fps[ep_idx], fps[j]):
            if m.duration >= MIN_SEG_S:
                out.append((m.q_start, m.q_end, m.n_votes, j + EP_START))
    return out


def classify(cands: list, duration: float, samples) -> dict:
    """Split candidates into OP (early) vs ED (late) by position, pick the
    strongest in each half, then refine the OP's left edge to trim a shared
    recap / cold-open glued ahead of the music."""
    res = {"op": None, "ed": None}
    early = [c for c in cands if c[1] <= duration * 0.5]   # ends in first half
    late = [c for c in cands if c[0] >= duration * 0.55]   # starts in last ~45%
    if early:
        b = max(early, key=lambda c: c[2])
        op_start = refine_left_edge(samples, b[0], b[1])
        res["op"] = (op_start, b[1])
    if late:
        b = max(late, key=lambda c: c[2])
        res["ed"] = (b[0], b[1])
    return res


def fmt(iv) -> str:
    return f"{iv[0]:7.1f}-{iv[1]:7.1f}" if iv else "      —       "


def clock(iv) -> str:
    """Format an (start, end) interval in seconds as m:ss-m:ss."""
    if not iv:
        return "—"
    def ms(s):
        return f"{int(s)//60}:{int(s)%60:02d}"
    return f"{ms(iv[0])}-{ms(iv[1])}"


def err_str(pred, truth) -> str:
    if not pred and not truth:
        return "n/a"
    if not pred:
        return "MISSED"
    if not truth:
        return "no-truth"
    ds = abs(pred[0] - truth[0])
    de = abs(pred[1] - truth[1])
    return f"Δstart {ds:5.1f}s  Δend {de:5.1f}s"


def main() -> None:
    print(f"Resolving SnK S1 ep{EP_START}-{EP_END} via anime-sama→Sibnet…")
    eps = resolve_episodes(SLUG, SEASON, LANG, EP_START, EP_END)
    eps.sort(key=lambda e: e["ep"])

    print("Fetching audio + fingerprinting (parallel, cached)…")

    def _one(e):
        key = f"{SLUG}/{SEASON}/{LANG}/ep{e['ep']}"
        samples = load_audio(e["url"], cache_key=key)
        dur = len(samples) / 11025
        fp = fingerprint(samples)
        return e["ep"], fp, dur, samples

    from concurrent.futures import ThreadPoolExecutor

    results = {}
    with ThreadPoolExecutor(max_workers=len(eps)) as pool:
        for ep_no, fp, dur, samples in pool.map(_one, eps):
            results[ep_no] = (fp, dur, samples)
            print(f"  ep{ep_no}: {dur/60:.1f} min, {len(fp.hashes):,} hashes")

    fps = [results[e["ep"]][0] for e in eps]
    durations = [results[e["ep"]][1] for e in eps]
    audio = [results[e["ep"]][2] for e in eps]

    print("\nDetected OP/ED (our anime-sama→Sibnet release), m:ss:\n")
    header = f"{'ep':>3}  {'OP':>15}  {'ED':>15}"
    print(header)
    print("-" * len(header))

    for i, e in enumerate(eps):
        cands = candidates_for(i, fps, durations)
        pred = classify(cands, durations[i], audio[i])
        print(f"{e['ep']:>3}  {clock(pred['op']):>15}  {clock(pred['ed']):>15}")


if __name__ == "__main__":
    main()
