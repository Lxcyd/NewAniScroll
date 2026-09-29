"""Comparaison dense reference <-> episode : bits differents trame par trame.

Pour CHAQUE decalage possible d (trame de l'episode ou tombe la trame 0 de la
reference), on calcule le nombre de bits differents entre les deux mots de 32
bits, trame par trame. C'est exhaustif (pas d'index, pas de vote) et peu
couteux : ~13 000 decalages x ~720 trames par reference.

- Localiser  = trouver les decalages ou beaucoup de trames concordent.
- Certifier  = regarder, a ce decalage, la courbe COMPLETE : un vrai generique
  concorde du debut a la fin de la reference, sans trou ; une musique de scene
  reprise sous des dialogues concorde par morceaux.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from fp.chroma import FRAME_S

_POP8 = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)

MATCH_BITS = 10       # une trame « concorde » sous ce nombre de bits differents (sur 32)
SMOOTH_FRAMES = 5     # mediane glissante ~0,6 s avant seuillage
MIN_PEAK_SCORE = 0.12  # part minimale de trames concordantes pour retenir un decalage
PEAK_SEPARATION_S = 8.0
DRIFT_BLOCK_S = 10.0
DRIFT_SEARCH = 3      # trames de part et d'autre du decalage global


def popcount32(x: np.ndarray) -> np.ndarray:
    return _POP8[x.view(np.uint8)].reshape(*x.shape, 4).sum(axis=-1, dtype=np.uint8)


def ber_matrix(ref: np.ndarray, ep: np.ndarray, seed: int = 0) -> tuple[np.ndarray, int]:
    """Matrice B[k, i] = bits differents entre ref[i] et ep[k - pad + i].

    Les trames hors episode sont remplies de mots aleatoires (~16 bits
    differents : « ne concorde pas »). Renvoie (B, pad) ; le decalage en
    trames d'episode de la ligne k est k - pad.
    """
    n = len(ref)
    pad = n
    rng = np.random.default_rng(seed)
    padded = np.concatenate([
        rng.integers(0, 2**32, pad, dtype=np.uint32), ep.astype(np.uint32),
        rng.integers(0, 2**32, pad, dtype=np.uint32)])
    windows = np.lib.stride_tricks.sliding_window_view(padded, n)  # (len(ep)+n+1, n)
    return popcount32(windows ^ ref.astype(np.uint32)[None, :]), pad


def smooth(bits: np.ndarray, k: int = SMOOTH_FRAMES) -> np.ndarray:
    if k <= 1:
        return bits.astype(np.float32)
    h = k // 2
    p = np.pad(bits.astype(np.float32), (h, h), mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(p, k), axis=-1)


@dataclass
class Occurrence:
    offset: int              # trame d'episode alignee sur la trame 0 de la reference
    score: float             # part des trames concordantes (brut, sans lissage)
    coverage: float          # part des trames de la reference concordantes (lissees)
    span: tuple[int, int]    # premiere / derniere trame de reference concordante
    longest_gap_s: float     # plus long trou A L'INTERIEUR de span
    n_gaps: int              # trous > 1 s a l'interieur de span
    head_miss_s: float       # reference non couverte avant span
    tail_miss_s: float       # reference non couverte apres span
    median_bits: float       # bits differents medians dans span
    drift_frames: int        # ecart max du meilleur decalage local, bloc par bloc
    curve: np.ndarray        # bits differents trame par trame (brut)

    @property
    def start_s(self) -> float:   # temps episode du debut de la reference
        return self.offset * FRAME_S

    def as_dict(self) -> dict:
        return {k: (round(v, 3) if isinstance(v, float) else v)
                for k, v in self.__dict__.items() if k != "curve"} | {
            "start_s": round(self.start_s, 2),
            "matched_start_s": round((self.offset + self.span[0]) * FRAME_S, 2),
            "matched_end_s": round((self.offset + self.span[1] + 1) * FRAME_S, 2),
        }


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Plages [a, b) ou mask est vrai."""
    m = np.concatenate([[False], mask, [False]]).astype(np.int8)
    d = np.diff(m)
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def describe(B: np.ndarray, pad: int, k: int) -> Occurrence:
    bits = B[k]
    n = len(bits)
    ok = smooth(bits) <= MATCH_BITS
    idx = np.flatnonzero(ok)
    if len(idx) == 0:
        span = (0, -1)
        inner = np.zeros(0, bool)
    else:
        span = (int(idx[0]), int(idx[-1]))
        inner = ok[span[0]:span[1] + 1]
    gaps = [b - a for a, b in _runs(~inner)] if len(inner) else []
    one_s = int(round(1.0 / FRAME_S))

    # Derive : meilleur decalage local, bloc de DRIFT_BLOCK_S par bloc, dans
    # les blocs qui concordent. Un vrai generique garde le meme decalage de bout
    # en bout ; un encode accelere (PAL) ou une coupe au montage le deplace.
    block = int(DRIFT_BLOCK_S / FRAME_S)
    locs = []
    for a in range(span[0], span[1] + 1, block):
        b = min(a + block, span[1] + 1)
        if b - a < block // 2 or ok[a:b].mean() < 0.8:
            continue
        rows = [(B[k + s, a:b].mean(), s) for s in range(-DRIFT_SEARCH, DRIFT_SEARCH + 1)
                if 0 <= k + s < len(B)]
        locs.append(min(rows)[1])
    drift = (max(locs) - min(locs)) if locs else 0

    return Occurrence(
        offset=k - pad,
        score=float((bits <= MATCH_BITS).mean()),
        coverage=float(ok.mean()),
        span=span,
        longest_gap_s=(max(gaps) if gaps else 0) * FRAME_S,
        n_gaps=sum(1 for g in gaps if g >= one_s),
        head_miss_s=span[0] * FRAME_S if len(idx) else n * FRAME_S,
        tail_miss_s=(n - 1 - span[1]) * FRAME_S if len(idx) else 0.0,
        median_bits=float(np.median(bits[span[0]:span[1] + 1])) if len(idx) else 32.0,
        drift_frames=int(drift),
        curve=bits,
    )


def occurrences(ref: np.ndarray, ep: np.ndarray, *, top: int = 4) -> list[Occurrence]:
    """Toutes les apparitions plausibles de la reference dans l'episode, les
    meilleures d'abord (suppression des non-maxima a PEAK_SEPARATION_S)."""
    B, pad = ber_matrix(ref, ep)
    score = (B <= MATCH_BITS).mean(axis=1)
    sep = int(PEAK_SEPARATION_S / FRAME_S)
    out: list[Occurrence] = []
    order = np.argsort(-score)
    taken = np.zeros(len(score), bool)
    for k in order:
        if score[k] < MIN_PEAK_SCORE or len(out) >= top:
            break
        if taken[k]:
            continue
        taken[max(0, k - sep):k + sep + 1] = True
        out.append(describe(B, pad, int(k)))
    return out
