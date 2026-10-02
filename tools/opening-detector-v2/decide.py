"""Decision par lecteur : servir, ou s'abstenir avec une raison.

Seuils fixes en P1 (README) sur 17 episodes. Tout ce qui n'est pas prouve est
une abstention : on prefere ne rien servir que servir faux.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

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
# Son de l'episode PAR-DESSUS le debut de la chanson : trames a plus de
# (pire trame du corps + marge) bits. Seuil relatif, car le bruit d'encodage
# varie d'un lecteur a l'autre (corps max 2 a 10 bits) : a seuil fixe, 113
# bornes sur 387 bougeaient a tort ; ainsi, seule Railgun S ep6 (ED, 9,6 s).
MIX_MARGIN_BITS = 2
# Fin seule : la chanson est noyee sous le dialogue de la derniere scene, puis
# reste seule jusqu'a sa derniere note. On sert ce bout-la, en fin d'episode
# seulement (Luc, 02/10/2026, Railgun S ep14 : ED2 reconnu a 48 %, seul sur
# ses 20 dernieres secondes).
TAIL_MIN_S = 15.0     # chanson seule, au moins
# « Seule » se prouve : au plus 6 bits lisses. Railgun S ep12/ep14, chanson
# seule : 1 a 4 bits ; Railgun ep24 (ED3) et Kimetsu ep26 (OP1) restent a 8-13
# bits jusqu'au bout — un son d'episode court sous la chanson — et le debut du
# bout « seul » y variait de 10 s d'un lecteur a l'autre : abstention.
TAIL_CLEAN_BITS = 6
# Reference qui CONTIENT du dialogue (AnimeThemes : overlap = Transition / Over ;
# Railgun S ED2 est l'extrait de l'ep11, voix comprises jusqu'a +69 s). Contre
# elle, un desaccord peut venir de la reference : a l'ep14 l'episode se tait a
# +52 s (carton « To Be continued », Luc : « trop tard les bornes »), mais les
# repliques de l'ep11 brouillent jusqu'a +70 s. Ni les formes d'onde ni le
# spectre ne disent de quel cote est le son en trop (essayes). Le debut est
# alors la PREMIERE plage propre d'au moins DIRTY_CLEAN_S : fragile (une pause
# entre deux repliques la tromperait), assume faute de version propre.
DIRTY_CLEAN_S = 2.5
TAIL_SLACK_S = 6.0    # silence de queue de la reference, ou rien ne concorde (Kimetsu ED1 : 5,1 s)
# Milieu d'episode : une chanson de generique jouee sur une scene (combat) n'est
# pas un generique. Sur les 387 bornes de la page, tout OP commence avant
# 5 min 47 et tout ED finit a moins de 1 min 32 de la fin.
MID_HEAD_S = 480.0
MID_TAIL_S = 300.0
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
    dirty: bool = False       # la reference contient du son d'episode (cf. DIRTY_CLEAN_S)

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
        self.edge_zones, self.tail_from = [], 0.0
        if self.reasons and set(self.reasons) <= {"couverture", "trou"}:
            # La fin seule d'abord : elle dit ou la chanson devient seule, meme
            # au-dela des 15 s de la zone de tete (Frieren ep28 : 18,2 s).
            self.tail_from = self._tail_fallback()
            if self.tail_from:
                self.reasons = []
            else:
                zones = self._edge_fallback()
                if zones:
                    self.edge_zones, self.reasons = zones, []
        return not self.reasons

    def _tail_fallback(self) -> float:
        """Secondes depuis `start` a partir desquelles la chanson est SEULE
        jusqu'a sa fin, ou 0. La derniere plage concordante (trous <= 1 s
        combles) doit toucher la fin de la reference et durer TAIL_MIN_S ; son
        debut est resserre au niveau de bits de ses 10 dernieres secondes, comme
        mixed_head. run.py n'accepte ce repli qu'en fin d'episode."""
        sm = smooth(self.occ.curve)
        runs = _runs(sm <= TAIL_CLEAN_BITS)
        if not runs:
            return 0.0
        a, b = runs[-1]
        for ra, rb in reversed(runs[:-1]):
            if a - rb > MAX_GAP_S / FRAME_S:
                break
            a = ra
        if (len(sm) - b) * FRAME_S > TAIL_SLACK_S:
            return 0.0
        if self.dirty:
            a = min([a] + [ra for ra, rb in runs if (rb - ra) * FRAME_S >= DIRTY_CLEAN_S])
        else:
            clean = sm[max(a, b - int(10.0 / FRAME_S)): b].max() + MIX_MARGIN_BITS
            bad = np.flatnonzero(sm[a:b] > clean)
            if len(bad):
                a += int(bad[-1]) + 1
        return float(a * FRAME_S) if (b - a) * FRAME_S >= TAIL_MIN_S else 0.0

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

    def mixed_head(self, lead: float) -> float:
        """Secondes depuis `start` pendant lesquelles le son de l'episode
        recouvre encore la chanson (0 si elle est seule des la premiere note).

        Railgun S ep6, ED : la scene continue 9,6 s sous la chanson ; servir
        des la premiere note ferait sauter un bout d'episode (Luc, 02/10/2026 :
        « detecter quand il ne reste plus que le son de l'ED »). Precision :
        celle de l'empreinte lissee, +/- 0,3 s. La queue n'a pas de regle
        miroir : sur la page elle ne trouvait que des fondus de sortie et des
        fichiers tronques. `lead` : silence de tete de la reference, ignore."""
        sm = smooth(self.occ.curve)
        a, edge = int(np.ceil(lead / FRAME_S)), int(EDGE_ZONE_S / FRAME_S)
        body = sm[a + edge: len(sm) - edge]
        if not len(body):
            return 0.0
        bad = np.flatnonzero(sm[a: a + edge] > body.max() + MIX_MARGIN_BITS)
        return float((a + bad[-1] + 1) * FRAME_S) if len(bad) else 0.0

    def mid_episode(self, ep_dur: float) -> bool:
        return self.start > MID_HEAD_S and self.end(ep_dur) < ep_dur - MID_TAIL_S

    def as_dict(self, ep_dur: float) -> dict:
        o = self.occ
        return {"ref": self.ref, "kind": self.kind, "start": round(self.start, 2),
                "end": round(self.end(ep_dur), 2), "coverage": round(o.coverage, 3),
                "gap": round(o.longest_gap_s, 2), "n_gaps": o.n_gaps, "median_bits": o.median_bits,
                "drift": o.drift_frames, "img": None if self.img is None else round(self.img, 3),
                "img_shift": self.img_shift, "edge_zones": getattr(self, "edge_zones", []),
                "tail_from": round(getattr(self, "tail_from", 0.0), 2),
                "reasons": self.reasons}


def overlap(a: Candidate, b: Candidate, ep_dur: float) -> float:
    lo, hi = max(a.start, b.start), min(a.end(ep_dur), b.end(ep_dur))
    return max(0.0, hi - lo) / max(1e-6, min(a.end(ep_dur) - a.start, b.end(ep_dur) - b.start))


def pick(served: list[Candidate], ep_dur: float) -> tuple[dict[str, Candidate], list[str]]:
    """Retenus -> au plus un OP et un ED, etiquetes par le theme reconnu.
    Deux references qui se chevauchent (ED1 / ED1v3) : la meilleure gagne.
    Deux sequences distinctes du meme type : abstention (conflit)."""
    best: list[Candidate] = []
    # Un generique reconnu en entier passe toujours avant une « fin seule », qui
    # n'entre que si rien d'autre n'occupe sa place ni son type : la fin d'une
    # chanson concorde aussi avec un refrain anterieur (Railgun S, OP2 : alias a
    # 19 % de couverture sur l'OP deja servi), et l'ED1v2 de Frieren passe ce
    # repli sur chaque ED1.
    # Une reference qui contient du dialogue passe en dernier : la version
    # propre de la meme chanson, quand elle existe, pose le debut (Frieren ep28 :
    # ED1 contre ED1v3). Seule et reconnue en entier, elle ne prouve pas que
    # la chanson est seule (Railgun S ep11 : 66 s de dialogue) : abstention.
    tail = lambda c: bool(getattr(c, "tail_from", 0.0))
    dirty_notes = []
    for c in sorted(served, key=lambda c: (c.dirty, tail(c), -(c.img or 0) - c.occ.coverage, c.occ.median_bits)):
        if (tail(c) or c.dirty) and any(b.kind == c.kind or overlap(c, b, ep_dur) > 0 for b in best):
            continue
        if c.dirty and not tail(c):
            c.reasons.append("reference_avec_dialogue")
            dirty_notes.append(f"reference_avec_dialogue_{c.kind}")
            continue
        if all(overlap(c, b, ep_dur) < 0.5 for b in best):
            best.append(c)
    # L'etiquette vient du THEME (OP ou ED selon AnimeThemes), pas de sa place :
    # un OP rejoue en fin d'episode reste l'OP (Luc, 30/09/2026, Railgun S ep1).
    slots: dict[str, list[Candidate]] = {}
    for c in best:
        slots.setdefault(c.kind, []).append(c)
    out, notes = {}, dirty_notes
    for slot, cs in slots.items():
        if len(cs) == 1:
            out[slot] = cs[0]
        else:
            notes.append(f"conflit_{slot}")
    return out, notes
