"""Horloge du LECTEUR vs horloge du detecteur.

Le detecteur travaille en PTS absolus (`-copyts`). Le lecteur du site (hls.js,
<video>) place le debut du flux a 0. Tant que le flux commence a 0, les deux
se confondent ; sinon tous nos temps sont decales d'autant.

Railgun S ep1 chez megaplay (30/09/2026, captures de Luc) : le flux commence a
1,40 s (son) / 1,48 s (image) ; nos bornes etaient 1,4 s trop tard partout
dans l'episode. Verifie en superposant un decodage en temps relatifs (comme un
lecteur qui cherche) et un decodage en temps absolus : +1,40 s a 1 min, 11 min
et 22 min. Les autres flux de gt10 commencent entre 0 et 0,27 s.
"""
from __future__ import annotations

from . import SAMPLE_RATE
from .audio import decode_audio_abs


def stream_origin(src: str, referer) -> float | None:
    """PTS (horloge detecteur) du premier echantillon du flux, son ou image :
    c'est le 0 du lecteur. None si le debut du flux est illisible."""
    from match.image import episode_frames  # import tardif : match depend de fetch

    firsts = []
    try:
        _, a0 = decode_audio_abs(src, 0.0, 1.0, sample_rate=SAMPLE_RATE, referer=referer)
        firsts.append(float(a0))
    except Exception:
        pass
    try:
        _, et = episode_frames(src, 0.0, 1.0, referer=referer, fps=None)
        if len(et):
            firsts.append(float(et[0]))
    except Exception:
        pass
    return round(min(firsts), 3) if firsts else None
