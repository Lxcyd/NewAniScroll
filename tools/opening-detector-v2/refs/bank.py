"""References d'une serie, pretes a comparer : duree du fichier + empreinte."""
from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .animethemes import RefTheme, download, fetch_themes, media_duration


@dataclass
class Ref:
    theme: RefTheme
    duration: float     # duree du FICHIER (l'empreinte couvre ~2,7 s de moins)
    fp: np.ndarray


_lock = threading.Lock()


def load(mal_id: int) -> list[Ref]:
    with _lock:  # deux episodes de la meme serie en parallele : un seul calcule les references
        return _load(mal_id)


def _load(mal_id: int) -> list[Ref]:
    from fp.chroma import decode_file, fingerprint

    out = []
    for t in fetch_themes(mal_id):
        cache = Path("cache/refs/fp") / f"{t.key}.npz"
        if cache.exists():
            z = np.load(cache)
            out.append(Ref(t, float(z["duration"]), z["fp"]))
            continue
        path = download(t.audio_link, "audio")
        dur = media_duration(path)
        fp = fingerprint(decode_file(path))
        cache.parent.mkdir(parents=True, exist_ok=True)
        np.savez(cache, fp=fp, duration=dur)
        out.append(Ref(t, dur, fp))
    return out
