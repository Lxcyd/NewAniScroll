"""Render test2-results.jsonl as a per-host table (VO+VF) with detection method,
duration, landmark count and consensus — one row per player."""
import json, sys
sys.stdout.reconfigure(encoding="utf-8")

NAMES = {42310: "cyberpunk-edgerunners", 35120: "devilman-crybaby"}

def clock(s):
    if s is None:
        return "  --   "
    s = float(s)
    return f"{int(s // 60)}:{int(s % 60):02d}.{int((s % 1) * 10)}"

def cell(b):
    """timing span + method + landmark/consensus detail for one OP or ED block."""
    if not b:
        return f"{'--':^13} {'--':<8} {'':<12}"
    span = f"{clock(b.get('start'))}-{clock(b.get('end'))}"
    src = b.get("source", "--")
    if src in ("credited", "video"):
        det = f"{b.get('n_landmarks','-')} lm / {b.get('consensus_frac','-')}"
    elif src == "audio":
        det = f"{b.get('votes','-')} votes"
    else:
        det = ""
    return f"{span:^13} {src:<8} {det:<12}"

rows = [json.loads(l) for l in open("cache/test3-results.jsonl", encoding="utf-8") if l.strip()]
rows.sort(key=lambda r: (r["mal_id"], r["episode"], r["lang"]))

for mal in sorted({r["mal_id"] for r in rows}):
    print(f"\n{'='*104}\n  {NAMES.get(mal, mal)} (mal {mal})\n{'='*104}")
    hdr = (f"{'ep':>2} {'lang':<6} {'lecteur':<11} {'durée':>7} | "
           f"{'OP (start-end)':^13} {'méth':<8} {'détail':<12} | "
           f"{'ED (start-end)':^13} {'méth':<8} {'détail':<12}")
    print(hdr)
    print("-" * len(hdr))
    prev = None
    for r in [x for x in rows if x["mal_id"] == mal]:
        ep, lang = r["episode"], r["lang"]
        ph = r.get("per_host") or {}
        if (ep, lang) != prev and prev is not None:
            print()  # blank line between ep/lang groups
        prev = (ep, lang)
        for host in sorted(ph):
            d = ph[host]
            print(f"{ep:>2} {lang:<6} {host:<11} {d.get('duration',0):>7.1f} | "
                  f"{cell(d.get('op'))} | {cell(d.get('ed'))}")

    print(f"\n  -- consensus (contrôle de confiance cross-lecteur, PAS le timing livré) --")
    ch = (f"  {'ep':>2} {'lang':<6} | {'OP':^7} {'spread':>6} {'serve':>5} | "
          f"{'ED':^7} {'spread':>6} {'serve':>5}")
    print(ch)
    print("  " + "-" * (len(ch) - 2))
    for r in [x for x in rows if x["mal_id"] == mal]:
        def cc(b):
            if not b:
                return f"{'--':^7} {'--':>6} {'--':>5}"
            return f"{clock(b.get('start')):^7} {b.get('spread',0):>6.1f} {str(b.get('serve')):>5}"
        print(f"  {r['episode']:>2} {r['lang']:<6} | {cc(r.get('op'))} | {cc(r.get('ed'))}")
