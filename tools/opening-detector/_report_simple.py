"""Per-episode / per-host OP+ED start & end times only — no method, no detail,
no consensus block. One row per player, which is the timing a player needs."""
import json, sys
sys.stdout.reconfigure(encoding="utf-8")

NAMES = {42310: "cyberpunk-edgerunners", 35120: "devilman-crybaby"}

def clock(s):
    if s is None:
        return "--"
    s = float(s)
    return f"{int(s // 60)}:{s % 60:04.1f}"

def span(b):
    if not b:
        return f"{'--':^15}"
    return f"{clock(b.get('start'))} - {clock(b.get('end'))}".center(15)

path = sys.argv[1] if len(sys.argv) > 1 else "cache/cp-results.jsonl"
rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
rows.sort(key=lambda r: (r["mal_id"], r["episode"], r["lang"]))

for mal in sorted({r["mal_id"] for r in rows}):
    print(f"\n{'='*62}\n  {NAMES.get(mal, mal)} (mal {mal})\n{'='*62}")
    hdr = f"{'ep':>2} {'lang':<6} {'lecteur':<11} | {'OP':^15} | {'ED':^15}"
    print(hdr)
    print("-" * len(hdr))
    prev = None
    for r in [x for x in rows if x["mal_id"] == mal]:
        ep, lang = r["episode"], r["lang"]
        ph = r.get("per_host") or {}
        if (ep, lang) != prev and prev is not None:
            print()
        prev = (ep, lang)
        for host in sorted(ph):
            d = ph[host]
            print(f"{ep:>2} {lang:<6} {host:<11} | {span(d.get('op'))} | {span(d.get('ed'))}")
