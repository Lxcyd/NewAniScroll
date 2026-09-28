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
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from .megaplay import depng, is_megaplay

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
SEG_DIR = Path(os.environ.get("OPED_HLS_CACHE", "cache/hls"))
BUDGET_BYTES = int(float(os.environ.get("OPED_HLS_CACHE_GB", "15")) * 1024 ** 3)
# Telechargements simultanes PAR fenetre, et plafond global par domaine : le
# batch lance plusieurs hotes et episodes en parallele, et un CDN qui voit 40
# connexions d'une meme IP finit par couper.
WORKERS = int(os.environ.get("OPED_HLS_WORKERS", "8"))
_PER_DOMAIN = int(os.environ.get("OPED_HLS_PER_DOMAIN", "12"))
_domain_sems: dict[str, threading.BoundedSemaphore] = {}
_domain_lock = threading.Lock()
_BW = re.compile(r"BANDWIDTH=(\d+)")


@dataclass
class _Playlist:
    key: str                                   # identite stable du rendu
    segments: list[tuple[str, float, float]]   # (url, debut, fin) cumules


_playlists: dict[str, _Playlist | None] = {}
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
    for k in range(tries):
        try:
            with _sem(url):
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=60) as r:
                    return r.read()
        except Exception as exc:  # reseau : on reessaie avant d'abandonner
            last = exc
            time.sleep(1.5 * (k + 1))
    raise RuntimeError(f"segment injoignable apres {tries} essais: {url[:120]} ({last})")


def _stable_key(url: str) -> str:
    """Identite d'un rendu SANS son jeton : le chemin survit a une nouvelle
    resolution (le jeton tourne toutes les 12 h), donc le cache aussi."""
    p = urllib.parse.urlsplit(url)
    return hashlib.sha1(f"{p.hostname}{p.path}".encode()).hexdigest()[:20]


def _load_playlist(master_url: str, referer: str | None) -> _Playlist | None:
    with _pl_lock:
        if master_url in _playlists:
            return _playlists[master_url]
    pl = _parse(master_url, referer)
    with _pl_lock:
        _playlists[master_url] = pl
    return pl


def _parse(master_url: str, referer: str | None) -> _Playlist | None:
    text = _fetch(master_url, referer).decode("utf-8", "replace")
    media_url = master_url
    if "#EXT-X-STREAM-INF" in text:
        for line in text.splitlines():
            if line.startswith("#EXT-X-MEDIA") and "TYPE=AUDIO" in line and "URI=" in line:
                return None  # audio en rendu separe : la concatenation video n'a pas de son
        best: tuple[int, str] | None = None
        lines = text.splitlines()
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
    if any(tag in text for tag in ("#EXT-X-MAP", "#EXT-X-BYTERANGE")):
        return None
    for line in text.splitlines():
        if line.startswith("#EXT-X-KEY") and "METHOD=NONE" not in line:
            return None
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
    return _Playlist(key=_stable_key(media_url), segments=segs)


def _segment_file(pl: _Playlist, idx: int, url: str, referer: str | None,
                  megaplay: bool) -> Path:
    d = SEG_DIR / pl.key
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{idx:05d}.ts"
    if f.exists() and f.stat().st_size > 0:
        return f
    data = _fetch(url, referer)
    if megaplay:
        data = depng(data)
    tmp = f.with_suffix(f".part{threading.get_ident()}")
    tmp.write_bytes(data)
    tmp.replace(f)
    return f


def playlist_duration(master_url: str, *, referer: str | None = None) -> float | None:
    """Duree totale (somme des EXTINF du rendu choisi), sans ffprobe. None si
    ce flux n'est pas materialisable."""
    pl = _load_playlist(master_url, referer)
    return pl.segments[-1][2] if pl else None


def local_window(master_url: str, start_abs: float, dur: float | None, *,
                 referer: str | None = None) -> str | None:
    """Chemin d'un .ts local couvrant [start_abs, start_abs+dur] (dur None = jusqu'a
    la fin), ou None si le flux ne se prete pas a une concatenation binaire.

    Un segment de marge AVANT la fenetre : `-ss` a besoin d'une image-cle a ou
    avant le point de recherche, et un segment HLS commence sur une image-cle."""
    if os.environ.get("OPED_HLS_LOCAL", "1") == "0":
        return None  # interrupteur : retour au decodage ffmpeg direct
    if not master_url.lower().split("?", 1)[0].endswith(".m3u8") or not master_url.startswith("http"):
        return None
    pl = _load_playlist(master_url, referer)
    if pl is None:
        return None
    lo = max(0.0, start_abs)
    hi = float("inf") if dur is None else start_abs + dur
    idx = [i for i, (_, s0, s1) in enumerate(pl.segments) if s1 > lo and s0 < hi]
    if not idx:
        idx = [len(pl.segments) - 1]
    i0, i1 = max(0, idx[0] - 1), idx[-1]
    out = SEG_DIR / pl.key / f"win_{i0:05d}_{i1:05d}.ts"
    if out.exists() and out.stat().st_size > 0:
        return str(out)
    mp = is_megaplay(master_url, referer)
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        files = list(pool.map(
            lambda i: _segment_file(pl, i, pl.segments[i][0], referer, mp),
            range(i0, i1 + 1)))
    tmp = out.with_suffix(f".part{threading.get_ident()}")
    with open(tmp, "wb") as w:
        for f in files:
            w.write(f.read_bytes())
    tmp.replace(out)
    _prune()
    return str(out)


_prune_lock = threading.Lock()


def _prune() -> None:
    """Budget disque : les fichiers les plus anciens partent d'abord. Tout est
    regenerable depuis le flux ; le lot du 07/08 avait rempli le disque (68 Go)
    faute de purge."""
    with _prune_lock:
        files = [p for p in SEG_DIR.rglob("*.ts") if p.is_file()]
        total = sum(p.stat().st_size for p in files)
        if total <= BUDGET_BYTES:
            return
        for p in sorted(files, key=lambda p: p.stat().st_mtime):
            try:
                total -= p.stat().st_size
                p.unlink()
            except OSError:
                continue
            if total <= BUDGET_BYTES * 0.8:
                break
