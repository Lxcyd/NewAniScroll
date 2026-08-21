"""Dump every EMPTY cell of a lot, with our verdict, for the third-party check.

Splits the work in two so each half stays in the language that already has the
data: Python owns the AnimeThemes classification (the theme objects live here),
Node owns the provider calls (the provider code lives there, in TypeScript).
This writes the hand-off file.

Usage: python _dump_empty_cells.py [tag ...]   ->  out/empty_cells.json
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from oped.animethemes import fetch_themes, resolve_slug  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
TAGS = sys.argv[1:] or ["hard"]

rows, meta = [], {}
for tag in TAGS:
    f = HERE / f"out/{tag}.jsonl"
    if f.exists():
        rows += [json.loads(l) for l in open(f, encoding="utf-8") if l.strip()]
    lf = HERE / f"datasets/anime.{tag}.json"
    if lf.exists():
        for a in json.loads(lf.read_text("utf-8")):
            meta[a["mal_id"]] = {"anilist_id": a.get("anilist_id"), "slug": a["slug"]}

_tc: dict[int, object] = {}


def themes_for(mal_id):
    if mal_id not in _tc:
        try:
            s = resolve_slug(mal_id=mal_id)
            _tc[mal_id] = fetch_themes(s) if s else None
        except Exception:
            _tc[mal_id] = None
    return _tc[mal_id]


def verdict(r, kind):
    """Why is this cell empty, according to AnimeThemes only."""
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
            if not getattr(e, "episodes_spec", None) or e.covers(r["episode"]):
                return "lacune"
    return "attendue" if saw else "indecidable"


def ep_length(r):
    ds = [v["duration"] for v in (r.get("per_host") or {}).values()
          if isinstance(v, dict) and v.get("duration")]
    return round(statistics.median(ds)) if ds else 0


out = []
for r in rows:
    for kind in ("op", "ed"):
        if r.get(kind):
            continue
        m = meta.get(r["mal_id"], {})
        out.append({
            "mal_id": r["mal_id"],
            "anilist_id": m.get("anilist_id"),
            "slug": m.get("slug"),
            "episode": r["episode"],
            "lang": r["lang"],
            "kind": kind,
            "verdict": verdict(r, kind),
            "episode_length": ep_length(r),
        })

dst = HERE / "out/empty_cells.json"
dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
pairs = {(c["mal_id"], c["episode"]) for c in out}
print(f"{len(out)} cellules vides, {len(pairs)} paires (mal, episode) a interroger")
for v in ("attendue", "lacune", "indecidable"):
    print(f"  {v:12} {sum(1 for c in out if c['verdict'] == v)}")
print(f"-> {dst}")
