#!/usr/bin/env python3
"""
Rattrapage : resout les OP/ED de TOUT le catalogue AnimeThemes, par lots.

    python backfill.py --limit 50           # 50 animes puis s'arrete
    python backfill.py --limit 50 --resume  # reprend ou on s'etait arrete
    python backfill.py --stats              # ou en est-on

Ecrit un JSONL incremental (une ligne par theme resolu), a passer ensuite a
scripts/oped/import-oped-youtube.mjs.

POURQUOI PAR LOTS, ET PAS D'UNE TRAITE
Le parc fait ~4 900 animes et ~14 400 themes. A deux recherches par theme, un
passage complet represente ~29 000 requetes. Elles partent aujourd'hui vers une
instance Piped tenue benevolement : la lui envoyer d'un bloc serait en abuser,
et elle a deja rendu des 502 et des reponses vides sous une charge bien plus
faible (mesure). Le script avance donc par tranches, garde un journal de ce
qui est fait, et se reprend.

L'ALTERNATIVE, SI TU VEUX ALLER VITE
L'API YouTube officielle facture `search.list` 100 unites sur 10 000/jour, soit
100 recherches quotidiennes : 50 themes par jour, ~288 jours pour le parc. Le
rattrapage complet suppose donc soit une augmentation de quota accordee par
Google, soit ta propre instance Piped/Invidious. Le regime permanent, lui, ne
pose aucun probleme : ~14 nouveaux themes par semaine, contre 700 de budget.

REPRISE
`state.json` retient les ids AniList deja traites. Un anime traite n'est jamais
repris, meme s'il n'a rien donne — c'est la meme regle que la table : une
absence est un resultat, pas un trou a recreuser.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from resolve import (
    _get_json, AT, fetch_themes, musicbrainz_artists, resolve_song, POLITE_DELAY,
)

ICI = os.path.dirname(os.path.abspath(__file__))
ETAT = os.path.join(ICI, "state.json")
SORTIE = os.path.join(ICI, "backfill.jsonl")

# Plus doux que le mode interactif : ce script tourne longtemps, sans personne
# devant. Ce qui est tolerable sur 15 titres ne l'est pas sur 5 000.
PAUSE_ENTRE_ANIMES = 3.0


def charger_etat() -> dict:
    if os.path.exists(ETAT):
        with open(ETAT, encoding="utf-8") as fh:
            return json.load(fh)
    return {"faits": [], "page": 1}


def sauver_etat(etat: dict) -> None:
    with open(ETAT, "w", encoding="utf-8") as fh:
        json.dump(etat, fh, ensure_ascii=False, indent=1)


def page_animes(page: int, taille: int = 100) -> list[dict]:
    """Une page du catalogue, avec l'id AniList (la cle de la table)."""
    d = _get_json(f"{AT}/anime", {
        "page[size]": taille,
        "page[number]": page,
        "include": "resources",
        "sort": "-year",          # les recents d'abord : ce qu'on cherche le plus
    })
    out = []
    for a in (d or {}).get("anime", []):
        anilist = next(
            (r.get("external_id") for r in a.get("resources", [])
             if r.get("site") == "AniList" and r.get("external_id")),
            None,
        )
        if anilist:
            out.append({"name": a.get("name"), "anilist_id": anilist,
                        "year": a.get("year")})
    return out


def traiter(anime: dict, sortie) -> dict:
    """Resout un anime, ecrit ses lignes, retourne le compte par verdict."""
    themes = fetch_themes(anime["name"])
    themes = [t for t in themes if t.get("anilist_id") == anime["anilist_id"]]
    compte = {}

    for t in themes:
        t["artist_source"] = "animethemes" if t["artists"] else None
        if not t["artists"]:
            t["artists"] = musicbrainz_artists(t["title"], t["anime"])
            if t["artists"]:
                t["artist_source"] = "musicbrainz"

        r = resolve_song(t["title"], t["artists"], t["anime"],
                         artist_trusted=(t["artist_source"] != "musicbrainz"))
        r["artist_source"] = t["artist_source"]
        r.update({k: t.get(k) for k in
                  ("anime", "anilist_id", "slot", "title", "artists")})
        sortie.write(json.dumps(r, ensure_ascii=False) + "\n")
        sortie.flush()          # un plantage ne doit pas coûter le lot entier
        compte[r["verdict"]] = compte.get(r["verdict"], 0) + 1

    return compte


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=25,
                    help="nombre d'animes a traiter avant de s'arreter")
    ap.add_argument("--resume", action="store_true",
                    help="repartir du journal plutot que du debut")
    ap.add_argument("--stats", action="store_true", help="etat et sortie")
    args = ap.parse_args()

    etat = charger_etat() if args.resume or args.stats else {"faits": [], "page": 1}
    faits = set(etat["faits"])

    if args.stats:
        n = 0
        if os.path.exists(SORTIE):
            with open(SORTIE, encoding="utf-8") as fh:
                lignes = [json.loads(l) for l in fh if l.strip()]
            n = len(lignes)
            from collections import Counter
            print("verdicts :", dict(Counter(l["verdict"] for l in lignes)))
        print(f"{len(faits)} anime(s) traite(s), {n} theme(s) resolu(s)")
        print(f"page courante : {etat['page']}")
        return 0

    total = {}
    traites = 0
    page = etat["page"]

    with open(SORTIE, "a", encoding="utf-8") as sortie:
        while traites < args.limit:
            animes = page_animes(page)
            if not animes:
                print(f"\nCatalogue termine (page {page} vide).")
                break

            for a in animes:
                if traites >= args.limit:
                    break
                if a["anilist_id"] in faits:
                    continue

                try:
                    compte = traiter(a, sortie)
                except Exception as e:
                    print(f"  [ERREUR] {a['name']}: {e}")
                    continue

                faits.add(a["anilist_id"])
                traites += 1
                for k, v in compte.items():
                    total[k] = total.get(k, 0) + v
                resume = " ".join(f"{k}:{v}" for k, v in sorted(compte.items())) or "aucun theme"
                print(f"[{traites:4}/{args.limit}] {a['name'][:48]:48} {resume}")

                etat["faits"] = sorted(faits)
                etat["page"] = page
                sauver_etat(etat)
                time.sleep(PAUSE_ENTRE_ANIMES)

            page += 1
            etat["page"] = page
            sauver_etat(etat)

    print(f"\n{traites} anime(s) traite(s) — verdicts {total}")
    print(f"Total cumule : {len(faits)} anime(s)")
    print(f"\nImporter avec :\n  node --env-file=.env.local "
          f"scripts/oped/import-oped-youtube.mjs --in=tools/ost-resolver/backfill.jsonl")
    return 0


if __name__ == "__main__":
    sys.exit(main())
