"""Resolution des lecteurs d'un episode et empreinte audio de l'episode complet."""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np

from . import SAMPLE_RATE
from .adapter_aniscroll import resolve_episodes_multi
from .audio import decode_audio_abs
from .probe import probe_duration

CACHE = Path("cache/ep")


def season_of(entry: dict, lang: str) -> dict:
    return next(s for s in entry["seasons"] if s["lang"] == lang)


def resolve(entry: dict, season: dict, ep: int, hosts: list[str] | None = None,
            *, fresh: bool = False) -> list[dict]:
    """Flux de l'episode par lecteur. `fresh` ignore le cache d'URL (6 h) :
    pour un second essai, une URL signee perimee ou un CDN tournant
    (megaplay) se regle souvent par une nouvelle resolution."""
    extra = {"cache_dir": tempfile.mkdtemp(prefix="urls-", dir="cache")} if fresh else {}
    return resolve_episodes_multi(
        entry["slug"], season["season_dir"], season["lang"], ep, ep, hosts=hosts, **extra,
        mal_id=entry["mal_id"],
        va_slug=season.get("va_slug") or entry.get("va_slug") or entry["slug"],
        frembed=season.get("frembed")).get(ep, [])


def fingerprint_stream(mal: int, lang: str, ep: int, stream: dict) -> tuple[float, np.ndarray]:
    """(duree, empreinte chromaprint) du flux complet, temps absolus, en cache."""
    from fp.chroma import fingerprint

    path = CACHE / f"{mal}_{lang}_ep{ep}_{stream['host']}.npz"
    if path.exists():
        z = np.load(path)
        return float(z["duration"]), z["fp"]
    dur = probe_duration(stream["url"], stream.get("referer"))
    pcm, t0 = decode_audio_abs(stream["url"], 0.0, dur, sample_rate=SAMPLE_RATE,
                               referer=stream.get("referer"))
    # Recaler l'echantillon 0 sur t=0 : les temps de l'empreinte sont alors absolus.
    if t0 > 0.01:
        pcm = np.concatenate([np.zeros(int(round(t0 * SAMPLE_RATE)), np.float32), pcm])
    elif t0 < -0.01:
        pcm = pcm[int(round(-t0 * SAMPLE_RATE)):]
    fp = fingerprint(pcm)
    CACHE.mkdir(parents=True, exist_ok=True)
    np.savez(path, fp=fp, duration=dur)
    return dur, fp
