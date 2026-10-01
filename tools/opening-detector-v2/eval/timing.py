"""Ce qu'un lot a coute : temps par etape et reseau, par lecteur.

    python -m eval.timing out/gt10.frame.jsonl [autre.jsonl ...]

Lit le champ `timing` que run.py pose sur chaque lecteur. Les temps sont des
temps REELS (ce qu'on attend) ; `reseau` est la somme des requetes du lot
pendant ce lecteur — exacte avec --workers 1, melangee entre episodes sinon.
« a froid » = empreinte audio absente du cache, donc episode telecharge en
entier ; « a chaud » = seules les fenetres image restent a chercher.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from statistics import median


def main(argv: list[str]) -> int:
    rows = [json.loads(l) for f in argv for l in open(f, encoding="utf-8")]
    by: dict[tuple[str, bool], list[dict]] = defaultdict(list)
    n_ep = n_host = err = 0
    for r in rows:
        n_ep += 1
        for h, e in r["per_host"].items():
            if "detect_error" in e:
                err += 1
            t = e.get("timing")
            if t:
                n_host += 1
                by[(h, not t.get("empreinte_en_cache"))].append(t)
    print(f"{n_ep} episodes, {n_host} lecteurs chronometres, {err} en panne\n")
    print(f"{'lecteur':<11}{'etat':<8}{'n':>4}{'empreinte':>11}{'image':>8}{'bords':>8}{'total':>8}{'Mo':>9}{'Mo/s':>7}   (medianes, s)")
    tot_s = tot_mo = 0.0
    for (h, cold), ts in sorted(by.items()):
        med = lambda k: median(t.get(k, 0.0) for t in ts)  # noqa: E731
        mo = [t["reseau"]["octets"] / 1e6 for t in ts]
        rate = [t["reseau"]["octets"] / 1e6 / t["reseau"]["secondes"] for t in ts if t["reseau"]["secondes"] > 1]
        tot_s += sum(t["total_s"] for t in ts)
        tot_mo += sum(mo)
        print(f"{h:<11}{'froid' if cold else 'chaud':<8}{len(ts):>4}{med('empreinte_s'):>11.1f}{med('image_s'):>8.1f}"
              f"{med('bords_s'):>8.1f}{med('total_s'):>8.1f}{median(mo):>9.1f}{(median(rate) if rate else 0):>7.2f}")
    print(f"\nsomme des temps par lecteur : {tot_s / 60:.1f} min ; telecharge : {tot_mo / 1000:.2f} Go")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
