"""References AnimeThemes : on ne garde QUE les medias.

Regle de Luc (29/09) : les metadonnees d'AnimeThemes sont souvent fausses
(plages d'episodes decalees autour d'un passage OP1 -> OP2, 35 % des
« absences » v1 venaient de la). On n'en lit donc ni les plages d'episodes, ni
rien qui dise OU ou QUAND un theme passe : chaque episode est teste contre
TOUS les themes de la serie. On garde l'audio (.ogg), les videos (.webm, pour
le controle image) et la duree mesuree sur le fichier lui-meme.

API : 90 requetes / minute (en-tetes X-RateLimit-*, 429 + Retry-After).
"""
from __future__ import annotations

import json
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

API = "https://api.animethemes.moe/anime"
UA = "AniScroll-oped-v2/0.1 (+https://aniscroll.com)"
CACHE = Path("cache/refs")
API_MIN_INTERVAL_S = 0.8  # < 90 req/min, marge comprise

_lock = threading.Lock()
_last_call = 0.0


@dataclass
class RefVideo:
    link: str
    basename: str
    nc: bool          # sans credits
    overlap: str      # None / Transition / Over (credits poses sur des images d'episode)
    source: str       # BD / TV / WEB / DVD
    resolution: int | None


@dataclass
class RefTheme:
    """Un audio de reference distinct. Plusieurs videos (versions creditees,
    NC...) peuvent partager le meme .ogg ; une version (v2, v3...) avec son
    propre audio est une reference a part."""

    theme: str        # "OP1", "ED2"...
    kind: str         # "op" | "ed" — nature DECLAREE du morceau, pas de sa place dans l'episode
    version: int
    song: str | None
    audio_link: str
    audio_basename: str
    videos: list[RefVideo] = field(default_factory=list)

    @property
    def key(self) -> str:
        return self.audio_basename.rsplit(".", 1)[0]


def _get(url: str, timeout: float = 30.0) -> bytes:
    global _last_call
    for attempt in range(4):
        with _lock:
            wait = API_MIN_INTERVAL_S - (time.monotonic() - _last_call)
            if wait > 0:
                time.sleep(wait)
            _last_call = time.monotonic()
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(float(e.headers.get("Retry-After") or 60))
                continue
            if e.code >= 500 and attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"AnimeThemes : trop de 429 pour {url}")


def fetch_themes(mal_id: int, *, refresh: bool = False) -> list[RefTheme]:
    """Toutes les references audio d'une serie, par MAL id. [] si AnimeThemes
    ne la connait pas (c'est alors au repli auto-reference de jouer)."""
    path = CACHE / "api" / f"{mal_id}.json"
    if path.exists() and not refresh:
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        q = urllib.parse.urlencode({
            "filter[has]": "resources",
            "filter[site]": "MyAnimeList",
            "filter[external_id]": str(mal_id),
            "include": "animethemes.animethemeentries.videos.audio,animethemes.song",
        })
        data = json.loads(_get(f"{API}?{q}"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    refs: dict[str, RefTheme] = {}
    for anime in data.get("anime", []):
        for t in anime.get("animethemes", []):
            kind = (t.get("type") or "").lower()
            if kind not in ("op", "ed"):
                continue
            for e in t.get("animethemeentries", []):
                for v in e.get("videos", []):
                    audio = v.get("audio") or {}
                    if not audio.get("link"):
                        continue
                    ref = refs.setdefault(audio["link"], RefTheme(
                        theme=t.get("slug") or f"{kind.upper()}{t.get('sequence') or ''}",
                        kind=kind,
                        version=e.get("version") or 1,
                        song=(t.get("song") or {}).get("title"),
                        audio_link=audio["link"],
                        audio_basename=audio.get("basename") or audio["link"].rsplit("/", 1)[-1],
                    ))
                    ref.videos.append(RefVideo(
                        link=v["link"], basename=v["basename"], nc=bool(v.get("nc")),
                        overlap=v.get("overlap") or "None", source=v.get("source") or "",
                        resolution=v.get("resolution"),
                    ))
    return list(refs.values())


def download(link: str, sub: str) -> Path:
    """Telecharge un media dans cache/refs/<sub>/ (une seule fois)."""
    dst = CACHE / sub / link.rsplit("/", 1)[-1]
    if dst.exists() and dst.stat().st_size > 0:
        return dst
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".part")
    req = urllib.request.Request(link, headers={"User-Agent": UA})
    with _lock:  # un telechargement a la fois vers AnimeThemes (v1 : rate-limit sur les decodages paralleles)
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
    tmp.replace(dst)
    return dst


def media_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, timeout=60)
    return float(out.stdout.strip())
