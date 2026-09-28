"""Tire l'echantillon de verite terrain OP/ED (gt10) et son jeu tenu a l'ecart.

Entree : un export frais du catalogue (`scripts/oped/export-oped-anime-list.mjs
--out=out/v3/anime.all.json`), qui porte la popularite AniList.

  - 5 titres connus, choisis a la main (FORCED) : les cas qui ont deja pose
    probleme ou que Luc a cites (OP decale a l'ep1, ED special, cold open) ;
  - 2 peu connus : tires dans le quart le moins populaire du catalogue ;
  - 3 aleatoires : tires uniformement dans le reste ;
  - holdout : 5 autres titres, meme tirage, disjoints — jamais regardes
    pendant l'affinage, mesures une seule fois a la fin.

Episodes : 1, 2, 3 et le DERNIER de la saison selon AniList (pas celui du
panneau anime-sama, qui compte parfois les OAV : SnK S1 annonce 30 episodes
pour 25). Une langue n'est gardee que si son panneau couvre l'episode.

La graine (SEED) et la date de l export sont consignees dans datasets/README.md :
meme export + meme graine = meme tirage.

Usage : python scratch/_build_gt_list.py out/v3/anime.all.json
"""

from __future__ import annotations

import json
import random
import sys
import time
import urllib.request
from pathlib import Path

SEED = 20260928
ROOT = Path(__file__).resolve().parent.parent

# Titres connus. Frieren n'a plus de ligne `verified` dans player_map (absent de
# l'export du 28/09) : son panneau est repris de l'export d'aout, le resolveur
# dira s'il tient encore.
FORCED = [16498, 38000, 40748, 52991, 42310]
MANUAL = {
    52991: {
        "mal_id": 52991, "anilist_id": 154587, "slug": "frieren",
        "seasons": [
            {"season_dir": "saison1", "lang": "vostfr", "ep_start": 1, "ep_end": 28,
             "va_slug": "sousou-no-frieren"},
            {"season_dir": "saison1", "lang": "vf", "ep_start": 1, "ep_end": 28,
             "va_slug": "sousou-no-frieren-vf"},
        ],
    },
}


def anilist_episodes(ids: list[int]) -> dict[int, dict]:
    """AniList : nombre d'episodes, format, titre, par id AniList (une requete)."""
    q = """query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){
             id episodes format status title{romaji}}}}"""
    body = json.dumps({"query": q, "variables": {"ids": ids}}).encode()
    req = urllib.request.Request(
        "https://graphql.anilist.co", data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": "aniscroll-oped-gt/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        media = json.load(r)["data"]["Page"]["media"]
    return {m["id"]: m for m in media}


def eligible(a: dict) -> bool:
    # Une serie (TV ou ONA) terminee d'au moins 4 episodes : sinon « ep 1, 2, 3, dernier »
    # n'a pas de sens.
    return any(s["season_dir"].startswith("saison") and s["ep_end"] >= 4
               for s in a["seasons"])


def to_entry(a: dict, meta: dict) -> dict | None:
    n = meta.get("episodes")
    if not n or n < 4 or meta.get("status") != "FINISHED" or meta.get("format") not in ("TV", "ONA"):
        return None
    eps = [1, 2, 3, n]
    seasons = []
    for s in a["seasons"]:
        got = [e for e in eps if s["ep_start"] <= e <= s["ep_end"]]
        if not got:
            continue
        seasons.append({k: v for k, v in {
            "season_dir": s["season_dir"], "lang": s["lang"], "episodes": got,
            "va_slug": s.get("va_slug")}.items() if v is not None})
    if not seasons:
        return None
    return {"mal_id": a["mal_id"], "anilist_id": a["anilist_id"], "slug": a["slug"],
            "title": meta["title"]["romaji"], "popularity": a.get("popularity"),
            "last_episode": n, "seasons": seasons}


def main() -> None:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "out/v3/anime.all.json")
    cat = json.loads(src.read_text("utf-8"))
    by_mal = {a["mal_id"]: a for a in cat}
    by_mal.update({k: v for k, v in MANUAL.items() if k not in by_mal})

    pool = [a for a in cat if a["mal_id"] not in FORCED and eligible(a)]
    pool.sort(key=lambda a: a.get("popularity") or 0)
    obscure_pool = pool[: len(pool) // 4]
    rest_pool = pool[len(pool) // 4:]

    rng = random.Random(SEED)
    # On tire large puis on filtre sur AniList (TV, terminee) : les panneaux ne
    # disent ni le format ni le statut.
    obscure = rng.sample(obscure_pool, 12)
    rest = rng.sample(rest_pool, 16)
    ids = [by_mal[m]["anilist_id"] for m in FORCED] + [a["anilist_id"] for a in obscure + rest]
    meta = anilist_episodes(ids)
    time.sleep(1)

    def take(cands, k, taken):
        out = []
        for a in cands:
            if len(out) == k:
                break
            if a["mal_id"] in taken:
                continue
            e = to_entry(a, meta.get(a["anilist_id"], {}))
            if e:
                out.append(e)
                taken.add(a["mal_id"])
        if len(out) < k:
            sys.exit(f"pas assez de candidats eligibles ({len(out)}/{k})")
        return out

    taken: set[int] = set()
    forced = []
    for m in FORCED:
        e = to_entry(by_mal[m], meta.get(by_mal[m]["anilist_id"], {}))
        if not e:
            sys.exit(f"titre force inutilisable : {m}")
        forced.append(e)
        taken.add(m)
    for e in forced:
        e["group"] = "connu"
    ob = take(obscure, 2, taken)
    for e in ob:
        e["group"] = "peu connu"
    ra = take(rest, 3, taken)
    for e in ra:
        e["group"] = "aleatoire"
    ho_ob = take(obscure, 2, taken)
    ho_ra = take(rest, 3, taken)
    for e in ho_ob:
        e["group"] = "peu connu"
    for e in ho_ra:
        e["group"] = "aleatoire"

    stamp = {"seed": SEED, "source": src.name, "built": time.strftime("%Y-%m-%d")}
    for name, lot in (("anime.gt10.json", forced + ob + ra),
                      ("anime.gt-holdout.json", ho_ob + ho_ra)):
        dst = ROOT / "datasets" / name
        dst.write_text(json.dumps(lot, ensure_ascii=False, indent=1) + "\n", "utf-8")
        print(f"{dst.name} ({stamp})")
        for e in lot:
            print(f"  {e['group']:10} {e['mal_id']:>6} {e['title'][:40]:40} "
                  f"pop={e['popularity']} last={e['last_episode']} "
                  f"langs={[s['lang'] for s in e['seasons']]}")


if __name__ == "__main__":
    main()
