"""Duree d'un flux et description d'un flux resolu.

Extrait de la v1 (detect_anime._probe_duration, multi_host.HostStream) : c'est
de la plomberie de transport, pas de la detection.

`python -m fetch.probe <anime-list.json> [mal_id] [ep] [lang]` resout un
episode sur tous les lecteurs, mesure sa duree et decode 30 s d'audio : c'est
le test de fumee de la couche de telechargement.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from dataclasses import dataclass

from .audio import _hls_flags, _input_headers


class ProbeError(RuntimeError):
    """ffprobe n'a pas pu lire la duree. Jamais de duree inventee a la place :
    tous les temps d'un lecteur sont exprimes contre elle."""


PROBE_RETRIES = 3
PROBE_BACKOFF_S = [1.0, 3.0]


def probe_duration(url: str, referer: str | None = None) -> float:
    """Duree en secondes via ffprobe (en-tete du conteneur seulement).

    Leve ProbeError apres PROBE_RETRIES essais : megaplay fait tourner ses CDN,
    un echec est souvent transitoire, mais une duree inventee (1440 s en v1)
    corrompt silencieusement tout ce qui est ancre sur la fin.
    """
    cmd = ["ffprobe", "-v", "error", *_input_headers(url, referer), *_hls_flags(url),
           "-show_entries", "format=duration",
           "-of", "default=noprint_wrappers=1:nokey=1", url]
    last = "aucun essai"
    for attempt in range(PROBE_RETRIES):
        if attempt:
            time.sleep(PROBE_BACKOFF_S[min(attempt - 1, len(PROBE_BACKOFF_S) - 1)])
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            last = "ffprobe: delai de 30 s depasse"
            continue
        except Exception as exc:
            raise ProbeError(f"ffprobe introuvable ou en echec : {exc}") from exc
        text = out.stdout.strip()
        if out.returncode != 0 or not text:
            last = out.stderr.strip() or f"code {out.returncode}, sortie vide"
            continue
        try:
            dur = float(text)
        except ValueError:
            last = f"duree illisible {text!r}"
            continue
        if not (dur > 0) or dur != dur:  # N/A -> nan, flux sans fin -> 0
            last = f"duree nulle ou NaN {text!r}"
            continue
        return dur
    raise ProbeError(f"duree illisible apres {PROBE_RETRIES} essais pour {url!r} : {last}")


@dataclass
class HostStream:
    """Un flux resolu d'un episode, avec SA duree (chaque lecteur a son encode)."""

    host: str
    url: str
    duration: float
    referer: str | None = None


def _season(entry: dict, lang: str) -> dict:
    for s in entry["seasons"]:
        if s["lang"] == lang:
            return s
    raise SystemExit(f"pas de saison {lang} pour mal={entry['mal_id']}")


def main(argv: list[str]) -> int:
    from . import SAMPLE_RATE
    from .adapter_aniscroll import resolve_episodes_multi
    from .audio import decode_audio_abs

    if not argv:
        print(__doc__)
        return 2
    anime = json.load(open(argv[0], encoding="utf-8"))
    entry = next((a for a in anime if len(argv) < 2 or a["mal_id"] == int(argv[1])), anime[0])
    lang = argv[3] if len(argv) > 3 else "vostfr"
    season = _season(entry, lang)
    ep = int(argv[2]) if len(argv) > 2 else (season.get("episodes") or [season.get("ep_start", 1)])[0]

    by_ep = resolve_episodes_multi(
        entry["slug"], season["season_dir"], lang, ep, ep,
        mal_id=entry["mal_id"],
        va_slug=season.get("va_slug") or entry.get("va_slug") or entry["slug"],
        frembed=season.get("frembed"),
    )
    streams = by_ep.get(ep, [])
    print(f"{entry['title']} ep{ep} {lang} : {len(streams)} lecteur(s)")
    ok = 0
    for s in streams:
        try:
            dur = probe_duration(s["url"], s.get("referer"))
            pcm, t0 = decode_audio_abs(s["url"], 60.0, 30.0,
                                       sample_rate=SAMPLE_RATE, referer=s.get("referer"))
            print(f"  {s['host']:<11} duree={dur:8.2f}s  audio={len(pcm) / SAMPLE_RATE:5.1f}s depuis {t0:.2f}s")
            ok += 1
        except Exception as exc:
            print(f"  {s['host']:<11} ECHEC {type(exc).__name__}: {str(exc)[:160]}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
