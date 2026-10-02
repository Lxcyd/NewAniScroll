"""Decision par lecteur : servir, ou s'abstenir avec une raison.

Seuils fixes en P1 (README) sur 17 episodes. Tout ce qui n'est pas prouve est
une abstention : on prefere ne rien servir que servir faux.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from fp.chroma import FRAME_S
from match.ber import MATCH_BITS, Occurrence, _runs, smooth

# Audio : la reference passe EN ENTIER, sans trou, a decalage constant.
MIN_COVERAGE = 0.95
MAX_GAP_S = 1.0
MAX_DRIFT_FRAMES = 1
# Image : memes images que la video de reference au meme temps relatif. Ne
# decide plus de servir (Luc, 02/10/2026 : le son seul) ; au-dessus du seuil,
# l'image est dite conforme et son decalage sert d'indice de recherche.
MIN_IMAGE = 0.80
# Tete / queue que le son peut manquer si le corps est parfait (cf. _edge_fallback).
EDGE_ZONE_S = 15.0
# Candidats notes (pour le diagnostic) a partir de cette couverture.
REPORT_COVERAGE = 0.5


@dataclass
class Candidate:
    ref: str
    kind: str                 # nature declaree du morceau (op/ed selon AnimeThemes)
    ref_dur: float
    occ: Occurrence
    img: float | None = None
    img_shift: float = 0.0
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
        self.edge_zones = []
        if self.reasons and set(self.reasons) <= {"couverture", "trou"}:
            zones = self._edge_fallback()
            if zones:
                self.edge_zones, self.reasons = zones, []
        return not self.reasons

    def _edge_fallback(self) -> list[str]:
        """Tete ou queue du generique qui ne concorde pas au son, corps parfait.

        UBW ep3, ED1 : les 11 premieres secondes ont un autre son que la
        reference (fin de scene mixee dessus), les 79 autres concordent a la
        trame pres. Le corps prouve l'identite et donne le decalage ; la duree
        totale de la reference replace debut et fin (idee de Luc, 30/09/2026).
        Les zones renvoyees sont notees pour le diagnostic ; le corps suffit a
        servir (les images ne decident plus, cf. MIN_IMAGE)."""
        o = self.occ
        ok = smooth(o.curve) <= MATCH_BITS
        n, edge = len(ok), int(EDGE_ZONE_S / FRAME_S)
        body = ok[edge:n - edge]
        if len(body) < 0.5 * n or body.mean() < MIN_COVERAGE:
            return []
        gaps = [b - a for a, b in _runs(~body)]
        if gaps and max(gaps) * FRAME_S > MAX_GAP_S:
            return []
        zones = []
        if ok[:edge].mean() < MIN_COVERAGE:
            zones.append("tete")
        if ok[n - edge:].mean() < MIN_COVERAGE:
            zones.append("queue")
        return zones

    def as_dict(self, ep_dur: float) -> dict:
        o = self.occ
        return {"ref": self.ref, "kind": self.kind, "start": round(self.start, 2),
                "end": round(self.end(ep_dur), 2), "coverage": round(o.coverage, 3),
                "gap": round(o.longest_gap_s, 2), "n_gaps": o.n_gaps, "median_bits": o.median_bits,
                "drift": o.drift_frames, "img": None if self.img is None else round(self.img, 3),
                "img_shift": self.img_shift, "edge_zones": getattr(self, "edge_zones", []),
                "reasons": self.reasons}


def overlap(a: Candidate, b: Candidate, ep_dur: float) -> float:
    lo, hi = max(a.start, b.start), min(a.end(ep_dur), b.end(ep_dur))
    return max(0.0, hi - lo) / max(1e-6, min(a.end(ep_dur) - a.start, b.end(ep_dur) - b.start))


def pick(served: list[Candidate], ep_dur: float) -> tuple[dict[str, Candidate], list[str]]:
    """Retenus -> au plus un OP et un ED, etiquetes par le theme reconnu.
    Deux references qui se chevauchent (ED1 / ED1v3) : la meilleure gagne.
    Deux sequences distinctes du meme type : abstention (conflit)."""
    best: list[Candidate] = []
    for c in sorted(served, key=lambda c: (-(c.img or 0) - c.occ.coverage, c.occ.median_bits)):
        if all(overlap(c, b, ep_dur) < 0.5 for b in best):
            best.append(c)
    # L'etiquette vient du THEME (OP ou ED selon AnimeThemes), pas de sa place :
    # un OP rejoue en fin d'episode reste l'OP (Luc, 30/09/2026, Railgun S ep1).
    slots: dict[str, list[Candidate]] = {}
    for c in best:
        slots.setdefault(c.kind, []).append(c)
    out, notes = {}, []
    for slot, cs in slots.items():
        if len(cs) == 1:
            out[slot] = cs[0]
        else:
            notes.append(f"conflit_{slot}")
    return out, notes
