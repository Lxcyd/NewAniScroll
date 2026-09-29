"""Fenetres HLS materialisees en local : segments paralleles, en cache, au plus bas debit.

Pourquoi (mesure du 28/09/2026, JJK ep3 VOSTFR, vidmoly-va) : ffmpeg lit un
HLS distant segment par segment, sur le rendu le plus LOURD du maitre (1080p,
1,9 Mb/s). Une fenetre de 12 min a pris ~8 min. Les memes 36 segments en 480p,
8 a la fois : ~15 s. Et chaque fenetre etait retelechargee : la passe 0-300 s
suivant une passe 0-720 s repayait tout, faute de cache autre que par fenetre
exacte.

Ce module :
  1. lit le maitre et choisit le rendu au PLUS BAS debit — l'empreinte image
     travaille en 32x18 et l'audio a 11 kHz, le 1080p n'apporte rien ;
  2. telecharge les segments couvrant la fenetre EN PARALLELE, un fichier par
     segment, en cache disque : toute fenetre ulterieure (autre passe, audio vs
     image, re-run) ne telecharge que ce qui manque ;
  3. concatene les segments en un .ts local. La concatenation binaire garde les
     PTS d'origine, donc l'horloge absolue `-copyts` du detecteur ne bouge pas
     (meme principe que `oped.megaplay`, dont les segments sont deballes ici).

Il REFUSE (renvoie None, l'appelant retombe sur ffmpeg direct) tout ce qu'une
concatenation binaire trahirait : segments chiffres (EXT-X-KEY), segments fMP4
(EXT-X-MAP), plages d'octets (EXT-X-BYTERANGE), audio en rendu separe
(EXT-X-MEDIA TYPE=AUDIO avec URI — frembed et ses pistes fr/ja).
"""

from __future__ import annotations

import hashlib
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from .megaplay import depng, is_megaplay

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
SEG_DIR = Path(os.environ.get("OPED_HLS_CACHE", "cache/hls"))
BUDGET_BYTES = int(float(os.environ.get("OPED_HLS_CACHE_GB", "40")) * 1024 ** 3)
# Telechargements simultanes PAR fenetre, et plafond global par domaine : le
# batch lance plusieurs hotes et episodes en parallele, et un CDN qui voit 40
# connexions d'une meme IP finit par couper.
WORKERS = int(os.environ.get("OPED_HLS_WORKERS", "8"))
_PER_DOMAIN = int(os.environ.get("OPED_HLS_PER_DOMAIN", "12"))
_domain_sems: dict[str, threading.BoundedSemaphore] = {}
_domain_lock = threading.Lock()
THROTTLE_RETRIES = 6
_BW = re.compile(r"BANDWIDTH=(\d+)")


@dataclass
class _Playlist:
    key: str                                   # identite stable du rendu
    segments: list[tuple[str, float, float]]   # (url, debut, fin) cumules
    init: str | None = None                    # EXT-X-MAP (fMP4) : a mettre en tete
    ext: str = ".ts"


_playlists: dict[tuple[str, str], _Playlist | None] = {}
_pl_lock = threading.Lock()


def _sem(url: str) -> threading.BoundedSemaphore:
    host = urllib.parse.urlsplit(url).hostname or ""
    with _domain_lock:
        if host not in _domain_sems:
            _domain_sems[host] = threading.BoundedSemaphore(_PER_DOMAIN)
        return _domain_sems[host]


def _fetch(url: str, referer: str | None, tries: int = 3) -> bytes:
    headers = {"User-Agent": _UA}
    if referer:
        headers["Referer"] = referer
    last: Exception | None = None
    k = throttled = 0
    while k < tries:
        try:
            with _sem(url):
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=60) as r:
                    return r.read()
        except urllib.error.HTTPError as exc:
            last = exc
            # 429 : le CDN demande de ralentir, ce n'est pas une panne. La v2 lit
            # des episodes COMPLETS (megaplay : 429 des le premier lot) ; on
            # attend (Retry-After sinon 5/10/20/40 s) sans consommer d'essai.
            if exc.code == 429 and throttled < THROTTLE_RETRIES:
                wait = exc.headers.get("Retry-After")
                time.sleep(float(wait) if wait and wait.isdigit() else min(60.0, 5.0 * 2 ** throttled))
                throttled += 1
                continue
            k += 1
            time.sleep(1.5 * k)
        except Exception as exc:  # reseau : on reessaie avant d'abandonner
            last = exc
            k += 1
            time.sleep(1.5 * k)
    raise RuntimeError(f"segment injoignable apres {tries} essais: {url[:120]} ({last})")


def _stable_key(url: str) -> str:
    """Identite d'un rendu SANS son jeton : le chemin survit a une nouvelle
    resolution (le jeton tourne toutes les 12 h), donc le cache aussi."""
    p = urllib.parse.urlsplit(url)
    return hashlib.sha1(f"{p.hostname}{p.path}".encode()).hexdigest()[:20]


def _load_playlist(master_url: str, referer: str | None, want: str) -> _Playlist | None:
    k = (master_url, want)
    with _pl_lock:
        if k in _playlists:
            return _playlists[k]
    pl = _parse(master_url, referer, want)
    with _pl_lock:
        _playlists[k] = pl
    return pl


def _attr(line: str, name: str) -> str | None:
    m = re.search(name + r'=("([^"]*)"|[^,]*)', line)
    return None if not m else (m.group(2) if m.group(2) is not None else m.group(1))


def _parse(master_url: str, referer: str | None, want: str) -> _Playlist | None:
    """`want` = "audio" (empreinte audio) ou "video" (empreinte image).

    Maitre a audio MUXE : les deux prennent le rendu video le plus leger (il
    porte le son). Maitre a audio SEPARE (EXT-X-MEDIA TYPE=AUDIO, frembed) :
    l'audio prend son propre rendu — quelques Ko par segment au lieu des 13 Mb/s
    du seul rendu video de frembed — et l'image le rendu video, muet."""
    text = _fetch(master_url, referer).decode("utf-8", "replace")
    media_url = master_url
    if "#EXT-X-STREAM-INF" in text:
        lines = text.splitlines()
        audios = [l for l in lines
                  if l.startswith("#EXT-X-MEDIA") and "TYPE=AUDIO" in l and "URI=" in l]
        if want == "audio" and audios:
            pick = (next((a for a in audios if (_attr(a, "DEFAULT") or "").upper() == "YES"), None)
                    or next((a for a in audios if (_attr(a, "LANGUAGE") or "").lower().startswith("ja")), None)
                    or audios[0])
            media_url = urllib.parse.urljoin(master_url, _attr(pick, "URI"))
        else:
            best: tuple[int, str] | None = None
            for i, line in enumerate(lines):
                if not line.startswith("#EXT-X-STREAM-INF"):
                    continue
                codecs = re.search(r'CODECS="([^"]*)"', line)
                if codecs and not re.search(r"avc|hvc|hev|av01|vp0?9", codecs.group(1)):
                    continue  # rendu audio seul : l'empreinte image n'aurait rien a lire
                m = _BW.search(line)
                bw = int(m.group(1)) if m else 1 << 60
                nxt = next((x.strip() for x in lines[i + 1:] if x.strip() and not x.startswith("#")), None)
                if nxt and (best is None or bw < best[0]):
                    best = (bw, urllib.parse.urljoin(master_url, nxt))
            if not best:
                return None
            media_url = best[1]
        text = _fetch(media_url, referer).decode("utf-8", "replace")
    if "#EXT-X-BYTERANGE" in text:
        return None
    for line in text.splitlines():
        if line.startswith("#EXT-X-KEY") and "METHOD=NONE" not in line:
            return None
    init = None
    for line in text.splitlines():
        if line.startswith("#EXT-X-MAP"):
            if "BYTERANGE" in line:
                return None
            init = urllib.parse.urljoin(media_url, _attr(line, "URI") or "")
            break
    segs: list[tuple[str, float, float]] = []
    t, d = 0.0, None
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#EXTINF:"):
            try:
                d = float(s[8:].split(",")[0])
            except ValueError:
                d = None
        elif s and not s.startswith("#"):
            dd = d if d is not None else 4.0
            segs.append((urllib.parse.urljoin(media_url, s), t, t + dd))
            t += dd
            d = None
    if not segs:
        return None
    # fMP4 : init + fragments concatenes = un MP4 fragmente valide, dont
    # chaque fragment garde son temps de decodage (tfdt) -> meme horloge.
    return _Playlist(key=_stable_key(media_url), segments=segs, init=init,
                     ext=".mp4" if init else ".ts")


def _segment_file(pl: _Playlist, idx: int, url: str, referer: str | None,
                  megaplay: bool) -> Path:
    d = SEG_DIR / pl.key
    d.mkdir(parents=True, exist_ok=True)
    f = d / (f"{idx:05d}.seg" if idx >= 0 else "init.seg")
    if f.exists() and f.stat().st_size > 0:
        return f
    data = _fetch(url, referer)
    if megaplay:
        data = depng(data)
    tmp = f.with_suffix(f".part{threading.get_ident()}")
    tmp.write_bytes(data)
    tmp.replace(f)
    return f


def playlist_duration(master_url: str, *, referer: str | None = None,
                      want: str = "audio") -> float | None:
    """Duree totale (somme des EXTINF du rendu choisi), sans ffprobe. None si
    ce flux n'est pas materialisable."""
    # Jamais sur autre chose qu'une playlist : appele sur un MP4 sibnet, ceci
    # telechargeait les 275 Mo du fichier en le prenant pour du texte.
    if not master_url.lower().split("?", 1)[0].endswith(".m3u8") or not master_url.startswith("http"):
        return None
    pl = _load_playlist(master_url, referer, want)
    return pl.segments[-1][2] if pl else None


def local_window(master_url: str, start_abs: float, dur: float | None, *,
                 referer: str | None = None, want: str = "audio") -> str | None:
    """Chemin d'un fichier local couvrant [start_abs, start_abs+dur] (dur None =
    jusqu'a la fin), ou None si le flux ne se prete pas a une concatenation.

    Un segment de marge AVANT la fenetre : `-ss` a besoin d'une image-cle a ou
    avant le point de recherche, et un segment HLS commence sur une image-cle."""
    if os.environ.get("OPED_HLS_LOCAL", "1") == "0":
        return None  # interrupteur : retour au decodage ffmpeg direct
    if not master_url.lower().split("?", 1)[0].endswith(".m3u8") or not master_url.startswith("http"):
        return None
    pl = _load_playlist(master_url, referer, want)
    if pl is None:
        return None
    lo = max(0.0, start_abs)
    hi = float("inf") if dur is None else start_abs + dur
    idx = [i for i, (_, s0, s1) in enumerate(pl.segments) if s1 > lo and s0 < hi]
    if not idx:
        idx = [len(pl.segments) - 1]
    i0, i1 = max(0, idx[0] - 1), idx[-1]
    out = SEG_DIR / pl.key / f"win_{i0:05d}_{i1:05d}{pl.ext}"
    if out.exists() and out.stat().st_size > 0:
        return str(out)
    mp = is_megaplay(master_url, referer)
    jobs = [(i, pl.segments[i][0]) for i in range(i0, i1 + 1)]
    if pl.init:
        jobs.insert(0, (-1, pl.init))
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        files = list(pool.map(lambda j: _segment_file(pl, j[0], j[1], referer, mp), jobs))
    tmp = out.with_suffix(f".part{threading.get_ident()}")
    with open(tmp, "wb") as w:
        for f in files:
            w.write(f.read_bytes())
    tmp.replace(out)
    _prune()
    return str(out)


# ── MP4 direct (sibnet) ───────────────────────────────────────────────────────
# sibnet bride CHAQUE connexion : 0,29 Mo/s seule, 2,3 Mo/s a 8 plages en
# parallele (mesure le 28/09). ffmpeg, lui, lit en une connexion : une fenetre
# image de 98 s depassait le delai de 480 s. Un MP4 ne se decoupe pas par
# temps sans lire son index, donc on rapatrie le fichier ENTIER, par plages
# paralleles, une fois par (episode, hote) : ~2 min pour 275 Mo, puis toutes
# les fenetres (audio, image, planches) sont locales.
# uqload est exclu : son jeton ne vaut qu'une fois par IP.
MP4_CHUNK = 8 * 1024 * 1024
_MP4_EXCLUDE = ("uqload",)
_mp4_locks: dict[str, threading.Lock] = {}


def _content_length(url: str, referer: str | None) -> int | None:
    headers = {"User-Agent": _UA, "Range": "bytes=0-0"}
    if referer:
        headers["Referer"] = referer
    try:
        with _sem(url):
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
                cr = r.headers.get("Content-Range") or ""
                if r.status != 206 or "/" not in cr:
                    return None
                return int(cr.rsplit("/", 1)[1])
    except Exception:
        return None


def _range(url: str, referer: str | None, a: int, b: int) -> bytes:
    headers = {"User-Agent": _UA, "Range": f"bytes={a}-{b}"}
    if referer:
        headers["Referer"] = referer
    last: Exception | None = None
    for k in range(4):
        try:
            with _sem(url):
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r:
                    data = r.read()
            if len(data) == b - a + 1:
                return data
            last = RuntimeError(f"plage incomplete {len(data)}/{b - a + 1}")
        except Exception as exc:
            last = exc
        time.sleep(2 * (k + 1))
    raise RuntimeError(f"plage {a}-{b} injoignable: {last}")


def local_mp4(url: str, *, referer: str | None = None) -> str | None:
    """Copie locale complete d'un MP4 distant, ou None (pas du MP4 http, hote
    exclu, serveur sans plages d'octets)."""
    if os.environ.get("OPED_HLS_LOCAL", "1") == "0":
        return None
    path = urllib.parse.urlsplit(url).path.lower()
    if not url.startswith("http") or not path.endswith(".mp4"):
        return None
    if any(h in (urllib.parse.urlsplit(url).hostname or "") for h in _MP4_EXCLUDE):
        return None
    key = _stable_key(url)
    d = SEG_DIR / key
    out = d / "full.mp4"
    with _domain_lock:
        lock = _mp4_locks.setdefault(key, threading.Lock())
    with lock:  # audio et image du meme episode demandent le meme fichier
        if out.exists() and out.stat().st_size > 0:
            return str(out)
        size = _content_length(url, referer)
        if not size:
            return None
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f"full.part{threading.get_ident()}"
        spans = [(a, min(a + MP4_CHUNK, size) - 1) for a in range(0, size, MP4_CHUNK)]
        with open(tmp, "wb") as w:
            w.truncate(size)
        wlock = threading.Lock()

        def get(span):
            data = _range(url, referer, *span)
            with wlock, open(tmp, "r+b") as w:
                w.seek(span[0])
                w.write(data)

        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            list(pool.map(get, spans))
        tmp.replace(out)
    _prune()
    return str(out)


_prune_lock = threading.Lock()


def _prune() -> None:
    """Budget disque : les fichiers les plus anciens partent d'abord. Tout est
    regenerable depuis le flux ; le lot du 07/08 avait rempli le disque (68 Go)
    faute de purge."""
    with _prune_lock:
        # Un instantane (chemin, taille, date) pris UNE fois, en ignorant les
        # fichiers temporaires et ceux qui disparaissent entre la liste et la
        # lecture : d'autres threads renomment leurs `.part*` pendant ce temps.
        # Relire `stat()` plus bas levait FileNotFoundError, remontait dans le
        # thread qui avait pourtant reussi son telechargement et lui faisait
        # perdre son calage image (9 cellules du lot gt10 du 28/09).
        snap = []
        for p in SEG_DIR.rglob("*"):
            if ".part" in p.name:
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            if p.is_file():
                snap.append((p, st.st_size, st.st_mtime))
        total = sum(s for _, s, _ in snap)
        if total <= BUDGET_BYTES:
            return
        # Jamais un fichier recent : il peut etre en cours de lecture par un
        # autre thread (28/09 : une purge a efface une fenetre sous les pieds du
        # calage image -> FileNotFoundError).
        young = time.time() - 1800
        for p, size, mtime in sorted(snap, key=lambda x: x[2]):
            if mtime > young:
                break
            try:
                p.unlink()
            except OSError:
                continue
            total -= size
            if total <= BUDGET_BYTES * 0.8:
                break
