"""Compteurs de telechargement d'un lot : combien d'octets, en combien de temps.

Les requetes partent de plusieurs fils (8 par fenetre, 12 par domaine) : la
somme des durees depasse donc le temps reel. On garde les deux — la somme dit
ce que coute le reseau, le temps reel (mesure dans run.py, par etape) dit ce
qu'on attend.
"""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager

_lock = threading.Lock()
_totals = {"requetes": 0, "octets": 0, "secondes": 0.0}


@contextmanager
def fetched():
    """`with fetched() as got: got(len(data))` autour d'une requete reussie."""
    t0 = time.perf_counter()
    size = [0]
    yield lambda n: size.__setitem__(0, n)
    with _lock:
        _totals["requetes"] += 1
        _totals["octets"] += size[0]
        _totals["secondes"] += time.perf_counter() - t0


def snapshot() -> dict:
    with _lock:
        return dict(_totals)


def since(before: dict) -> dict:
    now = snapshot()
    return {k: round(now[k] - before[k], 3) if k == "secondes" else now[k] - before[k] for k in now}
