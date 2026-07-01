"""End-to-end series runner — the full cascade.

  resolve (multi-host) → audio (cached) → fingerprint → SeriesBank (level 1)
  → classify (level 2, DSP nature/position/duration) → fallback (level 3, only
  where level 1 found nothing) → JSON output + OP/ED block map.

Usage:
  python run_series.py --slug shingeki-no-kyojin --season saison1 --lang vostfr \
      --start 1 --end 12 --host embed4me,sibnet --mal 16498 --out out/snk.json

Validation is by convergence (internal consistency + DSP energy probes), with
AniSkip shown as an INDICATIVE community reference (the streamed cut differs).
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.adapter_aniscroll import resolve_episodes
from oped.audio import load_audio
from oped.fingerprint import fingerprint
from oped.matcher import SeriesBank
from oped.classify import classify_episode
from oped import fallback as fb

SR = 11025


def clock(iv) -> str:
    if not iv:
        return "—"
    a, b = iv
    return f"{int(a)//60}:{int(a)%60:02d}-{int(b)//60}:{int(b)%60:02d}"


def aniskip(mal_id: int, ep: int) -> dict:
    """Indicative community reference (NOT ground truth — cut differs)."""
    if not mal_id:
        return {}
    url = (f"https://api.aniskip.com/v2/skip-times/{mal_id}/{ep}"
           "?types=op&types=ed&episodeLength=0")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "oped-detector"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.load(r)
    except Exception:
        return {}
    out = {}
    for res in data.get("results", []):
        iv = res["interval"]
        out[res["skipType"]] = (iv["startTime"], iv["endTime"])
    return out


def fetch_and_fingerprint(eps, slug, season, lang, workers):
    """Parallel fetch (whole episode, cached by host+identity) + fingerprint."""
    def one(e):
        host = e.get("host")
        key = (f"{slug}/{season}/{lang}/{host}/ep{e['ep']}" if host
               else f"{slug}/{season}/{lang}/ep{e['ep']}")  # hostless legacy key
        s = load_audio(e["url"], cache_key=key, referer=e.get("referer"))
        return e["ep"], fingerprint(s), len(s) / SR, s

    out = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for ep, fp, dur, samples in pool.map(one, eps):
            out[ep] = (fp, dur, samples)
            print(f"  ep{ep}: {dur/60:.1f} min, {len(fp.hashes):,} hashes")
    return out


def detect(eps, data):
    """Run the cascade per episode. Returns {ep: {op, ed}} of Detection|None."""
    fps = [data[e["ep"]][0] for e in eps]
    bank = SeriesBank(fps)
    bank.build()

    results = {}
    for i, e in enumerate(eps):
        ep = e["ep"]
        _, dur, samples = data[ep]
        cands = bank.candidates(i)
        det = classify_episode(cands, dur, samples)

        # Level 3 — fallback. The bank (frame-exact repetition) is ALWAYS
        # preferred when it yields a full-length OP/ED; the DSP fallback is less
        # precise and must never overwrite a good bank result. It runs only
        # when the bank gave NOTHING or a fragment too short to be a real OP/ED
        # (< MIN_FULL ~70s; e.g. SnK ep3 ED came back as a 31s sliver). Even
        # then, for the ED the fallback only replaces a missing/short bank
        # result; for the OP we keep the bank's (a fallback OP can grab a longer
        # pre-OP insert and would be worse).
        MIN_FULL = 70.0
        if det["op"] is None:
            op = fb.detect_op(samples, dur)
            if op:
                det["op"] = op
        if det["ed"] is None or (det["ed"].end - det["ed"].start) < MIN_FULL:
            ed = fb.detect_ed(samples, dur)
            if ed and (det["ed"] is None
                       or (ed.end - ed.start) > (det["ed"].end - det["ed"].start)):
                det["ed"] = ed
        results[ep] = det
    return results, bank


def build_block_map(eps, results, bank):
    """Group episodes that share the SAME OP recording into blocks.

    Position is unreliable for grouping (a recap of different length shifts the
    OP's absolute start between episodes even when the OP is identical). Instead
    we use the BANK: two episodes belong to the same OP block if their OP
    segments corroborate each other (the matcher found the same repeated
    recording). A block boundary = where that shared-OP cluster changes, i.e.
    the opening sequence actually changed.
    """
    ep_index = {e["ep"]: i for i, e in enumerate(eps)}
    # For each episode, the set of episodes its OP segment corroborates.
    op_partners = {}
    for e in eps:
        i = ep_index[e["ep"]]
        op = results[e["ep"]]["op"]
        partners = set()
        if op is not None:
            # Find the bank segment matching this OP (overlapping start) and
            # read its corroborating episodes.
            for seg in bank.segments[i]:
                if abs(seg.start - op.start) < 15 or (seg.start <= op.start <= seg.end):
                    partners = {eps[j]["ep"] for j in seg.corroborating} | {e["ep"]}
                    break
        op_partners[e["ep"]] = partners

    # Union-find over the "share the same OP" relation.
    blocks = []
    assigned = set()
    for e in eps:
        ep = e["ep"]
        if ep in assigned:
            continue
        # Grow a block from ep via transitive corroboration.
        group, frontier = set(), [ep]
        while frontier:
            x = frontier.pop()
            if x in group:
                continue
            group.add(x)
            for y in op_partners.get(x, ()):
                if y not in group:
                    frontier.append(y)
        assigned |= group
        members = sorted(group)
        ref = next((round(results[m]["op"].start) for m in members
                    if results[m]["op"]), None)
        blocks.append({"eps": members, "ref": ref})
    blocks.sort(key=lambda b: b["eps"][0])
    return blocks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", required=True)
    ap.add_argument("--season", default="saison1")
    ap.add_argument("--lang", default="vostfr")
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--end", type=int, default=12)
    ap.add_argument("--host", default=None, help="host priority, e.g. 'sibnet,embed4me'")
    ap.add_argument("--mal", type=int, default=0, help="MAL id for indicative AniSkip")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    print(f"Resolving {args.slug} {args.season}/{args.lang} ep{args.start}-{args.end}…")
    eps = resolve_episodes(args.slug, args.season, args.lang,
                           args.start, args.end, host_pref=args.host)
    eps.sort(key=lambda e: e["ep"])
    print(f"  resolved {len(eps)} eps (host={eps[0].get('host') if eps else '?'})")

    print("Fetching audio + fingerprinting (parallel, cached)…")
    data = fetch_and_fingerprint(eps, args.slug, args.season, args.lang, args.workers)

    print("\nDetecting (bank → classify → fallback)…\n")
    results, bank = detect(eps, data)

    # ── Console report ──
    hdr = f"{'ep':>3}  {'method':>11}  {'OP':>13}  {'ED':>13}  {'AniSkip OP*':>13}  {'AniSkip ED*':>13}"
    print(hdr)
    print("-" * len(hdr))
    out_json = {"series": args.slug, "season": args.season, "lang": args.lang,
                "episodes": {}}
    for e in eps:
        ep = e["ep"]
        det = results[ep]
        op, ed = det["op"], det["ed"]
        method = "/".join(sorted({d.method for d in (op, ed) if d})) or "none"
        ak = aniskip(args.mal, ep)
        print(f"{ep:>3}  {method:>11}  "
              f"{clock(op.as_tuple() if op else None):>13}  "
              f"{clock(ed.as_tuple() if ed else None):>13}  "
              f"{clock(ak.get('op')):>13}  {clock(ak.get('ed')):>13}")
        out_json["episodes"][ep] = {
            "op_start": round(op.start, 2) if op else None,
            "op_end": round(op.end, 2) if op else None,
            "ed_start": round(ed.start, 2) if ed else None,
            "ed_end": round(ed.end, 2) if ed else None,
            "op_confidence": op.confidence if op else None,
            "ed_confidence": ed.confidence if ed else None,
            "method": method,
        }

    # ── Block map ──
    blocks = build_block_map(eps, results, bank)
    print("\nOP block map (consecutive eps sharing OP position):")
    for k, b in enumerate(blocks, 1):
        rng = f"{b['eps'][0]}–{b['eps'][-1]}" if len(b['eps']) > 1 else str(b['eps'][0])
        print(f"  OP_{k}: ep {rng}  (start ~{b['ref']}s)" if b['ref'] is not None
              else f"  (no OP): ep {rng}")
    out_json["op_blocks"] = [
        {"block": k, "episodes": b["eps"], "op_start_ref": b["ref"]}
        for k, b in enumerate(blocks, 1)
    ]

    print("\n* AniSkip = indicative community reference; the streamed cut differs,"
          " so exact-second match is not expected.")

    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(out_json, indent=2), "utf-8")
        print(f"\nJSON written to {args.out}")


if __name__ == "__main__":
    main()
