"""Per-episode, per-HOST OP/ED timings — the sheet you check against the player.

`_report_audit.py` answers "what looks wrong?"; this answers "what exactly did
we produce, host by host, so I can verify it by eye?". Every timing is printed
in THAT host's own timeline, because that is the clock the player shows: hosts
serve differently trimmed encodes, so the consensus value is NOT what you would
scrub to on a given player.

Columns:
  dur          the host's episode duration (sanity: a wrong one means a wrong
               episode — see multi_host._duration_cohort)
  OP / ED      start-end in mm:ss, host-absolute
  from-end     ED distance to the end of the episode (the host-independent
               anchor; this is what should agree across hosts, NOT the absolute)
  votes        matcher confidence
  etat         servi / retenu (+ reason) — a retenu row is stored, not shipped

Usage:
  python _verify_report.py out/audit3.jsonl              # everything
  python _verify_report.py out/audit3.jsonl --mal 4224   # one anime
  python _verify_report.py out/audit3.jsonl --json report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# mal_id -> readable name, for the anime in anime.audit.json. Falls back to the
# raw id for anything else, so the tool stays usable on other batches.
NAMES = {
    2402: "ashita-no-joe", 31043: "erased", 20507: "noragami",
    37521: "vinland-saga", 4224: "toradora", 22199: "akame-ga-kill",
    28999: "charlotte", 10620: "mirai-nikki", 31478: "bungou-stray-dogs",
    37520: "dororo", 15809: "hataraku-maou-sama", 9989: "anohana",
    14813: "oregairu", 57334: "dandadan", 12189: "hyouka",
}


def ms(s: float | None) -> str:
    if s is None:
        return "—"
    s = round(s)
    sign = "-" if s < 0 else ""
    s = abs(s)
    return f"{sign}{s // 60}:{s % 60:02d}"


def state(h: dict | None) -> str:
    if h is None:
        return "absent"
    if h.get("serve"):
        return "servi"
    return f"retenu ({h.get('held_reason') or '?'})"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default="out/audit3.jsonl")
    ap.add_argument("--mal", type=int, default=None)
    ap.add_argument("--json", default=None, help="also dump a JSON summary")
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(args.path, encoding="utf-8") if l.strip()]
    by_anime: dict[tuple, list] = defaultdict(list)
    for r in rows:
        if args.mal and r["mal_id"] != args.mal:
            continue
        by_anime[(r["mal_id"], r["lang"])].append(r)

    out_json: list[dict] = []

    for (mal, lang), rs in sorted(by_anime.items(), key=lambda kv: NAMES.get(kv[0][0], "")):
        name = NAMES.get(mal, str(mal))
        print(f"\n{'=' * 96}")
        print(f"{name}  (mal {mal}, {lang})")
        print("=" * 96)

        for r in sorted(rs, key=lambda x: x["episode"]):
            ep = r["episode"]
            cons_op, cons_ed = r.get("op"), r.get("ed")
            print(f"\n  episode {ep}")
            print(f"    CONSENSUS   OP {ms((cons_op or {}).get('start')):>7}"
                  f"-{ms((cons_op or {}).get('end')):<7}"
                  f"  ED {ms((cons_ed or {}).get('start')):>7}"
                  f"-{ms((cons_ed or {}).get('end')):<7}"
                  f"  | OP {state(cons_op)} | ED {state(cons_ed)}")

            # Flag the hosts worth looking at FIRST. The OP is compared on its
            # absolute start and the ED on its from-end anchor, because those
            # are the quantities that should match across hosts — an ED whose
            # from-end disagrees is either a genuinely different encode or a
            # mis-detection, and only the picture can tell which.
            hosts = sorted((r.get("per_host") or {}).items())
            op_starts = [e["op"]["start"] for _h, e in hosts if e.get("op")]
            ed_fe = [e["ed"]["from_end_start"] for _h, e in hosts
                     if e.get("ed") and e["ed"].get("from_end_start") is not None]
            med_op = sorted(op_starts)[len(op_starts) // 2] if op_starts else None
            med_ed = sorted(ed_fe)[len(ed_fe) // 2] if ed_fe else None

            hdr = (f"    {'lecteur':<12}{'dur':>7}  {'OP':>15}  {'ED':>15}"
                   f"  {'ED from-end':>12}  {'votes OP/ED':>13}  ?")
            print(hdr)
            print("    " + "-" * (len(hdr) - 4))
            for host, e in hosts:
                op, ed = e.get("op"), e.get("ed")
                op_s = f"{ms((op or {}).get('start'))}-{ms((op or {}).get('end'))}" if op else "—"
                ed_s = f"{ms((ed or {}).get('start'))}-{ms((ed or {}).get('end'))}" if ed else "—"
                fe = ms((ed or {}).get("from_end_start")) if ed else "—"
                v = f"{(op or {}).get('votes','—')}/{(ed or {}).get('votes','—')}"
                mark = ""
                if op and med_op is not None and abs(op["start"] - med_op) > 4.0:
                    mark += f" OP{op['start'] - med_op:+.0f}s"
                if (ed and med_ed is not None
                        and ed.get("from_end_start") is not None
                        and abs(ed["from_end_start"] - med_ed) > 4.0):
                    mark += f" ED{ed['from_end_start'] - med_ed:+.0f}s"
                print(f"    {host:<12}{e.get('duration', 0):>6.0f}s  {op_s:>15}"
                      f"  {ed_s:>15}  {fe:>12}  {v:>13}  {mark}")
                out_json.append({
                    "anime": name, "mal_id": mal, "lang": lang, "episode": ep,
                    "host": host, "duration": e.get("duration"),
                    "op": None if not op else {"start": op["start"], "end": op["end"],
                                               "votes": op.get("votes")},
                    "ed": None if not ed else {"start": ed["start"], "end": ed["end"],
                                               "from_end_start": ed.get("from_end_start"),
                                               "votes": ed.get("votes")},
                    "op_state": state(cons_op), "ed_state": state(cons_ed),
                })

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(out_json, f, ensure_ascii=False, indent=1)
        print(f"\n[json] {len(out_json)} lignes -> {args.json}")


if __name__ == "__main__":
    main()
