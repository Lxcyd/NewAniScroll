"""Controles d'un lot v2 en l'absence de verite humaine complete.

1. Contre les cellules relues de la v1 (tools/opening-detector/out/v3) :
   verdicts de Luc d'abord, sinon verdicts de Claude sur planches-contact.
   - « ok / juste »    : la v2 doit servir les memes bornes (+/- TOL_S) ;
   - « PAS UN GENERIQUE » : la v2 ne doit RIEN servir qui chevauche ;
   - autres « faux » / « incertain » : listes pour relecture, pas notes.
   Ce n'est PAS une mesure de precision : les verdicts de Claude ne sont pas
   une verite, et la v1 n'a relu que ce qu'elle avait trouve.
2. Coherence entre lecteurs : deux lecteurs de meme duree (+/- 1 s) partagent
   la timeline ; des bornes ecartees de plus de 0,5 s sont une erreur certaine.

    python -m eval.crosscheck out/gt10.jsonl
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

V1 = Path(__file__).resolve().parents[2] / "opening-detector" / "out" / "v3"
RAW = Path(__file__).resolve().parent / "raw" / "verdicts"
TOL_S = 1.5
SAME_FILE_S = 0.2  # JJK ep2 : frembed a +0,99 s de duree est un AUTRE encode (tout decale de +1 s)
HOST_AGREE_S = 1.0  # l affinage de fin varie de 0,6-0,8 s entre deux encodes de meme duree (Kimetsu VF)


def load_v2(path: str) -> dict:
    """(mal, ep, lang, host) -> liste des intervalles servis [(slot, start, end, ref)]."""
    out = {}
    for line in open(path, encoding="utf-8"):
        r = json.loads(line)
        for host, e in r["per_host"].items():
            out[(r["mal_id"], r["episode"], r["lang"], host)] = e
    return out


def served(e: dict) -> list[tuple[str, float, float, str]]:
    return [(s, e[s]["start"], e[s]["end"], e[s]["ref"]) for s in ("op", "ed") if s in e]



def to_player(c: dict, e: dict) -> tuple[float, float]:
    """Bornes d'une cellule v1 sur l'horloge du LECTEUR. Les cellules v1 ont ete
    relevees sur l'horloge du detecteur (PTS absolus) ; la v2 sert l'horloge du
    lecteur, decalee de `clock_offset` (Railgun S megaplay : 1,4 s)."""
    k = e.get("clock_offset") or 0.0
    return c["start"] - k, c["end"] - k

def ov(a0, a1, b0, b1) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0)) / max(1e-6, min(a1 - a0, b1 - b0))


def human() -> dict:
    out = {}
    for f in RAW.glob("*.json"):
        out[f.stem] = json.loads(f.read_text(encoding="utf-8"))
    return out


def main(argv: list[str]) -> int:
    v2 = load_v2(argv[0])
    cells = json.load(open(V1 / "cells.json", encoding="utf-8"))
    luc = human()
    stats = Counter()
    lines = {"desaccord": [], "sert_un_faux": [], "a_relire": []}

    for c in cells:
        if c["start"] is None:
            continue
        verdict = luc.get(c["id"], {}).get("v") or (c.get("claude") or {}).get("v")
        who = "luc" if c["id"] in luc else "claude"
        why = (c.get("claude") or {}).get("why", "")
        for h in c["hosts"]:
            e = v2.get((c["mal"], c["ep"], c["lang"], h["host"]))
            if e is None or "detect_error" in e:
                stats["v2_absent_ou_erreur"] += 1
                continue
            c0, c1 = to_player(c, e)
            hits = [x for x in served(e) if ov(c0, c1, x[1], x[2]) > 0.3]
            tag = f"{c['mal']} ep{c['ep']} {c['lang']} {h['host']:<10} {c['kind']} v1={c['start']:.1f}-{c['end']:.1f}"
            if verdict in ("ok", "juste"):
                if not hits:
                    stats[f"{who}_ok__v2_abstient"] += 1
                    cand = [x for x in e.get("candidates", []) if ov(c["start"], c["end"], x["start"], x["end"]) > 0.3]
                    best = max(cand, key=lambda x: x["coverage"], default=None)
                    lines["a_relire"].append(f"ABSTENTION  {tag}  meilleur candidat: {best}")
                    continue
                s, a, b, ref = hits[0]
                ds, de = a - c0, b - c1
                if abs(ds) <= TOL_S and abs(de) <= TOL_S:
                    stats[f"{who}_ok__v2_accord"] += 1
                else:
                    stats[f"{who}_ok__v2_desaccord"] += 1
                    lines["desaccord"].append(f"{tag}  v2={a:.1f}-{b:.1f} ({ref})  d_debut={ds:+.1f} d_fin={de:+.1f}")
            elif verdict == "faux" and "PAS UN GENERIQUE" in why.upper():
                if hits:
                    stats["pas_un_generique__v2_SERT"] += 1
                    lines["sert_un_faux"].append(f"{tag}  v2={hits[0][1]:.1f}-{hits[0][2]:.1f}  | {why[:90]}")
                else:
                    stats["pas_un_generique__v2_rejette"] += 1
            else:
                stats[f"{verdict or 'sans_verdict'}__v2_{'sert' if hits else 'abstient'}"] += 1
                v2s = f"v2={hits[0][1]:.1f}-{hits[0][2]:.1f}" if hits else "v2=rien"
                lines["a_relire"].append(f"{(verdict or '?').upper():<10} {tag}  {v2s}  | {why[:90]}")

    # Coherence entre lecteurs d'un meme fichier
    by_ep: dict = {}
    for (mal, ep, lang, host), e in v2.items():
        if "duration" in e:
            by_ep.setdefault((mal, ep, lang), []).append((host, e))
    contra = []
    for k, hs in by_ep.items():
        for i in range(len(hs)):
            for j in range(i + 1, len(hs)):
                (h1, e1), (h2, e2) = hs[i], hs[j]
                if abs(e1["duration"] - e2["duration"]) > SAME_FILE_S:
                    continue
                for slot in ("op", "ed"):
                    if slot in e1 and slot in e2:
                        d = max(abs(e1[slot]["start"] - e2[slot]["start"]), abs(e1[slot]["end"] - e2[slot]["end"]))
                        stats["paires_meme_fichier"] += 1
                        if d > HOST_AGREE_S:
                            contra.append(f"{k} {slot} {h1}/{h2} ecart {d:.2f}s")
                    elif (slot in e1) != (slot in e2):
                        stats["paires_meme_fichier_un_seul_sert"] += 1

    # Couverture brute du lot
    n_host_eps = sum(1 for e in v2.values() if "duration" in e)
    n_err = sum(1 for e in v2.values() if "detect_error" in e)
    n_op = sum(1 for e in v2.values() if "op" in e)
    n_ed = sum(1 for e in v2.values() if "ed" in e)
    print(f"lecteur-episodes traites: {n_host_eps}  erreurs: {n_err}  OP servis: {n_op}  ED servis: {n_ed}")
    print("\n== Bilan")
    for k, v in sorted(stats.items()):
        print(f"  {k:<40} {v}")
    print(f"  contradictions_meme_fichier            {len(contra)}")
    for title, ls in (("Desaccords sur cellules jugees justes", lines["desaccord"]),
                      ("SERT un « pas un generique »", lines["sert_un_faux"]),
                      ("Contradictions entre lecteurs du meme fichier", contra),
                      ("A relire", lines["a_relire"])):
        print(f"\n== {title} ({len(ls)})")
        for l in ls:
            print("  " + l)
    return 1 if (lines["sert_un_faux"] or contra) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
