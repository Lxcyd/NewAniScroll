"""Level 2 — robust OP/ED selection from repeated-segment candidates.

Input per episode: candidate repeated segments (from the matcher / series bank),
each with how many OTHER episodes corroborate it, plus the episode audio.

Decision = convergence of independent signals, not one threshold:
  • REPETITION  : it repeats across episodes (the matcher already established it;
                  corroboration count strengthens it). This is what separates a
                  real OP/ED from a per-episode recap.
  • NATURE      : it is sustained music, not dialogue (features.score_segment).
  • DURATION    : ~70-110s — rejects short eyecatch/preview stings.
  • POSITION    : OP in the first minutes (cold-open tolerated), ED in the last.
                  An OP pushed PAST the opening minutes is accepted only if the
                  bank corroborates it on >=2 episodes (distinguishes a relocated
                  OP from a one-off insert song).

Edges are then refined: left edge trims a glued recap (refine_left_edge), right
edge snaps the ED to the music→silence cut (refine_right_edge).
"""

from __future__ import annotations

from dataclasses import dataclass

from . import SAMPLE_RATE
from .features import score_segment
from .refine import refine_left_edge, refine_right_edge

# Candidate = (q_start, q_end, votes, corroborating_eps)
MIN_DUR = 70.0
MAX_DUR = 115.0
MUSIC_MIN = 0.40          # music_likelihood floor (dialogue ~0.13, music >=0.5)
OP_ZONE_END_FRAC = 0.30   # OP normally ends within first 30% of the episode
ED_ZONE_START_FRAC = 0.75  # ED normally starts after 75%
MIN_CORROBORATION_OUTOFZONE = 2  # bank support needed to accept an out-of-zone OP


@dataclass
class Detection:
    start: float
    end: float
    confidence: float
    method: str  # "fingerprint" | "fallback"

    def as_tuple(self):
        return (self.start, self.end)


def _music_score(samples, start: float, end: float) -> float:
    seg = samples[int(start * SAMPLE_RATE): int(end * SAMPLE_RATE)]
    return score_segment(seg).music_likelihood


def _eligible(cand, samples) -> tuple[bool, float]:
    """Duration + nature gate. Returns (ok, music_score)."""
    start, end = cand[0], cand[1]
    dur = end - start
    if not (MIN_DUR <= dur <= MAX_DUR):
        return False, 0.0
    ms = _music_score(samples, start, end)
    return ms >= MUSIC_MIN, ms


def classify_episode(cands: list, duration: float, samples) -> dict:
    """Pick the best OP and ED from this episode's candidate segments.

    cands: list of (q_start, q_end, votes, corroborating_eps).
    Returns {"op": Detection|None, "ed": Detection|None}.
    """
    op_end_t = duration * OP_ZONE_END_FRAC
    ed_start_t = duration * ED_ZONE_START_FRAC

    op_pool, ed_pool = [], []
    for c in cands:
        ok, ms = _eligible(c, samples)
        if not ok:
            continue
        start, end, votes, corrob = c[0], c[1], c[2], (c[3] if len(c) > 3 else 0)
        in_op_zone = end <= op_end_t
        in_ed_zone = start >= ed_start_t
        # OP pushed past the opening (cold-open) — accept only if corroborated,
        # else it's likely a mid-episode insert song.
        relocated_op = (not in_op_zone and not in_ed_zone
                        and corrob >= MIN_CORROBORATION_OUTOFZONE
                        and start < duration * 0.5)
        if in_op_zone or relocated_op:
            op_pool.append((start, end, votes, corrob, ms))
        if in_ed_zone:
            ed_pool.append((start, end, votes, corrob, ms))

    res = {"op": None, "ed": None}

    if op_pool:
        # Prefer most-corroborated, then most votes.
        b = max(op_pool, key=lambda x: (x[3], x[2]))
        start = refine_left_edge(samples, b[0], b[1])
        conf = _confidence(b[2], b[3], b[4])
        res["op"] = Detection(start, b[1], conf, "fingerprint")

    if ed_pool:
        b = max(ed_pool, key=lambda x: (x[3], x[2]))
        end = refine_right_edge(samples, b[0], b[1])
        # ED left edge can also carry a glued post-credits/preview ahead; trim.
        start = refine_left_edge(samples, b[0], end)
        conf = _confidence(b[2], b[3], b[4])
        res["ed"] = Detection(start, end, conf, "fingerprint")

    return res


def _confidence(votes: int, corrob: int, music: float) -> float:
    """Blend the independent evidences into a 0-1 confidence."""
    vote_term = min(votes / 2000.0, 1.0)
    corrob_term = min(corrob / 3.0, 1.0)
    return round(0.4 * vote_term + 0.3 * corrob_term + 0.3 * music, 3)
