"""Audit a multi-host batch JSONL: surface what looks WRONG, not what worked.

Written for a broad sweep across many anime, where the useful output is a short
list of suspicious cells rather than 45 episodes of correct timings. Every check
below is a symptom that has actually bitten at least once:

  coverage   — a kind missing entirely (no theme, no match, host resolved nothing)
  held       — stored but not servable (validate.py blocking anomaly)
  span       — an OP/ED whose length is implausible for a TV theme (~90s)
  spread     — hosts disagreeing beyond the reconciler's tolerance
  outlier    — ONE host far from its own consensus (the erased/vidmoly-va case)
  drift      — the OP start jumping around inside a single season

Usage: python _report_audit.py out/audit.jsonl
"""

from __future__ import annotations

import json
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
from collections import defaultdict

SPAN_MIN, SPAN_MAX = 60.0, 120.0   # a TV OP/ED is ~90s
SPREAD_MAX = 4.0                   # reconciler tolerance
OUTLIER_MAX = 4.0                  # one host vs consensus, in from-end terms
DRIFT_MAX = 15.0                   # OP start jitter inside one season


def ms(s: float | None) -> str:
    if s is None:
        return "-"
    return f"{int(s) // 60}:{int(s) % 60:02d}"


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "out/audit.jsonl"
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    if not rows:
        raise SystemExit(f"{path} is empty")

    findings: list[tuple[str, str]] = []
    by_anime: dict[tuple, list] = defaultdict(list)
    n_cells = 0

    for r in rows:
        key = (r["mal_id"], r["lang"])
        by_anime[key].append(r)
        tag = f"mal{r['mal_id']} {r['lang']} ep{r['episode']}"
        per_host = r.get("per_host") or {}

        for kind in ("op", "ed"):
            h = r.get(kind)
            n_cells += 1
            if h is None:
                findings.append(("coverage", f"{tag} {kind}: aucun hit"))
                continue

            span = h["end"] - h["start"]
            if not (SPAN_MIN <= span <= SPAN_MAX):
                findings.append(
                    ("span", f"{tag} {kind}: duree {span:.0f}s "
                             f"({ms(h['start'])}-{ms(h['end'])})"))

            if h.get("serve") is False:
                findings.append(
                    ("held", f"{tag} {kind}: non servi — {h.get('held_reason')}"))
            elif h.get("anomalies"):
                findings.append(
                    ("anomaly", f"{tag} {kind}: {','.join(h['anomalies'])}"))

            spread = h.get("spread")
            if spread is not None and spread > SPREAD_MAX:
                findings.append(
                    ("spread", f"{tag} {kind}: spread {spread:.1f}s "
                               f"({h.get('hosts_agree')}/{h.get('hosts_total')} d'accord)"))

            # Per-host outlier. ED is compared on seconds-from-end (duration
            # independent); OP on the absolute start.
            ref = h.get("from_end_start") if kind == "ed" else h.get("start")
            if ref is not None:
                for host, hd in per_host.items():
                    hh = hd.get(kind)
                    if not hh:
                        findings.append(("coverage", f"{tag} {kind}: {host} sans hit"))
                        continue
                    val = hh.get("from_end_start") if kind == "ed" else hh.get("start")
                    if val is None:
                        continue
                    if abs(val - ref) > OUTLIER_MAX:
                        findings.append(
                            ("outlier", f"{tag} {kind}: {host} a {val:.0f}s "
                                        f"vs consensus {ref:.0f}s "
                                        f"(ecart {val - ref:+.0f}s, {hh.get('votes')} votes)"))

    # Intra-season drift, measured on the OP's LENGTH, not its start. The start
    # legitimately moves episode to episode with the cold-open (erased: 0:43,
    # 1:07, 1:05 — all correct), so flagging it produced pure noise. The same
    # opening always runs the same LENGTH, though, so a span that wanders across
    # a season means the matcher clipped it somewhere.
    for (mal, lang), rs in sorted(by_anime.items()):
        spans = [(r["episode"], r["op"]["end"] - r["op"]["start"])
                 for r in rs if r.get("op")]
        if len(spans) >= 2 and max(s for _, s in spans) - min(s for _, s in spans) > DRIFT_MAX:
            detail = ", ".join(f"ep{e}={s:.0f}s" for e, s in spans)
            findings.append(("drift", f"mal{mal} {lang} op (duree): {detail}"))

    order = ["coverage", "held", "span", "outlier", "spread", "anomaly", "drift"]
    grouped: dict[str, list[str]] = defaultdict(list)
    for cat, msg in findings:
        grouped[cat].append(msg)

    print(f"{len(rows)} episodes, {n_cells} cellules (op+ed), "
          f"{len(findings)} signalements\n")
    for cat in order:
        if not grouped[cat]:
            continue
        print(f"-- {cat.upper()} ({len(grouped[cat])})")
        for m in grouped[cat]:
            print(f"   {m}")
        print()
    if not findings:
        print("rien a signaler")


if __name__ == "__main__":
    main()
