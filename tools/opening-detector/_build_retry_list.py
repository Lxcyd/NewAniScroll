"""Construit la liste de réessai des cellules dont l'audio n'a jamais été récupéré.

Point 2b. `_measure_fetch_failures.py` établit qu'un hôte présent dans `per_host`
mais sans fenêtre audio en cache donne une cellule vide dans 94 % des cas. Ce
script rassemble ces cellules-là dans une `--anime-list` restreinte, pour les
rejouer sans retoucher aux 593 autres.

Le run de réessai portera pour la première fois `detect_error` (posé le 07/08
dans `oped/multi_host.py`) : si un hôte échoue ENCORE, on saura enfin que c'est
le transport et non une absence de générique — c'est le vrai livrable du réessai,
au-delà des cellules récupérées.

PRUDENCE SUR LE GAIN ANNONCÉ. 91 des 97 cellules visées sont antérieures au champ
`expected_absent` : impossible de savoir combien sont des absences légitimes
plutôt que des échecs. Sur la base mesurée le 07/08 (35 % des « absences »
étaient déclarées par AnimeThemes), en attendre nettement moins de 97.

Usage : python tools/opening-detector/_build_retry_list.py [--out anime.retry.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _measure_fetch_failures import has_window, latest_rows, slug_map  # noqa: E402

ROOT = Path(__file__).resolve().parent

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def source_entries() -> dict[int, dict]:
    """mal_id -> entrée d'origine (on a besoin de season_dir/va_slug, pas juste du slug)."""
    out: dict[int, dict] = {}
    for p in ROOT.glob("anime*.json"):
        if p.name.startswith("anime.retry"):
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for a in data:
            if isinstance(a, dict) and a.get("mal_id") and a.get("seasons"):
                out.setdefault(int(a["mal_id"]), a)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="anime.retry.json")
    args = ap.parse_args()

    slugs, rows, srcs = slug_map(), latest_rows(), source_entries()

    # (mal_id, lang) -> {episodes} des cellules vides a >=1 hote sans fenetre
    want: dict[tuple[int, str], set[int]] = defaultdict(set)
    missing_by_host: dict[str, int] = defaultdict(int)
    for (mal_id, ep, lang), r in rows.items():
        slug = slugs.get(mal_id)
        if not slug or r.get("op") or r.get("ed"):
            continue
        miss = [h for h in r["per_host"] if not has_window(slug, lang, ep, h)]
        if miss:
            want[(mal_id, lang)].add(ep)
            for h in miss:
                missing_by_host[h] += 1

    out_list = []
    unmatched = 0
    for mal_id in {m for m, _ in want}:
        src = srcs.get(mal_id)
        if src is None:
            unmatched += 1
            continue
        seasons = []
        for s in src["seasons"]:
            eps = want.get((mal_id, s["lang"]), set())
            # Deux formats coexistent dans les listes d'entree : `episodes`
            # explicite, ou l'intervalle `ep_start`/`ep_end`. Ne lire que le
            # premier renvoyait un ensemble vide pour toute la seconde famille.
            if s.get("episodes"):
                span = set(s["episodes"])
            elif s.get("ep_start") and s.get("ep_end"):
                span = set(range(int(s["ep_start"]), int(s["ep_end"]) + 1))
            else:
                span = eps          # saison non bornee : on garde ce qu'on veut
            keep = sorted(eps & span)
            if keep:
                # On emet `episodes` seul, sinon l'intervalle d'origine
                # re-elargirait la saison qu'on vient de restreindre.
                s2 = {k: v for k, v in s.items() if k not in ("ep_start", "ep_end")}
                seasons.append({**s2, "episodes": keep})
        if seasons:
            out_list.append({**src, "seasons": seasons})

    Path(args.out).write_text(
        json.dumps(out_list, ensure_ascii=False, indent=1), encoding="utf-8")

    n_eps = sum(len(s["episodes"]) for a in out_list for s in a["seasons"])
    print(f"{len(out_list)} anime, {n_eps} episodes a rejouer -> {args.out}")
    if unmatched:
        print(f"  {unmatched} mal_id sans entree source (ignores)")
    print("\nfetches manquants par hote :")
    for h, n in sorted(missing_by_host.items(), key=lambda kv: -kv[1]):
        print(f"  {h:<14}{n:>5}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
