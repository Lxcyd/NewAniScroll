"""How many "absent" cells are absences the SOURCE already predicted?

AnimeThemes maps every theme to an episode span (`episodes_spec`): Erased's ED1
is "2-12", i.e. episode 1 HAS no ending. When the detector finds nothing there
it is right, but it reports the same "absent" as a genuine miss — so the audit
sheet cannot tell a correct answer from a failure, and neither can we.

This measures the split before changing anything.
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
rows = [json.loads(l) for l in open(HERE / "out/hard.jsonl", encoding="utf-8") if l.strip()]
lst = json.loads((HERE / "datasets/anime.hard.json").read_text("utf-8"))
name = {a["mal_id"]: a["slug"] for a in lst}
eps_of = {(a["mal_id"], s["lang"]): (s.get("episodes") or [])
          for a in lst for s in a["seasons"]}

_cache: dict[int, list | None] = {}


def themes_for(mal_id: int):
    if mal_id in _cache:
        return _cache[mal_id]
    try:
        slug = resolve_slug(mal_id=mal_id)
        _cache[mal_id] = fetch_themes(slug) if slug else None
    except Exception:
        _cache[mal_id] = None
    return _cache[mal_id]


def covered(mal_id: int, kind: str, ep: int):
    """True / False / None(unknown) — does ANY theme of this kind cover `ep`?"""
    ts = themes_for(mal_id)
    if not ts:
        return None
    want = kind.upper()
    saw_kind = False
    for t in ts:
        if not str(t.slug).upper().startswith(want):
            continue
        saw_kind = True
        for e in t.entries:
            if not getattr(e, "episodes_spec", None):
                return True          # unmapped entry applies everywhere
            if e.covers(ep):
                return True
    return False if saw_kind else None


stats = Counter()
examples = defaultdict(list)
pos_stats = defaultdict(Counter)

for r in rows:
    eps = eps_of.get((r["mal_id"], r["lang"]), [])
    if len(eps) >= 2:
        pos = ("premiere" if r["episode"] == eps[0]
               else "finale" if r["episode"] == eps[-1] else "milieu")
    else:
        pos = "unique"
    for kind in ("op", "ed"):
        if r.get(kind):
            continue
        c = covered(r["mal_id"], kind, r["episode"])
        key = ("attendue (aucun generique sur cet episode)" if c is False
               else "vraie lacune (un generique existe)" if c is True
               else "indecidable (pas de reference AnimeThemes)")
        stats[(kind, key)] += 1
        pos_stats[pos][key] += 1
        if len(examples[key]) < 8 and c is not None:
            examples[key].append(
                f"{name.get(r['mal_id'],'?')} ep{r['episode']} {r['lang']} {kind.upper()}")

print("=== NATURE DES CELLULES 'ABSENT' ===")
for kind in ("op", "ed"):
    tot = sum(v for (k, _), v in stats.items() if k == kind)
    print(f"\n  {kind.upper()} absent : {tot}")
    for (k, key), n in sorted(stats.items(), key=lambda x: -x[1]):
        if k == kind:
            print(f"      {n:>4} ({100*n/tot:3.0f}%)  {key}")

print("\n=== PAR POSITION DANS LA SAISON ===")
print(f"{'position':10}{'attendue':>10}{'vraie lacune':>14}{'indecidable':>13}")
for pos in ("premiere", "milieu", "finale", "unique"):
    c = pos_stats.get(pos)
    if not c:
        continue
    print(f"{pos:10}{c['attendue (aucun generique sur cet episode)']:>10}"
          f"{c['vraie lacune (un generique existe)']:>14}"
          f"{c['indecidable (pas de reference AnimeThemes)']:>13}")

print("\n=== EXEMPLES ===")
for key, ex in examples.items():
    print(f"  {key}:")
    for e in ex:
        print(f"      {e}")
