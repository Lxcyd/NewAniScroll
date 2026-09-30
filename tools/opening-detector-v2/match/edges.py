"""Bords a l'image pres.

L'audio donne ou la reference COMMENCE dans l'episode, pas ou le generique
commence ni finit a l'ecran :
- les clips AnimeThemes (surtout NCBD) portent 0 a 4,6 s de silence ou de noir
  en queue (mesure sur gt10) : « debut + duree du fichier » deborde sur le logo
  ou l'apercu qui suit ;
- un plan fixe peut preceder la musique (Railgun S ep2 : nuages ~2 s avant,
  verdict « debut faux » de Luc sur la v1) : NON traite, ce plan n'est pas dans
  la reference ; question de definition posee a Luc.

Donc, a la cadence NATIVE de l'episode :
- fin   = juste apres la derniere image qui concorde avec la reference au meme
          temps relatif (jamais au-dela de debut + duree du fichier) ;
Aucun bord n'est deplace sur autre chose qu'une concordance d'images.
"""
from __future__ import annotations

import numpy as np

from .image import MATCH_NCC, compare, episode_frames

END_BEFORE_S = 3.0
END_AFTER_S = 2.5
HOLD_S = 2.0           # carton final tenu plus longtemps que dans le clip
BLACK_LUMA = 2         # noir pur des amorces NC (0) ; un fondu (Kimetsu : 0,6 a 0,75 s, 20 seulement a 1,6 s) est deja du generique


def _last_run_end(ok: np.ndarray, run: int) -> int | None:
    for i in range(len(ok) - 1, run - 2, -1):
        if ok[i - run + 1: i + 1].all():
            return i
    return None


def refine_end(src: str, t0: float, coarse_end: float, refs, *, referer=None) -> float | None:
    """Temps absolu juste apres la derniere image concordante pres de coarse_end."""
    ef, et = episode_frames(src, coarse_end - END_BEFORE_S, END_BEFORE_S + END_AFTER_S,
                            referer=referer, fps=None)
    if len(et) < 5:
        return None
    ok = np.nan_to_num(compare(ef, et, t0, refs, slack=0.1, hold=HOLD_S), nan=0.0) >= MATCH_NCC
    i = _last_run_end(ok, run=3)
    if i is None:
        return None
    return float(et[i] + np.median(np.diff(et)))


def first_content(refs) -> float:
    """Temps (dans la reference) de la premiere image qui n'est pas du noir
    d'amorce. Le flash blanc qui ouvre un OP compte : c'est du generique."""
    firsts = []
    for frames, times in refs:
        lum = frames.reshape(len(frames), -1).mean(axis=1)
        idx = np.flatnonzero(lum > BLACK_LUMA)
        if len(idx):
            firsts.append(float(times[idx[0]]))
    return min(firsts) if firsts else 0.0
