"""Does Erased episode 1 carry the ED that AnimeThemes says it does not?

AnimeThemes maps ED1 to episodes "2-12", so the pipeline treats an empty ED on
episode 1 as correct-by-design. Luc says episode 1 does have an ending. This
settles it WITHOUT trusting either claim: take the audio the detector already
cached, and ask whether the tail of episode 1 repeats the tail of episodes 2
and 3. A generic sequence is, by construction, the part of an episode that is
identical across episodes — that test needs no catalogue at all.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


CACHE = Path(__file__).resolve().parent.parent / "cache/audio"


def load(ep: int, host: str, tag: str):
    """The cached PCM window for one (episode, host, window)."""
    stem = f"absa__erased__saison1__vostfr__ep{ep}__{host}"
    hits = sorted(CACHE.glob(f"{stem}.abs{tag}*.fp.npz"))
    return hits[0] if hits else None


print("Fenetres en cache pour erased :")
seen = {}
for p in sorted(CACHE.glob("absa__erased__*.fp.npz")):
    parts = p.name.split("__")
    ep = parts[3]
    win = p.name.split(".abs")[1].split(".fp")[0]
    seen.setdefault((ep, parts[4].split(".abs")[0]), []).append(win)
for (ep, host), wins in sorted(seen.items()):
    print(f"  {ep:<6} {host:<12} {sorted(wins)}")
