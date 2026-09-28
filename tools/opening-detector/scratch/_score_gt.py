"""Score d'une sortie de batch_detect contre la verite terrain OP/ED.

La verite terrain (`datasets/gt10.truth.json`) vient des verdicts de Luc sur
la page de verification : une entree par ligne de la page
  {id, mal, ep, lang, kind, hosts:[...], start, end, v, fixStart, fixEnd}
  v = juste | debut | fin | pas | manque
Le bord vrai d'une ligne jugee fausse est `fixStart`/`fixEnd` quand Luc l'a
donne ; sinon la ligne compte fausse sans erreur mesurable.

Ce qui est mesure, sur les cellules SERVIES (celles qu'un spectateur verrait) :
  - precision : servies justes / servies jugees ;
  - faux positifs « pas un generique » (le defaut le plus grave) ;
  - rappel : generiques reels servis / generiques reels (justes + manques) ;
  - erreur de bord (s) quand une correction existe.
Ventile par hote, par position d'episode (1er / 2-3 / dernier), par source
de preuve (credited / video / mixed / audio).

Usage : python scratch/_score_gt.py out/v3/gt10.jsonl datasets/gt10.truth.json
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict

TOL = 1.5  # s, sur chaque bord


def pos(ep: int, last: int | None) -> str:
    if ep == 1:
        return "ep1"
    if last and ep == last:
        return "dernier"
    return "ep2-3"


def main() -> None:
    out_f, truth_f = sys.argv[1], sys.argv[2]
    truth = json.load(open(truth_f, encoding="utf-8"))
    served = {}
    for line in open(out_f, encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        for host, ph in (r.get("per_host") or {}).items():
            for kind in ("op", "ed"):
                h = ph.get(kind)
                if h and h.get("start") is not None:
                    # « Servi » se decide sur la ligne RECONCILIEE (per_host n'a
                    # pas de drapeau propre) ; l'importeur filtre encore apres.
                    row_serve = bool((r.get(kind) or {}).get("serve"))
                    served[(r["mal_id"], r["episode"], r["lang"], kind, host)] = (
                        row_serve, h.get("source"), float(h["start"]), float(h["end"]))

    buckets = defaultdict(lambda: defaultdict(int))
    edge_err = []

    def add(keys, field):
        for k in keys:
            buckets[k][field] += 1

    for t in truth:
        v = t.get("v")
        if not v:
            continue
        for h in t["hosts"]:
            host = h["host"] if isinstance(h, dict) else h
            s = served.get((t["mal"], t["ep"], t["lang"], t["kind"], host))
            keys = ["TOUT", f"hote:{host}", f"pos:{pos(t['ep'], t.get('lastEp'))}",
                    f"kind:{t['kind']}"]
            if t.get("start") is None:           # ligne « rien detecte »
                add(keys, "manque_reel" if v == "manque" else "absence_juste")
                continue
            is_served = bool(s and s[0])
            keys.append(f"source:{s[1] if s else '?'}")
            if not is_served:
                add(keys, "retenu_juste" if v == "juste" else "retenu_faux")
                if v == "juste":
                    add(keys, "manque_reel")
                continue
            add(keys, "servi")
            if v == "juste":
                add(keys, "servi_juste")
            elif v == "pas":
                add(keys, "servi_pas_generique")
            else:
                add(keys, "servi_bord_faux")
                for edge, fix in (("start", t.get("fixStart")), ("end", t.get("fixEnd"))):
                    if fix is not None:
                        edge_err.append(abs(float(t[edge]) - float(fix)))

    print(f"{'groupe':22} servi  juste  prec.  pas-gen  bord-faux  manques  rappel")
    for k in sorted(buckets, key=lambda k: (k != "TOUT", k)):
        b = buckets[k]
        prec = b["servi_juste"] / b["servi"] if b["servi"] else None
        reel = b["servi_juste"] + b["manque_reel"]
        rec = b["servi_juste"] / reel if reel else None
        f = lambda x: "  —  " if x is None else f"{100 * x:4.0f}%"
        print(f"{k:22} {b['servi']:5} {b['servi_juste']:6} {f(prec):>6} "
              f"{b['servi_pas_generique']:8} {b['servi_bord_faux']:10} {b['manque_reel']:8} {f(rec):>7}")
    if edge_err:
        edge_err.sort()
        print(f"\nerreur de bord corrigee : mediane {edge_err[len(edge_err) // 2]:.1f} s, "
              f"max {edge_err[-1]:.1f} s (n={len(edge_err)}, tolerance {TOL} s)")


if __name__ == "__main__":
    main()
