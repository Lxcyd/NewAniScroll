#!/usr/bin/env python3
"""
Les BGM (bande originale) d'un anime, en version COMPLETE sur YouTube.

    python bgm.py --ids 1535,16498                # des animes precis
    python bgm.py --top 120 --skip-file done.json # les plus populaires pas faits
    python bgm.py ... --out bgm.jsonl             # une ligne par anime

Pose le 26/11/2026 (Luc) : « L no Theme » manquait au studio, alors que MKissa
l'a. AnimeThemes, AnisongDB et AniPlaylist ne connaissent que les morceaux
CHANTES (OP/ED/inserts) ; la musique de fond, personne. MKissa (famille
AllAnime) l'heberge lui-meme derriere un defi Cloudflare : rien de reutilisable.

LA CHAINE, et ce que chaque etape refuse :

  1. AniList : les compositeurs (role « Music » exactement — pas « Music
     Producer », pas « Sound Director »). Sans compositeur : rien.
  2. Deezer : les albums dont l'ARTISTE est un compositeur ET dont le titre
     contient un titre de l'anime. Les deux, sinon Death Note prend « SOUND of
     DEATH NOTE » (Kenji Kawai, le film) ou une OST fan-made.
  3. Deezer : leurs pistes JOUEES PAR un compositeur — ecarte les OP/ED
     glisses dans l'album (« the WORLD (TV Size) », Nightmare). Le `rank` de
     Deezer donne l'ordre : L no Theme, Light no Theme, Kyrie en tete.
  4. YouTube (Piped, resolve.py) : la piste chez la chaine du compositeur
     (« Topic » du label), a ±2 s de la DUREE Deezer — meme master, meme
     duree a la seconde (L no Theme : 184 s des deux cotes). Plus le titre
     proche, ou corroboree par une 2e requete. Trois signaux, comme resolve.py.

Seuls les OK sortent : une piste douteuse n'est pas servie, elle manque.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from resolve import (
    UA, _get_json, has_bad_marker, title_similarity, yt_search, flatten,
)

ALGO = 1
DZ = "https://api.deezer.com"
ANILIST = "https://graphql.anilist.co"
# Une OST complete fait 30 a 90 pistes ; a deux recherches Piped par piste,
# le tout coute trop a une instance benevole. Les plus ecoutees suffisent.
MAX_TRACKS = 30
DUR_TOL = 2
WORKERS = 6


def flat(s: str) -> str:
    """Pour comparer des titres d'album : SANS retirer les parentheses
    (« Death Note (Original Soundtrack) » garde son nom), ni les espaces."""
    s = unicodedata.normalize("NFKC", s or "").lower()
    return re.sub(r"[^\w]+", "", s, flags=re.UNICODE)


# ------------------------------------------------------------------ AniList

Q_MEDIA = """query($ids:[Int],$page:Int,$per:Int){Page(page:$page,perPage:$per){
 media(id_in:$ids,type:ANIME,sort:POPULARITY_DESC){id title{romaji english native} synonyms
 staff(perPage:50,sort:RELEVANCE){edges{role node{name{full native alternative}}}}}}}"""


def anilist(variables: dict) -> list[dict]:
    body = json.dumps({"query": Q_MEDIA, "variables": variables}).encode()
    for i in range(4):
        # Sans User-Agent, celui de urllib est refuse (Cloudflare 1010).
        req = urllib.request.Request(ANILIST, data=body, headers={
            "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)["data"]["Page"]["media"]
        except urllib.error.HTTPError as e:
            # 429 : 30 points/min depuis le 23/11/2026. Attendre, pas forcer.
            wait = int(e.headers.get("Retry-After") or 30) if e.code == 429 else 5
            time.sleep(wait)
        except Exception:
            time.sleep(5)
    return []


def as_anime(m: dict) -> dict:
    t = m.get("title") or {}
    composers = []
    for e in (m.get("staff") or {}).get("edges", []):
        # « Music », « Music (eps 1-12) » ; pas « Music Producer ».
        if not re.match(r"^Music\s*(\(|$)", e.get("role") or ""):
            continue
        n = (e.get("node") or {}).get("name") or {}
        names = [x for x in [n.get("full"), n.get("native"), *(n.get("alternative") or [])] if x]
        if names:
            composers.append(names)
    titles = [x for x in [t.get("romaji"), t.get("english"), t.get("native"),
                          *(m.get("synonyms") or [])] if x]
    return {"id": m["id"], "title": t.get("romaji") or t.get("english") or "",
            "titles": titles, "composers": composers}


# ------------------------------------------------------------------- Deezer

def dz(path: str, params: dict | None = None):
    d = _get_json(f"{DZ}{path}", params)
    # Deezer rend {"error": {"code": 4}} quand on va trop vite (50 / 5 s).
    if isinstance(d, dict) and d.get("error"):
        time.sleep(5)
        d = _get_json(f"{DZ}{path}", params)
    return d if isinstance(d, dict) and not d.get("error") else None


def spaced(s: str) -> str:
    # « HUNTER×HUNTER » (AniList) = « HUNTER x HUNTER » (Deezer).
    s = unicodedata.normalize("NFKC", s or "").lower().replace("×", " x ")
    return " " + re.sub(r"\s+", " ", re.sub(r"[^\w]+", " ", s, flags=re.UNICODE)).strip() + " "


KATA = re.compile(r"^[゠-ヿー・]+$")


def title_keys(titles: list[str]) -> list[str]:
    """Les titres, plus deux variantes mesurees : sans l'annee entre
    parentheses (« HUNTER×HUNTER (2011) » -> l'album « HUNTER x HUNTER ») et le
    natif sans sa lecture en katakana (« 東京喰種 トーキョーグール » -> l'album
    « TVアニメ『東京喰種』 »). PAS la tete avant « : » : « Shingeki no Kyojin:
    The Final Season » prendrait alors les OST de la saison 1."""
    out = []
    for t in titles:
        out.append(t)
        out.append(re.sub(r"\s*\(\d{4}\)\s*$", "", t))
        parts = unicodedata.normalize("NFKC", t).split()
        if len(parts) == 2 and KATA.match(parts[1]):
            out.append(parts[0])
    keys = [spaced(k) for k in dict.fromkeys(out)]
    return [k for k in keys if len(k.strip()) >= 2]


def romaji(name: str) -> set[str]:
    """Les voyelles longues repliees : AniList ecrit « Yuuki Hayashi »,
    « Kenichirou Suehiro », Deezer « Yuki », « Kenichiro »."""
    s = unicodedata.normalize("NFKC", name or "").lower()
    s = re.sub(r"\s*-\s*topic\s*$", "", s)
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
    s = re.sub(r"ou(?=\b|[^aeiou])", "o", s)
    s = s.replace("uu", "u").replace("oo", "o")
    return set(s.split())


# CE QUI PEUT ENTOURER LE TITRE DE L'ANIME dans le nom d'une OST, et rien
# d'autre. Mesure le 26/11/2026 sur Jujutsu Kaisen (saison 1) : « Jujutsu
# Kaisen Hidden Inventory/Premature Death - OST » (saison 2) et « Jujutsu Kaisen
# Phantom Parade OST » (le jeu) contiennent le titre ET sont de bons
# compositeurs. Ce qui reste du nom une fois le titre retire doit etre
# generique : un sous-titre, c'est une autre oeuvre (son propre id AniList).
GENERIC = set("""tv anime animation original soundtrack soundtracks ost o s t sound track
tracks music musics bgm score collection complete selection best vol volume disc cd part
the of from and series motion picture edition deluxe expanded version full ep episode episodes
tvアニメ アニメ tvアニメーション オリジナル サウンドトラック オリジナルサウンドトラック
サントラ サウンド トラック 音楽 音楽集 劇伴 劇伴集 コレクション ミュージック テレビ""".split())
# Passe ce mot, le reste est le SOUS-TITRE DE L'ALBUM, libre : « Chainsaw Man
# Original Soundtrack Complete Edition - chainsaw edge fragments - », « TVアニメ
# 『ワンパンマン』オリジナルサウンドトラック「ONE TAKE MAN」 ». Avant lui, un mot
# non generique est un sous-titre d'OEUVRE (« Phantom Parade », « The Movie:
# Reze Arc ») : refuse.
OST_WORD = set("soundtrack soundtracks ost track サウンドトラック オリジナルサウンドトラック サントラ 劇伴 劇伴集 音楽集".split())
ROMAN = re.compile(r"^(i{1,3}|iv|v|vi{0,3}|ix|x)$")


def generic_rest(album: str, keys: list[str]) -> bool:
    a = spaced(album)
    # Le titre le plus LONG qui y figure : un synonyme « Jujutsu Kaisen: Hidden
    # Inventory » laisse « original soundtrack », la ou « Jujutsu Kaisen » seul
    # laisserait le sous-titre.
    hit = max((k for k in keys if k in a), key=len, default=None)
    if not hit:
        return False
    for w in a.replace(hit, " ").split():
        # « サウンドトラックcd » : le japonais colle le mot qui suit.
        if any(w.startswith(o) for o in OST_WORD):
            return True
        if not (w in GENERIC or w.isdigit() or ROMAN.match(w)):
            return False
    return True


def name_match(refs: list[str], name: str) -> float:
    """artist_match de resolve.py, voyelles longues repliees."""
    ch = romaji(name)
    if not ch:
        return 0.0
    best = 0.0
    for r in refs:
        a = romaji(r)
        if not a:
            continue
        if a == ch:
            return 1.0
        # Un seul jeton court (« ano ») : egalite stricte, comme resolve.py.
        if len(a) == 1 and len(next(iter(a))) <= 4:
            continue
        if a <= ch or ch <= a:
            best = 0.7
    return best


def is_composer(name: str, anime: dict) -> bool:
    return any(name_match(names, name) >= 0.7 for names in anime["composers"])


def albums_of(anime: dict) -> list[dict]:
    keys = title_keys(anime["titles"])
    queries = list(dict.fromkeys(anime["titles"][:3] + [c[0] for c in anime["composers"]]))
    found: dict[int, dict] = {}
    for q in queries:
        d = dz("/search/album", {"q": q, "limit": 50})
        for a in (d or {}).get("data", []):
            name = a.get("title") or ""
            if a["id"] in found or (a.get("nb_tracks") or 0) < 4:
                continue  # un single d'OP n'est pas une OST
            if not is_composer((a.get("artist") or {}).get("name") or "", anime):
                continue
            if not generic_rest(name, keys):
                continue
            found[a["id"]] = {"id": a["id"], "title": name,
                              "cover": a.get("cover_medium")}
    return list(found.values())


def tracks_of(anime: dict, albums: list[dict]) -> list[dict]:
    out: dict[str, dict] = {}
    for al in albums:
        d = dz(f"/album/{al['id']}/tracks", {"limit": 200})
        for t in (d or {}).get("data", []):
            title = t.get("title") or ""
            artist = (t.get("artist") or {}).get("name") or ""
            if not is_composer(artist, anime) or has_bad_marker(title):
                continue
            k = flat(title)
            prev = out.get(k)
            if prev and (prev["r"] or 0) >= (t.get("rank") or 0):
                continue
            out[k] = {"t": title, "a": artist, "d": t.get("duration") or 0,
                      "r": t.get("rank") or 0, "al": al["title"],
                      "c": (al.get("cover") or "").replace("/250x250-", "/120x120-") or None}
    return sorted(out.values(), key=lambda x: -x["r"])[:MAX_TRACKS]


# ------------------------------------------------------------------ YouTube

def resolve_track(tr: dict, anime: dict) -> dict | None:
    composers = [n for names in anime["composers"] for n in names]

    def good(c: dict) -> tuple[float, float] | None:
        f = flatten(c)
        if abs((f["duration"] or 0) - tr["d"]) > DUR_TOL or has_bad_marker(f["title"] or ""):
            return None
        am = max(name_match([tr["a"]], f["channel"] or ""), name_match(composers, f["channel"] or ""))
        if am < 0.7:
            return None
        return am, title_similarity(tr["t"], f["title"] or "")

    first = yt_search(f"{tr['a']} {tr['t']}") or []
    cands = [(c, good(c)) for c in first[:6]]
    cands = [(c, g) for c, g in cands if g]
    # Chaine + duree a la seconde + titre : assez de signaux, pas de 2e requete.
    strong = [(c, g) for c, g in cands if g[1] >= 0.3]
    if strong:
        best = max(strong, key=lambda x: (x[1][0], x[1][1]))[0]
        return flatten(best)
    if not cands:
        return None
    # Titre divergent (romaji / japonais) : il faut la corroboration.
    other = yt_search(f"{tr['t']} {anime['title']}") or []
    ids = {flatten(c)["video_id"] for c in other}
    cross = [(c, g) for c, g in cands if flatten(c)["video_id"] in ids]
    return flatten(cross[0][0]) if cross else None


def run_anime(anime: dict) -> dict:
    row = {"ani_id": anime["id"], "algo": ALGO, "tracks": [], "cand": 0, "albums": []}
    if not anime["composers"]:
        return row
    albums = albums_of(anime)
    row["albums"] = [a["title"] for a in albums]
    tracks = tracks_of(anime, albums)
    row["cand"] = len(tracks)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        hits = list(ex.map(lambda t: resolve_track(t, anime), tracks))
    seen = set()
    for tr, hit in zip(tracks, hits):
        # Une meme video sous deux titres (AoT : « Attack on Titan » et
        # « ətˈæk 0N tάɪtn ») : la plus ecoutee seulement, l'ordre est le rang.
        if hit and re.fullmatch(r"[A-Za-z0-9_-]{11}", hit["video_id"] or "") and hit["video_id"] not in seen:
            seen.add(hit["video_id"])
            row["tracks"].append({**tr, "y": hit["video_id"]})
    return row


# --------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", help="ids AniList, separes par des virgules")
    ap.add_argument("--top", type=int, help="les N plus populaires pas encore faits")
    ap.add_argument("--skip-file", help="JSON : ids deja traites")
    ap.add_argument("--refresh-file", help="JSON : ids a refaire d'abord (anime en cours, "
                                           "cf. scripts/music/import-anime-bgm.mjs)")
    ap.add_argument("--out", default="bgm.jsonl")
    args = ap.parse_args()

    skip = set()
    if args.skip_file:
        with open(args.skip_file, encoding="utf-8") as fh:
            skip = set(json.load(fh))

    def by_ids(ids: list[int]) -> list[dict]:
        out = []
        for i in range(0, len(ids), 50):
            out += [as_anime(m) for m in anilist({"ids": ids[i:i + 50], "page": 1, "per": 50})]
            time.sleep(2.5)
        return out

    # Les rafraichissements passent AVANT la tranche des nouveaux, en plus d'elle.
    first: list[dict] = []
    if args.refresh_file:
        with open(args.refresh_file, encoding="utf-8") as fh:
            ids = [int(x) for x in json.load(fh)]
        first = by_ids(ids)
        skip |= set(ids)

    todo: list[dict] = []
    if args.ids:
        todo = by_ids([int(x) for x in args.ids.split(",") if x.strip()])
    elif args.top:
        page = 1
        while len(todo) < args.top and page < 400:
            batch = anilist({"page": page, "per": 50})
            if not batch:
                break
            todo += [as_anime(m) for m in batch if m["id"] not in skip]
            page += 1
            time.sleep(2.5)  # 30 points/min
        todo = todo[:args.top]
    elif not first:
        ap.error("--ids, --top ou --refresh-file")
    todo = first + todo

    n_ok = 0
    with open(args.out, "a", encoding="utf-8") as fh:
        for a in todo:
            t0 = time.perf_counter()
            row = run_anime(a)
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()
            n_ok += len(row["tracks"])
            print(f"{a['id']:>7} {a['title'][:40]:40} {len(row['tracks']):>2}/{row['cand']:<2} "
                  f"({len(row['albums'])} album(s), {time.perf_counter() - t0:.0f} s)", flush=True)
    print(f"\n{len(todo)} anime(s), {n_ok} BGM resolue(s) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
