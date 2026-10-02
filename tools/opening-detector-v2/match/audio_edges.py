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
SOUND_WIN_S = 0.01     # 0,05 s depassait une image (0,042 s) : bord son a +/- 1 image
SOUND_REL = 0.10       # « son » : energie > 10 % de l'energie mediane de la reference


def _xcorr(ep: np.ndarray, seg: np.ndarray) -> tuple[int, float]:
    c = fftconvolve(ep, seg[::-1], mode="valid")
    n = np.sqrt(fftconvolve(ep ** 2, np.ones(len(seg)), mode="valid")) * np.sqrt((seg ** 2).sum())
    cc = c / np.maximum(n, 1e-9)
    k = int(cc.argmax())
    return k, float(cc[k])


def refine_offset(src: str, referer, coarse: float, ref: np.ndarray, starts=None) -> float | None:
    """Temps episode (horloge detecteur) de l'echantillon 0 de la reference,
    ou None si les tranches ne concordent pas (on garde alors Chromaprint).
    `starts` : debuts des tranches dans la reference, quand seul un bout de la
    chanson est propre dans l'episode (cf. decide._tail_fallback)."""
    dur = len(ref) / SR
    starts = [s for s in (starts or (15.0, dur / 2 - PIECE_S / 2, dur - 15.0 - PIECE_S))
              if 0 <= s and s + PIECE_S <= dur]
    found = []
    for s in starts:
        seg = ref[int(s * SR): int((s + PIECE_S) * SR)]
        if seg.std() < 1e-4:
            continue
        # Deux marges : un decodage refuse pour un paquet AAC tronque au point
        # de depart (cf. MUTE_BODY_S) repart d'ailleurs. Sans cela une tranche
        # perdue suffisait a retomber sur Chromaprint (SnK ep2 ansembed, ED :
        # exact un jour, 0,26 s plus loin le lendemain).
        for margin in (SEARCH_S, SEARCH_S + 1.5):
            try:
                pcm, a0 = decode_audio_abs(src, coarse + s - margin, PIECE_S + 2 * margin,
                                           sample_rate=SR, referer=referer)
                break
            except Exception:
                continue
        else:
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


# Corps de chanson qui donne le niveau de reference de l'episode. Plusieurs
# longueurs : un decodage qui demarre sur un paquet AAC tronque est refuse
# (fetch.audio._reject_degraded) ; une autre longueur demarre ailleurs (SnK ep1
# VF ansembed : 8 s refuse, 12 s et 5 s passent).
MUTE_BODY_S = (8.0, 12.0, 5.0)
MUTE_WIN_S = 0.05
# La derniere note s'eteint encore quelques dixiemes sous le seuil de
# sound_span : SnK ep25 VF ansembed, 13 % puis 11 % du corps, puis plus rien.
# Une scene qui reprend, elle, depasse largement.
MUTE_PEAK = 0.25
# Vrai silence de l'episode : 0 a 3 % du corps (SnK OP1, Kimetsu OP1/ED1).
MUTE_FLOOR = 0.03


def mute_end(src: str, referer, final: float, file_end: float) -> float | None:
    """Jusqu'ou l'episode reste MUET apres la derniere note, sans depasser la
    fin du fichier de reference. Cette queue muette fait partie du generique :
    le dernier carton reste a l'ecran sans musique (SnK OP1, 1,13 s — Luc,
    02/10/2026 : « on n'a pas les 1:31 d'OP, on coupe trop tot »).

    Muet jusqu'au bout : fin du fichier. Sinon, l'instant ou le son REVIENT
    apres un vrai silence : c'est la scene suivante. Tout-ou-rien avant le
    02/10 : Kimetsu OP1, queue de 2,42 s, le son revient a 1,4 s (ep1) ou 1,8 s
    (ep2) — la borne retombait sur la derniere note, 87,87 s d'OP contre 90,28
    a l'ep3 ; ED1, 4,6 s de silence sur 5,12 perdues de meme. Sans vrai
    silence, la borne reste a la derniere note. None : pas pu decoder."""
    if file_end - final < MUTE_WIN_S:
        return final
    for lead in MUTE_BODY_S:
        try:
            pcm, a0 = decode_audio_abs(src, final - lead, file_end - final + lead,
                                       sample_rate=SR, referer=referer)
            break
        except Exception:
            continue
    else:
        return None
    w = int(MUTE_WIN_S * SR)

    def levels(a: float, b: float) -> np.ndarray:
        seg = pcm[max(0, int((a - a0) * SR)): max(0, int((b - a0) * SR))]
        n = len(seg) // w
        return np.sqrt((seg[: n * w].reshape(n, w) ** 2).mean(axis=1)) if n else np.zeros(0)

    body, tail = levels(max(a0, final - lead), final - 1.0), levels(final, file_end)
    if not len(body) or not len(tail) or np.median(body) <= 0:
        return None
    rel = tail / np.median(body)
    if np.percentile(rel, 90) <= SOUND_REL and rel.max() <= MUTE_PEAK:
        return file_end
    quiet = np.flatnonzero(rel <= MUTE_FLOOR)
    if not len(quiet):
        return final
    back = np.flatnonzero(rel[quiet[0]:] > SOUND_REL)
    if not len(back):
        return file_end
    # Remonter la montee du son jusqu'au silence : un fondu d'entree met
    # 0,2 s a passer le seuil (Kimetsu ep1 : 3, 7, 12, 18, 35 % par 0,1 s).
    k = int(quiet[0] + back[0])
    while rel[k - 1] > MUTE_FLOOR:
        k -= 1
    return final + k * w / SR


def sound_span(ref: np.ndarray) -> tuple[float, float]:
    """Premier et dernier instant ou la reference a du son (hors silence
    d'amorce et de queue du fichier)."""
    w = int(SOUND_WIN_S * SR)
    n = len(ref) // w
    e = np.sqrt((ref[: n * w].reshape(n, w) ** 2).mean(axis=1))
    on = np.flatnonzero(e > SOUND_REL * np.median(e))
    if not len(on):
        return 0.0, len(ref) / SR
    # w / SR, pas SOUND_WIN_S : la fenetre est un nombre ENTIER d'echantillons
    # (551 pour 551,25), et l'ecart se cumule — 0,04 s en fin de generique.
    return on[0] * w / SR, (on[-1] + 1) * w / SR
