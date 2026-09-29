"""Decision par lecteur : servir, ou s'abstenir avec une raison.

Seuils fixes en P1 (README) sur 17 episodes. Tout ce qui n'est pas prouve est
une abstention : on prefere ne rien servir que servir faux.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from match.ber import Occurrence

# Audio : la reference passe EN ENTIER, sans trou, a decalage constant.
MIN_COVERAGE = 0.95
MAX_GAP_S = 1.0
MAX_DRIFT_FRAMES = 1
# Image : memes images que la video de reference au meme temps relatif.
MIN_IMAGE = 0.80
# Candidats notes (pour le diagnostic) a partir de cette couverture.
REPORT_COVERAGE = 0.5


@dataclass
class Candidate:
    ref: str
    kind: str                 # nature declaree du morceau (op/ed selon AnimeThemes)
    ref_dur: float
    occ: Occurrence
    img: float | None = None
    reasons: list[str] = field(default_factory=list)

    @property
    def start(self) -> float:
        return self.occ.start_s

    def end(self, ep_dur: float) -> float:
        return min(self.start + self.ref_dur, ep_dur)

    def audio_ok(self) -> bool:
        o = self.occ
        self.reasons = [r for r, bad in (
            ("couverture", o.coverage < MIN_COVERAGE),
            ("trou", o.longest_gap_s > MAX_GAP_S),
            ("derive", o.drift_frames > MAX_DRIFT_FRAMES),
            ("hors_episode", o.start_s < -0.5),
        ) if bad]
        return not self.reasons

    def as_dict(self, ep_dur: float) -> dict:
        o = self.occ
        return {"ref": self.ref, "kind": self.kind, "start": round(self.start, 2),
                "end": round(self.end(ep_dur), 2), "coverage": round(o.coverage, 3),
                "gap": round(o.longest_gap_s, 2), "n_gaps": o.n_gaps, "median_bits": o.median_bits,
                "drift": o.drift_frames, "img": None if self.img is None else round(self.img, 3),
                "reasons": self.reasons}


def overlap(a: Candidate, b: Candidate, ep_dur: float) -> float:
    lo, hi = max(a.start, b.start), min(a.end(ep_dur), b.end(ep_dur))
    return max(0.0, hi - lo) / max(1e-6, min(a.end(ep_dur) - a.start, b.end(ep_dur) - b.start))


def pick(served: list[Candidate], ep_dur: float) -> tuple[dict[str, Candidate], list[str]]:
    """Retenus -> au plus un OP (debut d'episode) et un ED (fin), etiquetes par
    leur PLACE : un OP rejoue en generique de fin est un ED pour le lecteur.
    Deux references qui se chevauchent (ED1 / ED1v3) : la meilleure gagne.
    Deux sequences distinctes pour la meme place : abstention (conflit)."""
    best: list[Candidate] = []
    for c in sorted(served, key=lambda c: (-(c.img or 0) - c.occ.coverage, c.occ.median_bits)):
        if all(overlap(c, b, ep_dur) < 0.5 for b in best):
            best.append(c)
    slots: dict[str, list[Candidate]] = {}
    for c in best:
        mid = (c.start + c.end(ep_dur)) / 2
        slots.setdefault("op" if mid < ep_dur / 2 else "ed", []).append(c)
    out, notes = {}, []
    for slot, cs in slots.items():
        if len(cs) == 1:
            out[slot] = cs[0]
        else:
            notes.append(f"conflit_{slot}")
    return out, notes
