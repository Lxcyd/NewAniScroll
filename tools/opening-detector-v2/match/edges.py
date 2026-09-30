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
ANCHOR_MAX_S = 0.5     # ecart maximal ancre / calage grossier
FLASH_MAX_S = 2.0      # recherche de l'ancre du debut avant le calage grossier
HOLD_S = 2.0          # carton final tenu plus longtemps que dans le clip
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


def refine_start(src: str, start: float, refs, *, referer=None) -> float | None:
    """Debut a l'image pres, cadence native : premiere image de l'episode qui
    correspond a la premiere image TEXTUREE de la reference, confirmee par 3
    images de suite, ramenee au debut de la reference par son decalage connu.

    A 2 images/s, l'alignement ne voit pas un aplat : Railgun S ep1 megaplay,
    0,5 s de flash blanc (absent du clip AnimeThemes) avant le ciel pale ; le
    debut tombait au milieu du flash, 0,3 s trop tot (Luc, stats « Flux »)."""
    from .image import NEAR_FLAT_STD, _prep, similarity

    # Ancre = premiere image TEXTUREE de la reference. Un fondu quasi uni se
    # compare par sa seule luminance et ressemble a toute fin de scene sombre
    # (SnK et Kimetsu ep2, ED : ancre 2 s trop tot).
    h0 = first_content(refs)
    heads, lag = [], None
    for f, t in refs:
        sd = f.reshape(len(f), -1).std(axis=1)
        idx = np.flatnonzero((t >= h0) & (sd >= NEAR_FLAT_STD))
        if len(idx):
            heads.append(f[idx[0]])
            lag = float(t[idx[0]]) - h0 if lag is None else min(lag, float(t[idx[0]]) - h0)
    if not heads or lag > 3.0:
        return None
    ef, et = episode_frames(src, start + lag - FLASH_MAX_S, FLASH_MAX_S + 1.0, referer=referer, fps=None)
    if len(et) < 5:
        return None
    ep_p, ep_s = _prep(ef)
    rp, rs = _prep(np.stack(heads))
    match = np.array([max(similarity(ep_p[i], rp[j], ep_s[i], rs[j]) for j in range(len(rp)))
                      for i in range(len(ef))]) >= MATCH_NCC
    # Ancre confirmee par 3 images de suite : une image isolee de la scene
    # precedente qui ressemblerait a la reference ne suffit pas.
    anchors = [k for k in range(len(match) - 2) if match[k:k + 3].all()]
    if not anchors:
        return None
    # Debut = image de l'episode qui correspond au debut de la reference. Le
    # flash blanc qui precede chez megaplay n'est PAS dans la reference : il
    # n'est pas le generique (Luc, 30/09/2026).
    t = float(et[anchors[0]]) - lag
    # L'ancre affine le calage grossier (images a 2/s : +/- 0,5 s), elle ne le
    # contredit pas. Au-dela, c'est une ressemblance fortuite ou un fondu mal
    # replace (SnK ep2 ED : -2,2 s ; Kimetsu ep2 OP : +0,8 s) : on garde le
    # calage grossier.
    return t if abs(t - start) <= ANCHOR_MAX_S else None


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
