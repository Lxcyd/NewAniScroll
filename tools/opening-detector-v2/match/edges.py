"""Bords a l'image pres.

L'audio donne ou la reference COMMENCE dans l'episode, pas ou le generique
commence ni finit a l'ecran :
- les clips AnimeThemes (surtout NCBD) portent 0 a 4,6 s de silence ou de noir
  en queue (mesure sur gt10) : « debut + duree du fichier » deborde sur le logo
  ou l'apercu qui suit ;
- un plan fixe peut preceder la musique (Railgun S ep2 : nuages ~2 s avant,
  verdict « debut faux » de Luc sur la v1).

Donc, a la cadence NATIVE de l'episode :
- fin   = juste apres la derniere image qui concorde avec la reference au meme
          temps relatif (jamais au-dela de debut + duree du fichier) ;
- debut = on recule tant que l'episode montre encore la PREMIERE image de la
          reference (plan fixe prolonge), au plus HEAD_BACK_S.
Aucun bord n'est deplace sur autre chose qu'une concordance d'images.
"""
from __future__ import annotations

import numpy as np

from .image import FLAT_STD, MATCH_NCC, _prep, compare, episode_frames, similarity

HEAD_BACK_S = 4.0
END_BEFORE_S = 3.0
END_AFTER_S = 1.0


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
    ok = np.nan_to_num(compare(ef, et, t0, refs), nan=0.0) >= MATCH_NCC
    i = _last_run_end(ok, run=3)
    if i is None:
        return None
    return float(et[i] + np.median(np.diff(et)))


def extend_start(src: str, t0: float, refs, *, referer=None) -> float:
    """Recule le debut tant que l'episode montre la premiere image de la reference."""
    ef, et = episode_frames(src, t0 - HEAD_BACK_S, HEAD_BACK_S + 0.2, referer=referer, fps=None)
    if len(et) < 5:
        return t0
    ep_p, ep_s = _prep(ef)
    heads = []
    for frames, times in refs:
        sel = frames[times <= 0.3]
        # Un aplat (noir d'amorce des clips NC) ne prouve rien : reculer dessus
        # avalerait le fondu de la scene precedente (Kimetsu ep2 : -1,3 s).
        sel = sel[sel.reshape(len(sel), -1).std(axis=1) >= FLAT_STD] if len(sel) else sel
        if len(sel):
            heads.append(_prep(sel))
    if not heads:
        return t0
    start = t0
    for i in range(len(et) - 1, -1, -1):
        if et[i] > t0:
            continue
        best = max(similarity(ep_p[i], hp[j], ep_s[i], hs[j]) for hp, hs in heads for j in range(len(hp)))
        if best < MATCH_NCC:
            break
        start = float(et[i])
    return start
