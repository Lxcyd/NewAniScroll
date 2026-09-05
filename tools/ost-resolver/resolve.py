#!/usr/bin/env python3
"""
Resout les OP/ED d'un anime vers la version COMPLETE sur YouTube.

Chaine : AnimeThemes (titre + artiste de reference) -> recherche YouTube Music
-> scoring -> verdict (OK / REVIEW / ABSENT).

Le point du script n'est pas de trouver un resultat : c'est de refuser les
mauvais. Les pieges mesures sur le terrain, et ce qui les contre :

  - le top-1 est parfois un cover (Chainsaw Man ED6)   -> match de chaine obligatoire
  - les titres divergent (Zanki / 残機)                -> le titre ne sert que de
                                                          departage, jamais de filtre
  - les TV edits font 90 s                             -> plancher de duree
  - l'API renvoie un resultat vide par intermittence   -> N tentatives avant "absent"
  - un nom d'album cherche en chanson donne un faux
    positif credible                                   -> passe album separee

Usage :
    python resolve.py "Chainsaw Man"
    python resolve.py "Cyberpunk: Edgerunners" --json out.json
    python resolve.py --album "Chainsaw Man Original Soundtrack"
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import unicodedata
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AniScroll-ost-resolver/1.0"
AT = "https://api.animethemes.moe"
PIPED = "https://api.piped.private.coffee"

# Une TV size fait ~90 s. On refuse tout ce qui pourrait en etre une.
MIN_FULL_SECONDS = 100
# Au-dela, c'est un mix d'album entier ou une compilation fan, pas une piste.
MAX_TRACK_SECONDS = 900

# Marqueurs de reprise / derive. Presents dans le titre = disqualifiant.
BAD_MARKERS = (
    "cover", "instrumental", "karaoke", "off vocal", "remix", "tv size",
    "tv edit", "tv ver", "nightcore", "sped up", "slowed", "8-bit", "8bit",
    "piano", "acoustic", "lo-fi", "lofi", "epic version", "orchestral",
    "english ver", "spanish ver", "espanol", "version en", "male ver",
    "female ver", "reaction", "amv", "loop", "ringtone",
)

# Retente avant de conclure a une absence : une reponse vide est souvent
# une defaillance d'instance, pas un catalogue muet.
SEARCH_ATTEMPTS = 4
BACKOFF_SECONDS = 4
POLITE_DELAY = 2
# Mesure : 30 requetes passent de 28 s en sequentiel a 1,4 s a 8 threads.
# Au-dela de 8 le debit plafonne (12 threads : 1,5 s), on sature l'instance.
WORKERS = 8


# ---------------------------------------------------------------- utilitaires

def _curl(url: str, timeout: int = 30) -> str:
    out = subprocess.run(
        ["curl", "-s", "-m", str(timeout), "-A", UA, url],
        capture_output=True, text=True, encoding="utf-8",
    )
    return out.stdout or ""


def _get_json(url: str, params: dict | None = None, attempts: int = 3):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for i in range(attempts):
        try:
            return json.loads(_curl(url))
        except Exception:
            if i < attempts - 1:
                time.sleep(BACKOFF_SECONDS)
    return None


def normalize(s: str) -> str:
    """Casse, accents et ponctuation retires. Sert au rapprochement de noms."""
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = re.sub(r"\s*-\s*topic\s*$", "", s)          # chaines auto YouTube Music
    s = re.sub(r"\(.*?\)|\[.*?\]|【.*?】", " ", s)   # parentheses et crochets
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()


def tokens(s: str) -> set[str]:
    return set(normalize(s).split())


def artist_match(reference: list[str], channel: str) -> float:
    """
    Rapproche l'artiste de reference du nom de la chaine YouTube.

    Compare des ensembles de jetons, pas des chaines : AnimeThemes ecrit parfois
    "Yonezu Kenshi" la ou YouTube ecrit "Kenshi Yonezu". Retourne 1.0 pour un
    ensemble identique, 0.7 pour une inclusion, 0.0 sinon.
    """
    ch = tokens(channel)
    if not ch:
        return 0.0
    for art in reference:
        a = tokens(art)
        if not a:
            continue
        if a == ch:
            return 1.0
        # L'inclusion couvre "ano" vs "ano band" ou les feat. en plus.
        # Sur un artiste d'un seul jeton court, on exige l'egalite stricte :
        # sinon "ano" matcherait "anonymouz".
        if len(a) == 1 and len(next(iter(a))) <= 4:
            continue
        if a <= ch or ch <= a:
            return 0.7
    return 0.0


def title_similarity(reference: str, candidate: str) -> float:
    """
    Departage seulement. Volontairement faible en poids : on a mesure que le
    titre diverge sur pres de la moitie du corpus (romaji vs japonais).
    """
    a, b = tokens(reference), tokens(candidate)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def has_bad_marker(title: str) -> str | None:
    """
    Volontairement PAS normalize() : celui-ci vide les parentheses, or c'est
    exactement la que se signalent les reprises — "(English Cover)",
    "(TV edit)", "(Instrumental)". Normaliser d'abord rendait ce filtre
    aveugle (un cover a ete valide en ED7 avant correction).
    """
    low = unicodedata.normalize("NFKC", title or "").lower()
    for m in BAD_MARKERS:
        if m in low:
            return m
    return None


# ------------------------------------------------------------- AnimeThemes

def fetch_themes(anime_query: str) -> list[dict]:
    """
    Recupere les OP/ED. L'artiste est resolu par ID de chanson : l'include
    imbriqué depuis /anime depasse la profondeur autorisee et renvoie une
    liste d'artistes VIDE sans lever d'erreur.
    """
    data = _get_json(f"{AT}/anime", {
        "filter[name-like]": f"%{anime_query}%",
        "include": "animethemes.song",
    })
    if not data or not data.get("anime"):
        return []

    out = []
    for anime in data["anime"]:
        for th in anime.get("animethemes", []):
            song = th.get("song") or {}
            if not song.get("id"):
                continue
            out.append({
                "anime": anime.get("name"),
                "year": anime.get("year"),
                "slot": th.get("slug"),
                "song_id": song["id"],
                "title": song.get("title"),
                "artists": [],
            })

    def load_artists(entry: dict) -> None:
        d = _get_json(f"{AT}/song/{entry['song_id']}", {"include": "artists"})
        song = (d or {}).get("song") or {}
        entry["artists"] = [a["name"] for a in song.get("artists", [])]

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(load_artists, out))

    return out


# -------------------------------------------------------------- MusicBrainz

MB = "https://musicbrainz.org/ws/2"
# MusicBrainz impose 1 requete/seconde et un User-Agent identifiant.
MB_DELAY = 1.2


def musicbrainz_artists(title: str, anime: str) -> list[str]:
    """
    Repli quand AnimeThemes n'a pas l'artiste — lacune reelle et frequente sur
    les series anciennes (tout Cowboy Bebop est sans artiste).

    On recolte toutes les graphies vues sur les correspondances fortes : MB
    renvoie tantot le romaji, tantot le japonais ("Seatbelts" / "シートベルツ"),
    et disposer des deux ameliore le rapprochement avec la chaine YouTube.
    """
    # UNE seule requete, la plus contrainte. Elargir a recording:"titre" seul
    # ramenait les reprises (Platina Jazz sur "Gotta Knock a Little Harder")
    # et des homonymes (Xosar sur "Ask DNA"), qui devenaient ensuite des
    # correspondances d'artiste valides. Le rappel gagne, la precision meurt.
    data = _get_json(f"{MB}/recording", {
        "query": f'recording:"{title}" AND release:"{anime}"',
        "fmt": "json", "limit": 5,
    }, attempts=2)
    time.sleep(MB_DELAY)

    recordings = [r for r in (data or {}).get("recordings", [])
                  if (r.get("score") or 0) >= 95]
    if not recordings:
        return []

    # Le seul meilleur enregistrement. Accumuler les artistes de plusieurs
    # resultats gonfle le sac de noms, et plus le sac est gros, plus le test
    # d'artiste devient facile a satisfaire — donc inutile comme garde-fou.
    names, seen = [], set()
    for credit in recordings[0].get("artist-credit", []):
        if not isinstance(credit, dict):
            continue
        artist = credit.get("artist") or {}
        # name est souvent japonais, sort-name donne la forme latine. YouTube
        # nomme ses chaines en romaji : sans les deux graphies le
        # rapprochement echoue ("シートベルツ" vs "Seatbelts").
        for name in (artist.get("name"), artist.get("sort-name")):
            if name and name.lower() not in seen:
                seen.add(name.lower())
                names.append(name)
    return names


# ------------------------------------------------------------------ YouTube

def yt_search(query: str, kind: str = "music_songs") -> list[dict] | None:
    """None = l'API n'a jamais repondu. [] = elle a repondu, sans resultat."""
    url = f"{PIPED}/search?" + urllib.parse.urlencode({"q": query, "filter": kind})
    for i in range(SEARCH_ATTEMPTS):
        try:
            d = json.loads(_curl(url))
            if isinstance(d, dict) and d.get("items") is not None:
                return d["items"]
        except Exception:
            pass
        if i < SEARCH_ATTEMPTS - 1:
            time.sleep(BACKOFF_SECONDS)
    return None


def eligible(candidate: dict) -> str | None:
    """Filtres eliminatoires. Retourne le motif de rejet, ou None si le
    candidat reste en lice."""
    dur = candidate.get("duration") or 0
    if dur < MIN_FULL_SECONDS:
        return f"duree {dur}s < {MIN_FULL_SECONDS}s (TV size probable)"
    if dur > MAX_TRACK_SECONDS:
        return f"duree {dur}s : compilation, pas une piste"
    marker = has_bad_marker(candidate.get("title") or "")
    if marker:
        return f"marqueur de reprise/derive : '{marker}'"
    return None


def flatten(candidate: dict) -> dict:
    return {
        "title": candidate.get("title"),
        "channel": candidate.get("uploaderName"),
        "duration": candidate.get("duration"),
        "video_id": (candidate.get("url") or "").replace("/watch?v=", ""),
    }


def resolve_song(title: str, artists: list[str], context: str = "",
                 artist_trusted: bool = True) -> dict:
    """
    Deux requetes independantes, deux signaux independants.

    Le match de chaine seul ne suffit pas : quand la piste cherchée n'existe
    qu'en TV size, la recherche remonte d'AUTRES titres du meme artiste, qui
    passent chaine + duree sans probleme (mesure sur Chainsaw Man ED3, ou un
    morceau sans rapport a ete valide avec un score de 75).

    Le titre ne peut pas arbitrer non plus : sur les cas justes, "Jouzai" vs
    "錠剤" et "FightSong" vs "Fight Song" ont une similarite nulle, exactement
    comme le faux positif.

    D'ou le signal croise : une requete PAR ARTISTE et une requete PAR
    CONTEXTE doivent designer la meme video. Un titre absent du catalogue ne
    peut pas etre corrobore, alors qu'un titre present l'est quel que soit son
    alphabet.
    """
    artist = artists[0] if artists else ""
    if artist:
        q_artist = f"{artist} {title}".strip()
        q_context = " ".join(filter(None, [title, context])).strip()
    else:
        # Sans artiste de reference (frequent sur les series anciennes : tout
        # Cowboy Bebop est concerne), une requete sur le titre nu part a la
        # derive des que celui-ci est generique — "Blue" a ramene une pop song
        # recente sans rapport. On scope les DEUX requetes sur l'anime, en les
        # gardant distinctes pour que la corroboration garde un sens.
        q_artist = " ".join(filter(None, [title, context])).strip()
        q_context = " ".join(filter(None, [context, "opening ending theme",
                                           title])).strip()

    # Les deux requetes sont independantes : on les lance ensemble.
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_artist = ex.submit(yt_search, q_artist)
        f_context = (ex.submit(yt_search, q_context)
                     if q_context != q_artist else f_artist)
        by_artist, by_context = f_artist.result(), f_context.result()

    if by_artist is None:
        return {"verdict": "API_FAIL", "queries": [q_artist],
                "note": f"aucune reponse apres {SEARCH_ATTEMPTS} tentatives"}
    if by_context is None:
        by_context = []  # degrade : on perdra la corroboration, pas tout

    corroborated = {
        (c.get("url") or "").replace("/watch?v=", "") for c in by_context
    }

    scored = []
    for c in by_artist[:6]:
        flat = flatten(c)
        why = eligible(c)
        if why:
            scored.append({**flat, "verdict": "REJECT", "reasons": [why]})
            continue

        reasons = []
        am = artist_match(artists, c.get("uploaderName") or "")
        cross = flat["video_id"] in corroborated

        if am >= 1.0:
            reasons.append(f"chaine = artiste ({flat['channel']})")
        elif am >= 0.7:
            reasons.append(f"chaine proche de l'artiste ({flat['channel']})")
        else:
            reasons.append(f"chaine '{flat['channel']}' != artiste {artists}")

        reasons.append("corroboree par la 2e requete" if cross
                       else "NON corroboree par la 2e requete")

        ts = title_similarity(title, flat["title"] or "")
        # Seuil bas assume : "バイオレンス - VIOLENCE" ne recoupe le titre de
        # reference qu'a moitie, et c'est pourtant la bonne piste.
        strong_title = ts >= 0.4
        if ts > 0:
            reasons.append(f"titre proche ({ts:.2f})")
        else:
            reasons.append("titre divergent (romaji vs japonais : normal)")

        # Trois signaux, aucun suffisant seul.
        #
        #   artiste seul, sans rien d'autre  -> DANGER. C'est la signature du
        #   "bon artiste, mauvais morceau" : quand la piste cherchee n'existe
        #   pas en version longue, la recherche remonte le reste du catalogue
        #   de l'artiste, qui passe chaine et duree sans broncher.
        #
        #   corroboration sans artiste       -> alias probable (ZUTOMAYO pour
        #   "Zutto Mayonaka de Ii no ni.", QUEEN BEE pour "Ziyoou-vachi").
        #   Le morceau est generalement le bon, le nom seul differe.
        if am >= 0.7 and (strong_title or cross):
            verdict, sc = "OK", 100
        elif cross or strong_title:
            verdict, sc = "REVIEW", 60
        else:
            verdict, sc = "REJECT", 0
            reasons.append("artiste seul : insuffisant (mauvais morceau probable)")

        # Un artiste devine par MusicBrainz est une attribution de seconde
        # main : elle a deja produit trois faux OK confiants (Blue -> Farewell
        # Blues, Ask DNA -> Xosar, une reprise live sur Gotta Knock). On ne
        # laisse jamais ce chemin conclure seul.
        if verdict == "OK" and not artist_trusted:
            verdict, sc = "REVIEW", 60
            reasons.append("artiste issu de MusicBrainz : verification requise")

        scored.append({**flat, "verdict": verdict, "score": sc,
                       "artist_match": am, "corroborated": cross,
                       "title_match": round(ts, 2), "reasons": reasons})

    keep = [s for s in scored if s["verdict"] in ("OK", "REVIEW")]
    # Ordre des cles, chacune corrigeant une erreur mesuree :
    #   1. artiste — sinon un "Fight Song" d'un groupe sans rapport, au titre
    #      exact, double le "FightSong" d'Eve qui est la bonne reponse ;
    #   2. titre   — a artiste egal, departage le bon morceau des autres
    #      titres du meme artiste ("IRIS OUT" vs "JANE DOE") ;
    #   3. corroboration — tranche quand l'artiste est un alias non reconnu
    #      des deux cotes ("QUEEN BEE" vs un homonyme).
    keep.sort(key=lambda x: (-x["artist_match"],
                             -(x["title_match"] >= 0.4),
                             -int(x["corroborated"]),
                             -x["title_match"]))

    if not keep:
        return {"verdict": "ABSENT", "queries": [q_artist, q_context],
                "note": "candidats tous rejetes", "rejected": scored[:3]}
    return {"verdict": keep[0]["verdict"], "queries": [q_artist, q_context],
            "best": keep[0], "runners_up": keep[1:3]}


def resolve_album(name: str) -> dict:
    items = yt_search(name, kind="music_albums")
    if items is None:
        return {"verdict": "API_FAIL", "query": name}
    if not items:
        return {"verdict": "ABSENT", "query": name}
    top = items[0]
    return {"verdict": "OK", "query": name, "best": {
        "title": top.get("name") or top.get("title"),
        "channel": top.get("uploaderName"),
        "playlist_id": (top.get("url") or "").replace("/playlist?list=", ""),
    }}


# --------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("query", help="nom de l'anime, ou de l'album avec --album")
    ap.add_argument("--album", action="store_true", help="resoudre un album")
    ap.add_argument("--json", metavar="FICHIER", help="ecrire le detail en JSON")
    ap.add_argument("--context", default="", help="terme ajoute a la recherche")
    ap.add_argument("--no-musicbrainz", action="store_true",
                    help="ne pas chercher l'artiste manquant sur MusicBrainz")
    ap.add_argument("--from-json", metavar="FICHIER",
                    help="lire titres/artistes depuis aniplaylist-scrape.mjs "
                         "au lieu d'AnimeThemes")
    args = ap.parse_args()

    if args.album:
        r = resolve_album(args.query)
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return 0

    if args.from_json:
        # Source AniPlaylist : elle nomme les artistes comme YouTube
        # ("QUEEN BEE", pas "Ziyoou-vachi"), ce qui supprime les alias qui
        # bloquaient des titres en REVIEW avec les noms d'AnimeThemes. Elle
        # couvre en plus les OST, insert et theme songs, absents d'AnimeThemes.
        with open(args.from_json, encoding="utf-8") as fh:
            brut = json.load(fh)
        themes = [{
            "anime": e.get("anime") or args.query,
            "year": None,
            "slot": (e.get("type") or "?")[:9],
            "song_id": None,
            "title": e.get("titre"),
            "artists": [e["artiste"]] if e.get("artiste") else [],
            "kind": e.get("type"),
        } for e in brut if e.get("titre")]
        if not themes:
            print(f"Aucune entree exploitable dans {args.from_json}.")
            return 1
    else:
        themes = fetch_themes(args.query)
        if not themes:
            print(f"Aucun theme trouve pour « {args.query} » sur AnimeThemes.")
            return 1
        for t in themes:
            t["kind"] = None

    print(f"{len(themes)} theme(s) — resolution en cours\n")
    counts = {}

    def work(t: dict) -> dict:
        # Le contexte doit differer de la requete par artiste, sinon les deux
        # recherches sont identiques et la corroboration ne prouve rien.
        context = args.context or t["anime"]

        t["artist_source"] = "animethemes" if t["artists"] else None
        if not t["artists"] and not args.no_musicbrainz:
            t["artists"] = musicbrainz_artists(t["title"], t["anime"])
            if t["artists"]:
                t["artist_source"] = "musicbrainz"

        # Les entrees "OST" d'AniPlaylist sont des ALBUMS, pas des pistes.
        # Les chercher en chanson produit un faux positif credible : sur
        # "chainsaw edge fragments" la recherche renvoyait "edge of chainsaw",
        # meme compositeur et duree plausible, donc validable a tort.
        if t.get("kind") == "OST":
            artiste = t["artists"][0] if t["artists"] else ""
            r = resolve_album(f"{t['title']} {artiste}".strip())
        else:
            r = resolve_song(t["title"], t["artists"], context,
                             artist_trusted=(t["artist_source"] != "musicbrainz"))
        r["artist_source"] = t["artist_source"]
        r.update({k: t[k] for k in ("anime", "slot", "title", "artists")})
        return r

    # Chaque piste est independante des autres : rien a serialiser.
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        results = list(ex.map(work, themes))
    elapsed = time.perf_counter() - started

    # L'affichage se fait apres coup, dans l'ordre des slots : des threads qui
    # ecrivent en concurrence entrelacent leurs lignes et rendent le rapport
    # illisible.
    for r in results:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
        mark = {"OK": "OK   ", "REVIEW": "REVUE", "ABSENT": "ABSENT",
                "API_FAIL": "API!!"}[r["verdict"]]
        art = ", ".join(r["artists"]) or "?"
        src = {"musicbrainz": " (via MB)", "animethemes": "",
               None: ""}[r["artist_source"]]
        print(f"[{mark}] {r['slot']:5} {r['title']} — {art}{src}")
        if r.get("best"):
            b = r["best"]
            if b.get("playlist_id"):          # album
                print(f"          {b['title']} | {b['channel']} "
                      f"| playlist {b['playlist_id']}")
            else:                             # piste
                print(f"          {b['title']} | {b['channel']} | {b['duration']}s "
                      f"| {b['video_id']} (score {b['score']})")
        elif r.get("rejected"):
            for x in r["rejected"][:2]:
                print(f"          rejete: {x['title']} | {x['channel']} "
                      f"| {x['reasons'][0]}")

    total = len(results)
    print(f"\n{'='*64}\nBILAN {results[0]['anime']} — {total} theme(s)")
    for v in ("OK", "REVIEW", "ABSENT", "API_FAIL"):
        if counts.get(v):
            print(f"  {v:9} {counts[v]:3}  ({counts[v]*100//total} %)")
    print(f"  {'temps':9} {elapsed:6.1f} s  ({elapsed/total:.2f} s/piste)")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(results, fh, ensure_ascii=False, indent=1)
        print(f"\nDetail ecrit dans {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
