"""Is the premiere/finale failure a DETECTOR defect or the works themselves?

The lot showed ~50% of premieres and finales with no OP/ED against ~34% for
middle episodes. Two rival explanations:

  A. REAL — a premiere often has no OP (cold open, OP held to the end) and a
     finale often has no ED (credits over the last scene). Nothing to fix.
  B. DEFECT — the OP lives outside the searched window on a longer-than-usual
     premiere, or the ED anchor from the end misses on a finale.

The discriminator used here: compare ONLY within panels whose middle episodes
succeeded. If eps 2 and 3 both found an OP from the same hosts and ep 1 did
not, the reference exists and the hosts work — so the miss is about the
episode, and its DURATION says which explanation fits.
"""
from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent.parent
rows = [json.loads(l) for l in open(HERE / "out/hard.jsonl", encoding="utf-8") if l.strip()]
lst = json.loads((HERE / "datasets/anime.hard.json").read_text("utf-8"))
name = {a["mal_id"]: a["slug"] for a in lst}
eps_of = {(a["mal_id"], s["lang"]): (s.get("episodes") or [])
          for a in lst for s in a["seasons"]}

by_panel = defaultdict(dict)
for r in rows:
    by_panel[(r["mal_id"], r["lang"])][r["episode"]] = r


def dur(r):
    ds = [v["duration"] for v in (r.get("per_host") or {}).values()
          if isinstance(v, dict) and v.get("duration")]
    return statistics.median(ds) if ds else None


print("=== PANNEAUX OU LE MILIEU MARCHE MAIS PAS LA BORNE ===\n")
cases = {"premiere_op": [], "finale_ed": [], "premiere_ed": [], "finale_op": []}
for (mal, lang), eps in eps_of.items():
    if len(eps) < 4:
        continue
    got = by_panel.get((mal, lang), {})
    first, last = eps[0], eps[-1]
    mids = eps[1:-1]
    if not all(e in got for e in eps):
        continue
    for kind in ("op", "ed"):
        mid_ok = all(got[e].get(kind) for e in mids)
        if not mid_ok:
            continue
        if not got[first].get(kind):
            cases[f"premiere_{kind}"].append((mal, lang, first, mids, got))
        if not got[last].get(kind):
            cases[f"finale_{kind}"].append((mal, lang, last, mids, got))

for label, items in cases.items():
    print(f"--- {label} : {len(items)} panneaux ---")
    longer = 0
    for mal, lang, ep, mids, got in items[:100]:
        d = dur(got[ep])
        dm = [dur(got[e]) for e in mids if dur(got[e])]
        if d and dm:
            ratio = d / statistics.median(dm)
            if ratio > 1.15 or ratio < 0.85:
                longer += 1
    for mal, lang, ep, mids, got in items[:8]:
        d = dur(got[ep])
        dm = [dur(got[e]) for e in mids if dur(got[e])]
        med = statistics.median(dm) if dm else None
        ratio = f"{d/med:.2f}x" if (d and med) else "?"
        print(f"    mal {mal:<8} {name.get(mal,''):<26} {lang:<6} ep{ep:<4} "
              f"duree={d and round(d)}s vs milieu {med and round(med)}s ({ratio})")
    if items:
        print(f"    -> duree anormale (>15% d'ecart) : {longer}/{len(items)}\n")
    else:
        print()
