#!/usr/bin/env python3
"""Juge de coherence d'un lot du detecteur — hors-ligne, aucun reseau.

    python check_coherence.py --in out/top50.checked.jsonl [--detail] [--csv f.csv]

Le critere n'est pas « combien de cellules servies » mais « sur un lecteur qui
marche, ai-je toujours un resultat, et est-il juste ». Trois compteurs doivent
tomber a zero ; le quatrieme est informatif.

  trous_B            un hote traite n'a rien rendu alors qu'un pair PARTAGEANT
                     SA TIMELINE a trouve. Aucune excuse possible : meme
                     fichier, meme montage, le detecteur a lache.
  contradictions     deux hotes de meme timeline donnent des bornes ecartees de
                     plus de CONTRADICTION_S. Au moins une des deux est fausse.
  contenu_divergent  un hote dont la duree s'ecarte de tous ses pairs de plus de
                     DIVERGENT_S : le fichier servi n'est probablement pas le
                     meme contenu. Ce n'est PAS une faute de detection — c'est
                     une alerte transport, et ca disqualifie la cellule comme
                     preuve dans les deux compteurs precedents.
  aveugles           cellules ou AUCUN couple d'hotes ne partage de timeline :
                     le juge n'y voit structurellement rien. Un titre majoritai-
                     rement aveugle n'est PAS vert, il est AVEUGLE — declarer
                     vert ce qu'on n'a pas pu regarder ne vaut rien pour un
                     objectif « aucune erreur ».
  couverture         hits / cellules ou un theme est cense exister.

Pourquoi la DUREE comme discriminant : c'est le seul dont on dispose qui soit
honnete. Deux hotes de meme longueur partagent la timeline, donc tout desaccord
entre eux est une faute sans interpretation possible. Comparer des hotes de
durees differentes (megaplay=mewstream, vidmoly-va=voir-anime ont de vraies
amorces differentes) melangerait des populations et produirait un chiffre
invente.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

SAME_TIMELINE_S = 1.0   # en deca, deux fichiers sont le meme montage
CONTRADICTION_S = 2.0   # au dela, deux hotes de meme timeline se contredisent
DIVERGENT_S = 15.0      # au dela, ce n'est plus un encodage different mais un autre contenu
KINDS = ("op", "ed")


def _hit(entry: dict | None, kind: str) -> dict | None:
    """Le hit de ce kind pour cet hote, ou None. Un intervalle degenere ne compte pas."""
    if not isinstance(entry, dict):
        return None
    h = entry.get(kind)
    if not isinstance(h, dict):
        return None
    if not isinstance(h.get("start"), (int, float)):
        return None
    return h


def _dur(entry: dict | None) -> float | None:
    d = (entry or {}).get("duration")
    return float(d) if isinstance(d, (int, float)) else None


def analyse_row(row: dict) -> dict:
    """Les compteurs d'UNE cellule (anime, episode, lang), plus le detail."""
    hosts = {h: e for h, e in (row.get("per_host") or {}).items() if isinstance(e, dict)}
    expected_absent = row.get("expected_absent") or {}
    out = Counter()
    cases: list[tuple[str, str, str]] = []   # (compteur, hote, texte)

    # Un hote dont AUCUN pair ne partage la duree a >DIVERGENT_S ne sert de preuve
    # a rien : ni son absence ni son desaccord ne sont imputables au detecteur.
    divergent: set[str] = set()
    for host, entry in hosts.items():
        mine = _dur(entry)
        peers = [d for h, e in hosts.items() if h != host and (d := _dur(e)) is not None]
        if mine is None or not peers:
            continue
        gap = min(abs(p - mine) for p in peers)
        if gap > DIVERGENT_S:
            divergent.add(host)
            out["contenu_divergent"] += 1
            cases.append(("contenu_divergent", host, f"duree {mine:.0f}s, pair le plus proche a {gap:.0f}s"))

    # Un couple d'hotes de meme timeline est la SEULE preuve dont le juge dispose.
    # Sans lui, la cellule n'est pas « correcte » : elle est hors de portee.
    witnessable = [h for h, e in hosts.items()
                   if h not in divergent and (d := _dur(e)) is not None
                   and any(h2 != h and h2 not in divergent and (d2 := _dur(e2)) is not None
                           and abs(d2 - d) <= SAME_TIMELINE_S
                           for h2, e2 in hosts.items())]
    blind = len(witnessable) < 2

    for kind in KINDS:
        hits = {h: x for h, e in hosts.items() if (x := _hit(e, kind))}
        out["aveugles" if blind else "jugeables"] += 1
        if not expected_absent.get(kind):
            out[f"cells_{kind}"] += len(hosts)
            out[f"hits_{kind}"] += len(hits)

        # trous_B : le pair qui a trouve doit partager la timeline.
        for host, entry in hosts.items():
            if host in divergent or _hit(entry, kind) is not None:
                continue
            mine = _dur(entry)
            if mine is None:
                continue
            witness = [h for h in hits
                       if h not in divergent
                       and (d := _dur(hosts[h])) is not None
                       and abs(d - mine) <= SAME_TIMELINE_S]
            if witness:
                out["trous_B"] += 1
                cases.append(("trous_B", host, f"{kind} — {', '.join(witness)} a trouve sur la meme timeline"))

        # contradictions : paires de meme timeline qui ne disent pas la meme chose.
        names = [h for h in hits if h not in divergent]
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                da, db = _dur(hosts[a]), _dur(hosts[b])
                if da is None or db is None or abs(da - db) > SAME_TIMELINE_S:
                    continue
                delta = abs(hits[a]["start"] - hits[b]["start"])
                if delta > CONTRADICTION_S:
                    out["contradictions"] += 1
                    cases.append(("contradictions", f"{a}|{b}", f"{kind} — {delta:.1f}s d'ecart, meme timeline"))

    return {"counts": out, "cases": cases}


def dedupe(rows: list[dict]) -> tuple[list[dict], int]:
    """Un lot relance sur un titre produit deux lignes pour la meme cellule. On
    garde la plus riche (le plus d'hotes) : juger la pauvre inventerait des trous."""
    best: dict[tuple, dict] = {}
    for r in rows:
        key = (r.get("mal_id"), r.get("episode"), r.get("lang"))
        prev = best.get(key)
        if prev is None or len(r.get("per_host") or {}) > len(prev.get("per_host") or {}):
            best[key] = r
    return list(best.values()), len(rows) - len(best)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--in", dest="src", required=True, help="JSONL du detecteur")
    ap.add_argument("--detail", action="store_true", help="lister chaque cas, titre par titre")
    ap.add_argument("--csv", help="ecrire le tableau par titre dans ce fichier")
    args = ap.parse_args()

    rows = [json.loads(l) for l in Path(args.src).read_text("utf-8").splitlines() if l.strip()]
    rows, dupes = dedupe(rows)

    by_title: dict[int, Counter] = defaultdict(Counter)
    detail: dict[int, list] = defaultdict(list)
    langs: dict[int, set] = defaultdict(set)
    for r in rows:
        mal = r.get("mal_id")
        res = analyse_row(r)
        by_title[mal].update(res["counts"])
        by_title[mal]["cellules"] += 1
        langs[mal].add(r.get("lang"))
        for c in res["cases"]:
            detail[mal].append((r.get("episode"), r.get("lang"), *c))

    def cov(c: Counter) -> float:
        tot = c["cells_op"] + c["cells_ed"]
        return 100.0 * (c["hits_op"] + c["hits_ed"]) / tot if tot else 0.0

    def verdict(c: Counter) -> str:
        if c["trous_B"] or c["contradictions"]:
            return "ROUGE"
        # Vert veut dire « verifie », pas « pas encore pris en faute ».
        seen = c["jugeables"]
        return "vert" if seen and seen >= c["aveugles"] else "AVEUGLE"

    red = [m for m, c in by_title.items() if verdict(c) == "ROUGE"]
    blind = [m for m, c in by_title.items() if verdict(c) == "AVEUGLE"]

    print(f"{args.src} — {len(rows)} cellules, {len(by_title)} titres"
          + (f", {dupes} doublon(s) ecarte(s)" if dupes else ""))
    print()
    print(f"{'titre':>8} {'cel':>4} {'trous_B':>8} {'contrad':>8} {'diverg':>7} "
          f"{'aveugle':>8} {'couv':>7}  verdict")
    for mal, c in sorted(by_title.items(), key=lambda x: (-x[1]["trous_B"] - x[1]["contradictions"], x[0])):
        print(f"{mal:>8} {c['cellules']:>4} {c['trous_B']:>8} {c['contradictions']:>8} "
              f"{c['contenu_divergent']:>7} {c['aveugles']:>4}/{c['aveugles'] + c['jugeables']:<3} "
              f"{cov(c):>6.1f}%  {verdict(c)}")
        if args.detail and detail[mal]:
            for ep, lang, counter, host, txt in sorted(detail[mal]):
                print(f"           ep{ep:<4} {lang:<6} {counter:<18} {host:<24} {txt}")

    tot = Counter()
    for c in by_title.values():
        tot.update(c)
    print()
    seen = tot["jugeables"] + tot["aveugles"]
    print(f"TOTAL  trous_B={tot['trous_B']}  contradictions={tot['contradictions']}  "
          f"contenu_divergent={tot['contenu_divergent']}  couverture={cov(tot):.1f}%")
    print(f"       {tot['aveugles']}/{seen} cellules AVEUGLES "
          f"({100 * tot['aveugles'] // seen if seen else 0}% hors de portee du juge)")
    print(f"       {len(by_title) - len(red) - len(blind)} verts · {len(red)} rouges · "
          f"{len(blind)} aveugles, sur {len(by_title)} titres")

    if args.csv:
        lines = ["mal_id,langs,cellules,trous_B,contradictions,contenu_divergent,"
                 "aveugles,jugeables,couverture,verdict"]
        for mal, c in sorted(by_title.items()):
            lines.append(f"{mal},{'+'.join(sorted(x for x in langs[mal] if x))},{c['cellules']},"
                         f"{c['trous_B']},{c['contradictions']},{c['contenu_divergent']},"
                         f"{c['aveugles']},{c['jugeables']},{cov(c):.1f},{verdict(c)}")
        Path(args.csv).write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"       -> {args.csv}")

    return 1 if red else 0


if __name__ == "__main__":
    raise SystemExit(main())
