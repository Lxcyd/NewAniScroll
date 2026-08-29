"""Render a batch results JSONL as a per-host table (VO+VF) with detection
method, duration, landmark count and consensus — one row per player.

Same format as _report_test.py; takes the results path as argv[1] so it can be
pointed at any run (default: cache/cp-results.jsonl)."""
import json, sys
sys.stdout.reconfigure(encoding="utf-8")

NAMES = {42310: "cyberpunk-edgerunners", 35120: "devilman-crybaby"}

def clock(s):
    if s is None:
        return "  --   "
    s = float(s)
    return f"{int(s // 60)}:{int(s % 60):02d}.{int((s % 1) * 10)}"

# L'accord entre lecteurs n'est PAS une preuve d'exactitude (meme reference, meme
# matcher, donc meme erreur reproduite). La preuve independante par episode, c'est
# l'IMAGE : `align_status` dit si elle a confirme (ok), REFUSE (rejected, une preuve
# CONTRE) ou n'a rien vu (absent). Sans cette colonne le tableau ne montre que des
# timings d'apparence egale.
ALIGN = {"ok": "img:ok", "rejected": "img:NON", "absent": "img:-", None: ""}

def cell(b):
    """timing span + method + landmark/consensus detail for one OP or ED block."""
    if not b:
        return f"{'--':^13} {'--':<8} {'':<12} {'':<8} {'':<7}"
    span = f"{clock(b.get('start'))}-{clock(b.get('end'))}"
    src = b.get("source", "--")
    if src in ("credited", "video"):
        det = f"{b.get('n_landmarks','-')} lm / {b.get('consensus_frac','-')}"
    elif src == "audio":
        det = f"{b.get('votes','-')} votes"
    else:
        det = ""
    align = ALIGN.get(b.get("align_status"), str(b.get("align_status") or ""))
    # `serve` n'est pose sur un bloc par-hote que quand quelque chose l'a retenu.
    gate = "TENU" if b.get("serve") is False else "servi"
    return f"{span:^13} {src:<8} {det:<12} {align:<8} {gate:<7}"

path = sys.argv[1] if len(sys.argv) > 1 else "cache/cp-results.jsonl"
rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
rows.sort(key=lambda r: (r["mal_id"], r["episode"], r["lang"]))

for mal in sorted({r["mal_id"] for r in rows}):
    print(f"\n{'='*104}\n  {NAMES.get(mal, mal)} (mal {mal})\n{'='*104}")
    hdr = (f"{'ep':>2} {'lang':<6} {'lecteur':<11} {'durée':>7} | "
           f"{'OP (start-end)':^13} {'méth':<8} {'détail':<12} {'image':<8} {'porte':<7} | "
           f"{'ED (start-end)':^13} {'méth':<8} {'détail':<12} {'image':<8} {'porte':<7}")
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
