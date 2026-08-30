"""Analyse the adversarial lot: where does the detector still fail, and is the
failure explained by the episode's POSITION in the season (premiere / finale)
or by the anime's shape (film, short, long-runner, VF, ...)?

Prints only aggregates + the worst offenders — the point is to decide what to
fix next, not to read 590 rows.
"""
from __future__ import annotations

import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent.parent
rows = [json.loads(l) for l in open(HERE / "out/hard.jsonl", encoding="utf-8") if l.strip()]
lst = json.loads((HERE / "datasets/anime.hard.json").read_text("utf-8"))

# episode -> position in its panel (premiere / finale / middle)
pos_of: dict[tuple[int, str, int], str] = {}
name_of: dict[int, str] = {}
eps_of: dict[tuple[int, str], list[int]] = {}
for a in lst:
    name_of[a["mal_id"]] = a["slug"]
    for s in a["seasons"]:
        eps = s.get("episodes") or []
        eps_of[(a["mal_id"], s["lang"])] = eps
        for e in eps:
            if len(eps) == 1:
                pos_of[(a["mal_id"], s["lang"], e)] = "unique"
            elif e == eps[0]:
                pos_of[(a["mal_id"], s["lang"], e)] = "premiere"
            elif e == eps[-1]:
                pos_of[(a["mal_id"], s["lang"], e)] = "finale"
            else:
                pos_of[(a["mal_id"], s["lang"], e)] = "milieu"

print(f"{len(rows)} lignes, {len(lst)} anime\n")

# ── 1. Par POSITION dans la saison ───────────────────────────────────────────
by_pos = defaultdict(lambda: Counter())
for r in rows:
    p = pos_of.get((r["mal_id"], r["lang"], r["episode"]), "?")
    by_pos[p]["n"] += 1
    for k in ("op", "ed"):
        v = r.get(k)
        if not v:
            by_pos[p][f"{k}_absent"] += 1
        elif v.get("serve"):
            by_pos[p][f"{k}_servi"] += 1
        else:
            by_pos[p][f"{k}_retenu"] += 1

print("=== PAR POSITION DANS LA SAISON ===")
print(f"{'position':10}{'n':>5}{'OP absent':>11}{'ED absent':>11}{'OP servi':>10}{'ED servi':>10}")
for p in ("premiere", "milieu", "finale", "unique"):
    c = by_pos.get(p)
    if not c:
        continue
    n = c["n"]
    print(f"{p:10}{n:>5}"
          f"{c['op_absent']:>7} {100*c['op_absent']/n:3.0f}%"
          f"{c['ed_absent']:>7} {100*c['ed_absent']/n:3.0f}%"
          f"{100*c['op_servi']/n:>9.0f}%{100*c['ed_servi']/n:>9.0f}%")

# ── 2. Par HOTE ──────────────────────────────────────────────────────────────
res, mop, med = Counter(), Counter(), Counter()
for r in rows:
    for h, v in (r.get("per_host") or {}).items():
        if not isinstance(v, dict):
            continue
        res[h] += 1
        if not v.get("op"):
            mop[h] += 1
        if not v.get("ed"):
            med[h] += 1
print("\n=== PAR LECTEUR ===")
print(f"{'hote':12}{'resolus':>8}{'sans OP':>9}{'sans ED':>9}")
for h in sorted(res, key=lambda x: -res[x]):
    print(f"{h:12}{res[h]:>8}{mop[h]:>6} {100*mop[h]/res[h]:3.0f}%{med[h]:>5} {100*med[h]/res[h]:3.0f}%")

# ── 3. ANIME entierement muets (aucun OP ni ED sur toutes leurs lignes) ──────
by_anime = defaultdict(list)
for r in rows:
    by_anime[r["mal_id"]].append(r)
silent = [m for m, rs in by_anime.items()
          if not any(r.get("op") or r.get("ed") for r in rs)]
print(f"\n=== ANIME SANS AUCUNE DETECTION : {len(silent)}/{len(by_anime)} ===")
for m in silent[:30]:
    n = len(by_anime[m])
    hosts = {h for r in by_anime[m] for h, v in (r.get("per_host") or {}).items()
             if isinstance(v, dict)}
    print(f"  mal {m:<8} {name_of.get(m,'?'):<34} {n} lignes, hotes={len(hosts)}")

# ── 4. DUREES ABERRANTES entre hotes d'une meme cellule ─────────────────────
print("\n=== ECARTS DE DUREE ENTRE LECTEURS (>15%) ===")
n_dur = 0
for r in rows:
    ds = [v["duration"] for v in (r.get("per_host") or {}).values()
          if isinstance(v, dict) and v.get("duration")]
    if len(ds) < 2:
        continue
    if max(ds) / min(ds) > 1.15:
        n_dur += 1
        if n_dur <= 12:
            print(f"  mal {r['mal_id']:<8} ep{r['episode']:<4} {r['lang']:<6} "
                  f"{[round(d) for d in sorted(ds)]}  {name_of.get(r['mal_id'],'')}")
print(f"  total : {n_dur} cellules")

# ── 5. SPANS IMPLAUSIBLES (un generique TV fait ~90 s) ──────────────────────
print("\n=== LONGUEURS OP/ED IMPLAUSIBLES ===")
bad = []
for r in rows:
    for k in ("op", "ed"):
        v = r.get(k)
        if not v or v.get("start") is None:
            continue
        span = v["end"] - v["start"]
        if span < 40 or span > 130:
            bad.append((r["mal_id"], r["episode"], r["lang"], k, round(span, 1)))
for b in bad[:15]:
    print(f"  mal {b[0]:<8} ep{b[1]:<4} {b[2]:<6} {b[3]} span={b[4]}s  {name_of.get(b[0],'')}")
print(f"  total : {len(bad)}")

# ── 6. Etat reconcilie global ───────────────────────────────────────────────
g = Counter()
for r in rows:
    for k in ("op", "ed"):
        v = r.get(k)
        g[(k, "absent" if not v else ("servi" if v.get("serve") else "retenu"))] += 1
print("\n=== GLOBAL ===")
for k in ("op", "ed"):
    tot = sum(g[(k, s)] for s in ("servi", "retenu", "absent"))
    print(f"  {k.upper()}  servi {g[(k,'servi')]:>4} ({100*g[(k,'servi')]/tot:.0f}%)   "
          f"retenu {g[(k,'retenu')]:>4}   absent {g[(k,'absent')]:>4} "
          f"({100*g[(k,'absent')]/tot:.0f}%)")

# ── 7. Motifs de retenue ────────────────────────────────────────────────────
held = Counter()
for r in rows:
    for k in ("op", "ed"):
        v = r.get(k)
        if v and not v.get("serve"):
            held[str(v.get("held_reason"))[:60]] += 1
print("\n=== MOTIFS DE RETENUE ===")
for reason, n in held.most_common(10):
    print(f"  {n:>4}  {reason}")
