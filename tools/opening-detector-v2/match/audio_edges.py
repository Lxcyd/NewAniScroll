"""Position de la reference au SON, a l'echantillon pres.

Chromaprint donne le decalage a une trame (0,124 s) pres, lisse sur 0,6 s :
Railgun S ep1 megaplay, il placait la chanson a 22:01.74 alors qu'elle
commence a 22:01.425 (Luc : « la musique commence avant tes timings »). Ici,
correlation croisee des FORMES D'ONDE, tranche par tranche du corps de la
reference : toutes les tranches de Railgun tombent a 3 ms pres.

Les tranches viennent du CORPS : la tete ou la queue peuvent etre recouvertes
par le son de la scene (UBW ep3, cf. decide._edge_fallback).
"""
from __future__ import annotations

import numpy as np
from scipy.signal import fftconvolve

from fetch import SAMPLE_RATE as SR
from fetch.audio import decode_audio_abs

PIECE_S = 8.0
SEARCH_S = 3.0         # autour du calage grossier (Chromaprint corrige par l'image)
# Railgun S ep1 frembed : Chromaprint a 2,2 s de la chanson (22:15.49 contre
# 22:17.693, 8 tranches a 1 ms pres).
MIN_CORR = 0.30        # correlation normalisee minimale d'une tranche
AGREE_S = 0.02         # les tranches doivent concorder a 20 ms
SOUND_WIN_S = 0.05
SOUND_REL = 0.10       # « son » : energie > 10 % de l'energie mediane de la reference


def _xcorr(ep: np.ndarray, seg: np.ndarray) -> tuple[int, float]:
    c = fftconvolve(ep, seg[::-1], mode="valid")
    n = np.sqrt(fftconvolve(ep ** 2, np.ones(len(seg)), mode="valid")) * np.sqrt((seg ** 2).sum())
    cc = c / np.maximum(n, 1e-9)
    k = int(cc.argmax())
    return k, float(cc[k])


def refine_offset(src: str, referer, coarse: float, ref: np.ndarray) -> float | None:
    """Temps episode (horloge detecteur) de l'echantillon 0 de la reference,
    ou None si les tranches ne concordent pas (on garde alors Chromaprint)."""
    dur = len(ref) / SR
    starts = [s for s in (15.0, dur / 2 - PIECE_S / 2, dur - 15.0 - PIECE_S) if 0 <= s and s + PIECE_S <= dur]
    found = []
    for s in starts:
        seg = ref[int(s * SR): int((s + PIECE_S) * SR)]
        if seg.std() < 1e-4:
            continue
        try:
            pcm, a0 = decode_audio_abs(src, coarse + s - SEARCH_S, PIECE_S + 2 * SEARCH_S,
                                       sample_rate=SR, referer=referer)
        except Exception:
            continue
        if len(pcm) < len(seg):
            continue
        k, corr = _xcorr(pcm, seg)
        if corr >= MIN_CORR:
            found.append(a0 + k / SR - s)
    if len(found) < 2:
        return None
    med = float(np.median(found))
    agree = [x for x in found if abs(x - med) <= AGREE_S]
    return med if len(agree) >= 2 else None


def sound_span(ref: np.ndarray) -> tuple[float, float]:
    """Premier et dernier instant ou la reference a du son (hors silence
    d'amorce et de queue du fichier)."""
    w = int(SOUND_WIN_S * SR)
    n = len(ref) // w
    e = np.sqrt((ref[: n * w].reshape(n, w) ** 2).mean(axis=1))
    on = np.flatnonzero(e > SOUND_REL * np.median(e))
    if not len(on):
        return 0.0, len(ref) / SR
    return on[0] * SOUND_WIN_S, (on[-1] + 1) * SOUND_WIN_S
