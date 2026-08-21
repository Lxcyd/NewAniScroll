"""Global OP/ED stats across every lot, with each empty cell CLASSIFIED.

An empty cell is not one thing. Three states, and conflating them is what made
past coverage numbers unreadable:

  ATTENDUE     AnimeThemes maps every theme of that kind AWAY from this episode
               -> there is nothing to find. Finding nothing is CORRECT.
  LACUNE       a theme does cover this episode -> we should have found it and
               did not. This is the real error rate.
  INDECIDABLE  no AnimeThemes reference at all (or none of that kind) -> we
               cannot say, and we do not guess.

Usage: python _stats_globales.py [tag ...]      (default: hard hard2)
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from oped.animethemes import fetch_themes, resolve_slug  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
TAGS = sys.argv[1:] or ["hard", "hard2"]

rows, eps_of, name = [], {}, {}
for tag in TAGS:
    f = HERE / f"out/{tag}.jsonl"
    if not f.exists():
        continue
    for line in open(f, encoding="utf-8"):
        if line.strip():
            r = json.loads(line)
            r["_lot"] = tag
            rows.append(r)
    lf = HERE / f"datasets/anime.{tag}.json"
    if lf.exists():
        for a in json.loads(lf.read_text("utf-8")):
            name[a["mal_id"]] = a["slug"]
            for s in a["seasons"]:
                eps_of[(a["mal_id"], s["lang"])] = s.get("episodes") or []

_tc: dict[int, object] = {}


def themes_for(mal_id):
    if mal_id not in _tc:
        try:
            slug = resolve_slug(mal_id=mal_id)
            _tc[mal_id] = fetch_themes(slug) if slug else None
        except Exception:
            _tc[mal_id] = None
    return _tc[mal_id]


def classify(r, kind):
    """'attendue' | 'lacune' | 'indecidable' for an EMPTY cell."""
    pre = (r.get("expected_absent") or {}).get(kind)
    if pre is True:
        return "attendue"
    if pre is False:
        return "lacune"
    ts = themes_for(r["mal_id"])
    if not ts:
        return "indecidable"
    want, saw = kind.upper(), False
    for t in ts:
        if not str(getattr(t, "slug", "")).upper().startswith(want):
            continue
        saw = True
        for e in t.entries:
            if not getattr(e, "episodes_spec", None):
                return "lacune"
            if e.covers(r["episode"]):
                return "lacune"
    return "attendue" if saw else "indecidable"


def position(r):
    eps = eps_of.get((r["mal_id"], r["lang"]), [])
    if len(eps) < 2:
        return "unique"
    return ("premiere" if r["episode"] == eps[0]
            else "finale" if r["episode"] == eps[-1] else "milieu")


tot = Counter()
by_pos = defaultdict(Counter)
by_lot = defaultdict(Counter)
for r in rows:
    p, lot = position(r), r["_lot"]
    for kind in ("op", "ed"):
        v = r.get(kind)
        if v:
            state = "servi" if v.get("serve") else "retenu"
        else:
            state = classify(r, kind)
        tot[(kind, state)] += 1
        by_pos[p][(kind, state)] += 1
        by_lot[lot][(kind, state)] += 1

STATES = ["servi", "retenu", "attendue", "lacune", "indecidable"]


def block(title, c):
    print(f"\n{title}")
    print(f"  {'':6}{'servi':>8}{'retenu':>9}{'attendue':>11}"
          f"{'LACUNE':>9}{'indecid.':>10}{'total':>8}")
    for kind in ("op", "ed"):
        n = sum(c[(kind, s)] for s in STATES)
        if not n:
            continue
        cells = "".join(f"{c[(kind, s)]:>8}" if s != "attendue"
                        else f"{c[(kind, s)]:>10}" for s in STATES)
        print(f"  {kind.upper():6}{c[(kind,'servi')]:>8}{c[(kind,'retenu')]:>9}"
              f"{c[(kind,'attendue')]:>11}{c[(kind,'lacune')]:>9}"
              f"{c[(kind,'indecidable')]:>10}{n:>8}")
    # the honest error rate: lacunes over cells where an answer was possible
    for kind in ("op", "ed"):
        decidable = sum(c[(kind, s)] for s in ("servi", "retenu", "lacune"))
        if decidable:
            lac = c[(kind, "lacune")]
            print(f"    -> {kind.upper()} taux d'echec reel : {lac}/{decidable} "
                  f"= {100*lac/decidable:.0f}%  (hors absences attendues "
                  f"et indecidables)")


print(f"{len(rows)} lignes analysees, lots = {', '.join(TAGS)}")
block("=== GLOBAL ===", tot)
for lot in TAGS:
    if by_lot[lot]:
        block(f"=== LOT {lot} ===", by_lot[lot])
for p in ("premiere", "milieu", "finale", "unique"):
    if by_pos[p]:
        block(f"=== POSITION : {p.upper()} ===", by_pos[p])
