"""Audit a multi-host batch JSONL: surface what looks WRONG, not what worked.

Written for a broad sweep across many anime, where the useful output is a short
list of suspicious cells rather than 45 episodes of correct timings. Every check
below is a symptom that has actually bitten at least once:

  coverage   — a kind missing entirely (no theme, no match, host resolved nothing)
  held       — stored but not servable (validate.py blocking anomaly)
  span       — an OP/ED whose length is implausible for a TV theme (~90s)
  spread     — hosts disagreeing beyond the reconciler's tolerance
  split      — hosts forming no single cluster (`hosts_agree` is then the
               largest group, NOT a consensus — read it with `spread`)
  content    — hosts serving a DIFFERENT episode (duration cohort mismatch)
  outlier    — ONE host far from its own consensus (the erased/vidmoly-va case)
  drift      — the OP start jumping around inside a single season

A `derived` hit held for "awaiting season confirmation" is NOT reported as a
problem: that is the designed state straight out of detection, and only
season_pass.py can promote it. Counting those as findings made a clean run look
broken (26 of 34 "held" cells in the first 15-anime audit were just that). They
are summarised separately at the end instead.

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
    n_pending = 0      # derived hits awaiting the season pass — expected
    n_served = 0

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

            if h.get("serve"):
                n_served += 1
            span = h["end"] - h["start"]
            if not (SPAN_MIN <= span <= SPAN_MAX):
                findings.append(
                    ("span", f"{tag} {kind}: duree {span:.0f}s "
                             f"({ms(h['start'])}-{ms(h['end'])})"))

            reason = h.get("held_reason") or ""
            if h.get("serve") is False:
                if "awaiting season confirmation" in reason:
                    n_pending += 1          # expected, not a finding
                else:
                    findings.append(("held", f"{tag} {kind}: non servi — {reason}"))
            elif h.get("anomalies"):
                findings.append(
                    ("anomaly", f"{tag} {kind}: {','.join(h['anomalies'])}"))

            if h.get("hosts_wrong_duration"):
                findings.append(
                    ("content", f"{tag} {kind}: {h['hosts_wrong_duration']} host(s) "
                                f"sur un autre episode (duree hors cohorte)"))

            spread = h.get("spread")
            if h.get("hosts_split"):
                # Not a spread problem: the hosts formed separate groups, so
                # `hosts_agree` counts the largest one and is not a consensus.
                findings.append(
                    ("split", f"{tag} {kind}: groupes disjoints, plus grand "
                              f"{h.get('hosts_agree')}/{h.get('hosts_total')}, "
                              f"spread {spread:.1f}s"))
            elif spread is not None and spread > SPREAD_MAX:
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

    order = ["coverage", "held", "span", "content", "split", "outlier", "spread",
             "anomaly", "drift"]
    grouped: dict[str, list[str]] = defaultdict(list)
    for cat, msg in findings:
        grouped[cat].append(msg)

    print(f"{len(rows)} episodes, {n_cells} cellules (op+ed) : "
          f"{n_served} servies, {n_pending} en attente de season_pass, "
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
