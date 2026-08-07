"""Le remède au bug d'empreinte dépendante de la fenêtre tient-il ?

CONSTAT (07/08, Charlotte ep2, vidmoly-va) : le même audio, empreint sur une
fenêtre de 300 s, donne 4011 votes et fill=0.959 ; empreint dans une fenêtre de
720 s puis tranché, il donne 1227 votes et fill=0.333 — sous `min_fill`, donc
rejeté. La sélection des pics est normalisée globalement, donc allonger la
fenêtre de décodage change les hachages du MÊME audio. Le repli large détruit
l'appariement qu'il était censé sauver.

REMÈDE PROPOSÉ : empreindre par blocs de taille fixe, recouvrants d'au moins la
durée d'un générique, et chercher bloc par bloc au lieu d'une grande fenêtre.

CE SCRIPT NE FAIT QUE MESURER. La maladie est prouvée ; le remède ne l'est pas,
et il a son propre mode d'échec — un générique à cheval sur une frontière serait
coupé en deux, ce qui remplacerait un biais par un autre. C'est exactement ce que
le recouvrement doit empêcher, et c'est ce qu'on vérifie ici AVANT de toucher au
détecteur.

MÉTHODE. On n'a plus l'audio des épisodes en cache (seulement leurs empreintes),
mais on a 475 références en PCM brut. On fabrique donc des « épisodes » réalistes
en noyant une référence cible dans d'autres références réelles — vrai contenu
spectral, aucun réseau. On place la cible à plusieurs offsets, dont un
délibérément À CHEVAL sur une frontière de bloc, qui est le cas où le remède doit
échouer s'il est mauvais.

Usage : python tools/opening-detector/_test_block_fingerprint.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from oped import SAMPLE_RATE  # noqa: E402
from oped.fingerprint import Fingerprint, fingerprint  # noqa: E402
from oped.matcher import best_match_ranked  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CACHE = Path(__file__).resolve().parent / "cache/audio"

# La fenêtre primaire d'aujourd'hui, celle qui marche.
BLOCK_S = 300.0
# Recouvrement ≥ la durée d'un générique : un thème de 90 s ne peut alors jamais
# être coupé par toutes les frontières à la fois. 120 s laisse de la marge pour
# les génériques longs (la bande de validate.py monte à 150 s).
OVERLAP_S = 120.0
# Le repli large actuel.
WIDE_S = 720.0


def load(name: str) -> np.ndarray:
    return np.load(CACHE / name)


def build_episode(target: np.ndarray, fillers: list[np.ndarray],
                  offset_s: float, total_s: float) -> np.ndarray:
    """Un « épisode » : du vrai contenu, avec la cible à `offset_s`."""
    n_total = int(total_s * SAMPLE_RATE)
    filler = np.concatenate(fillers)
    while len(filler) < n_total:
        filler = np.concatenate([filler, filler])
    ep = filler[:n_total].copy()
    start = int(offset_s * SAMPLE_RATE)
    end = min(start + len(target), n_total)
    ep[start:end] = target[: end - start]
    return ep


def match(fp: Fingerprint, ref: Fingerprint, ref_dur: float):
    # best_match_ranked renvoie (Match | None, ratio de rival) — un tuple, pas
    # une liste : `if not ms` serait toujours faux et masquerait le None.
    m, _rival = best_match_ranked(fp, ref)
    if m is None:
        return None
    return {
        "votes": m.n_votes,
        "fill": (m.r_end - m.r_start) / max(ref_dur, 1e-6),
        "t0": m.q_start - m.r_start,
    }


def blocks(total_s: float):
    """Les fenêtres du remède : pas = taille - recouvrement."""
    step = BLOCK_S - OVERLAP_S
    out, s = [], 0.0
    while s < total_s:
        out.append((s, min(BLOCK_S, total_s - s)))
        if s + BLOCK_S >= total_s:
            break
        s += step
    return out


def main() -> int:
    target_name = "animethemes__charlotte__OP1__v1.11025.npy"
    target = load(target_name)
    ref_dur = len(target) / SAMPLE_RATE
    ref_fp = Fingerprint.load(CACHE / target_name.replace(".11025.npy", ".fp.npz"))

    others = [
        p for p in sorted(CACHE.glob("animethemes__*.11025.npy"))
        if p.name != target_name
    ][:12]
    fillers = [np.load(p) for p in others]

    print(f"cible : charlotte OP1, {ref_dur:.1f}s")
    print(f"bloc {BLOCK_S:.0f}s, recouvrement {OVERLAP_S:.0f}s, "
          f"pas {BLOCK_S - OVERLAP_S:.0f}s\n")

    # Offsets choisis pour couvrir les cas : tôt (comme le vrai cas), au milieu,
    # et surtout À CHEVAL sur la frontière du 1er bloc (300 s) — le mode d'échec
    # que le recouvrement doit couvrir.
    offsets = [32.0, 150.0, 280.0, 330.0, 500.0, 640.0]
    hdr = (f"{'offset':>8} {'300s natif':>22} {'720s large':>22} "
           f"{'blocs recouvrants':>24}")
    print(hdr)
    print("-" * len(hdr))

    regressions = []
    for off in offsets:
        ep = build_episode(target, fillers, off, WIDE_S)

        # a) la fenêtre primaire d'aujourd'hui — n'existe que si la cible y tient
        narrow = None
        if off + ref_dur <= BLOCK_S:
            narrow = match(fingerprint(ep[: int(BLOCK_S * SAMPLE_RATE)]),
                           ref_fp, ref_dur)

        # b) le repli large d'aujourd'hui
        wide = match(fingerprint(ep), ref_fp, ref_dur)

        # c) le remède
        best = None
        for b_start, b_dur in blocks(WIDE_S):
            seg = ep[int(b_start * SAMPLE_RATE):
                     int((b_start + b_dur) * SAMPLE_RATE)]
            r = match(fingerprint(seg), ref_fp, ref_dur)
            if r and (best is None or r["fill"] > best["fill"]):
                best = {**r, "t0": r["t0"] + b_start, "block": b_start}

        def fmt(r):
            return "—" if not r else f"{r['votes']:>6d} v  fill={r['fill']:.3f}"

        print(f"{off:>8.0f} {fmt(narrow):>22} {fmt(wide):>22} {fmt(best):>24}")

        # Le remède doit au moins égaler le repli large, et retrouver la qualité
        # de la fenêtre primaire quand celle-ci était possible.
        if wide and best and best["fill"] < wide["fill"] - 0.05:
            regressions.append((off, "le remede fait PIRE que le repli large"))
        if narrow and best and best["fill"] < narrow["fill"] - 0.05:
            regressions.append((off, "le remede n'atteint pas la fenetre primaire"))

    print()
    if regressions:
        print("VERDICT : le remede N'EST PAS valide.")
        for off, why in regressions:
            print(f"  offset {off:.0f}s — {why}")
        return 1
    print("VERDICT : a chaque offset, y compris a cheval sur une frontiere, les")
    print("blocs recouvrants egalent ou depassent le repli large, sans jamais")
    print("descendre sous la fenetre primaire.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
