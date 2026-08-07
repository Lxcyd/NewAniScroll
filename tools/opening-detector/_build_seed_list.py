"""Le lot qui mesure le gain du réessai + amorçage (07/08).

CIBLE CHOISIE POUR CE QU'ELLE PEUT PROUVER. On ne rejoue pas les cellules
vides : leur échec est le plus souvent hors de portée (pas de référence, hôte
qui ne sert pas la saison). On rejoue les cellules qui n'ont **qu'UN SEUL hôte
qui répond** alors qu'un autre hôte est présent et muet — c'est-à-dire à un hôte
du seuil de service (`MIN_AGREE_FOR_CONFIDENT = 2`).

C'est le gisement mesuré : 33 % des cellules exploitables sont dans cet état, et
82 de leurs hôtes muets ont déjà leur audio en cache — donc l'amorçage a
quelque chose à interroger, ce qui n'est pas le cas des cellules sans audio.

Ce que le lot doit dire, et qu'aucune estimation ne peut remplacer : combien de
ces cellules franchissent réellement le seuil, et à quel coût.

Usage : python tools/opening-detector/_build_seed_list.py [--out anime.seed.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _build_retry_list import source_entries  # noqa: E402
from _measure_fetch_failures import (  # noqa: E402
    has_reference, has_window, latest_rows, slug_map,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="anime.seed.json")
    args = ap.parse_args()

    slugs, rows, srcs = slug_map(), latest_rows(), source_entries()

    want: dict[tuple[int, str], set[int]] = defaultdict(set)
    n_cells = n_seedable = n_mute_noaudio = 0
    for (mal_id, ep, lang), r in rows.items():
        slug = slugs.get(mal_id)
        if not slug or not has_reference(mal_id):
            continue
        live = [h for h, v in r["per_host"].items() if v.get("op") or v.get("ed")]
        mute = [h for h, v in r["per_host"].items()
                if not (v.get("op") or v.get("ed"))]
        if len(live) != 1 or not mute:
            continue
        seedable = [h for h in mute if has_window(slug, lang, ep, h)]
        n_mute_noaudio += len(mute) - len(seedable)
        if not seedable:
            continue                      # rien à interroger : l'amorçage est inerte
        n_cells += 1
        n_seedable += len(seedable)
        want[(mal_id, lang)].add(ep)

    out_list = []
    for mal_id in {m for m, _ in want}:
        src = srcs.get(mal_id)
        if src is None:
            continue
        seasons = []
        for s in src["seasons"]:
            eps = want.get((mal_id, s["lang"]), set())
            if s.get("episodes"):
                span = set(s["episodes"])
            elif s.get("ep_start") and s.get("ep_end"):
                span = set(range(int(s["ep_start"]), int(s["ep_end"]) + 1))
            else:
                span = eps
            keep = sorted(eps & span)
            if keep:
                s2 = {k: v for k, v in s.items() if k not in ("ep_start", "ep_end")}
                seasons.append({**s2, "episodes": keep})
        if seasons:
            out_list.append({**src, "seasons": seasons})

    Path(args.out).write_text(
        json.dumps(out_list, ensure_ascii=False, indent=1), encoding="utf-8")
    n_eps = sum(len(s["episodes"]) for a in out_list for s in a["seasons"])
    print(f"{len(out_list)} anime, {n_eps} episodes -> {args.out}")
    print(f"  cellules a 1 seul hote vivant + >=1 hote muet AVEC audio : {n_cells}")
    print(f"  hotes muets interrogeables par amorcage                  : {n_seedable}")
    print(f"  hotes muets SANS audio (hors de portee de l'amorcage)    : {n_mute_noaudio}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
