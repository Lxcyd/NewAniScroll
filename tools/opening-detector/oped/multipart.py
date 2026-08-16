"""Multi-part episodes: one file that holds N broadcast episodes back to back.

A double-length premiere is a real and common shape (Re:Zero S1 ep 1 runs 49:10
against ~24 min for the rest of the season), and it breaks three assumptions the
rest of the detector makes:

  1. `OP_WINDOW = (0.0, 240.0)` only ever sees the FIRST part's opening. The
     second part's OP sits around the midpoint and is structurally out of reach.
  2. `ED_WINDOW = (-180.0, None)` is anchored on the end of the FILE, so it only
     ever sees the LAST part's ending. Every interior ED is invisible.
  3. The offset histogram returns one peak (`best_match`), so even when both
     openings fall inside the searched span, one of them is silently dropped.

This module supplies the missing piece: given an episode's duration and the
durations of its siblings, decide how many parts it holds, and produce the
per-part decode windows so each part is searched on its own clock.

WHAT THIS DELIBERATELY DOES NOT DO. It never *infers* a part count from a lone
duration — "long episode" is not evidence of "two episodes" (a recap special, a
feature-length finale and an ordinary episode with a long preview are all long
and single-part). A count above 1 is returned only when the duration lands on a
near-exact integer multiple of a median taken over enough siblings to be
meaningful. Anything else returns 1, and the episode is handled exactly as it is
today. Guessing wrong here would fabricate an OP in the middle of an ordinary
episode, which is worse than missing one.
"""

from __future__ import annotations

import statistics

# How close to an exact multiple the duration must land. Encodes of the same
# work differ by a few seconds (different trims, black frames, a stray frame of
# padding), and a 2-part episode accumulates that error twice — so the tolerance
# is applied to the WHOLE predicted length, not per part.
#
# 0.12 keeps Re:Zero (2951 s vs 2 x 1420 = 2840, off by 3.9%) comfortably inside
# while staying far from the midpoint between multiples: at 0.12 a duration must
# be within 12% of n x reference, and consecutive multiples are 100%/n apart, so
# for n <= 4 the bands never touch and a duration can satisfy at most one n.
MULTIPART_TOL_FRAC = 0.12

# Beyond 4 the bands get close enough that ordinary variance could reach the
# wrong one, and a genuine 5-in-1 file is rare enough to be worth missing.
MAX_PARTS = 4

# A median over fewer siblings than this is not a season norm, it is an
# accident. With 2 samples a single double-length episode drags the median
# halfway to itself and the multiple test becomes meaningless.
MIN_SIBLINGS = 3


def reference_duration(sibling_durations: list[float]) -> float | None:
    """The season's per-episode norm, or None when there isn't enough evidence.

    Uses the median, not the mean: a season with one double-length premiere has
    exactly the outlier that would drag a mean upward and shrink the apparent
    multiple of the very episode we are trying to identify.
    """
    usable = [d for d in sibling_durations if d and d > 0]
    if len(usable) < MIN_SIBLINGS:
        return None
    return float(statistics.median(usable))


def part_count(duration: float, reference: float | None) -> int:
    """How many broadcast episodes this file holds. 1 when unsure.

    `reference` is the sibling median from `reference_duration`; None (not
    enough siblings) always yields 1.
    """
    if not duration or duration <= 0 or not reference or reference <= 0:
        return 1
    best = 1
    for n in range(2, MAX_PARTS + 1):
        predicted = n * reference
        if abs(duration - predicted) <= MULTIPART_TOL_FRAC * predicted:
            # The bands are disjoint for n <= MAX_PARTS (see MULTIPART_TOL_FRAC),
            # so the first match is the only match.
            best = n
            break
    return best


def part_bounds(duration: float, n_parts: int) -> list[tuple[float, float]]:
    """Absolute (start, end) of each part, split evenly across the file.

    An even split is an approximation — the real boundary sits wherever the
    encoder joined the two broadcasts, which we do not know. It does not need to
    be exact: the windows built from it are 4 min (OP) and 3 min (ED) wide, far
    larger than the drift an even split introduces, and each part's search
    window is derived from ITS OWN bound rather than from the file's.
    """
    if n_parts <= 1:
        return [(0.0, float(duration))]
    step = float(duration) / n_parts
    return [(i * step, (i + 1) * step) for i in range(n_parts)]


def part_windows(
    duration: float,
    n_parts: int,
    op_window: tuple[float, float],
    ed_window: tuple[float, float | None],
) -> list[tuple[tuple[float, float], tuple[float, float | None]]]:
    """Per-part (op_window, ed_window), in the form the decoder expects.

    OP windows are absolute offsets from the part's start. ED windows are
    absolute too, EXCEPT for the final part, which keeps the relative
    `(-180.0, None)` form so the decoder can still seek with `-sseof`: on a
    remote stream that is the difference between seeking to the tail and
    reading the file to reach it. Interior parts have no such shortcut — their
    end is in the middle of the file and must be addressed absolutely.
    """
    bounds = part_bounds(duration, n_parts)
    op_lo, op_hi = op_window
    ed_lo, ed_hi = ed_window
    out: list[tuple[tuple[float, float], tuple[float, float | None]]] = []

    for idx, (p_start, p_end) in enumerate(bounds):
        op = (p_start + op_lo, min(p_start + op_hi, p_end))

        is_last = idx == len(bounds) - 1
        if is_last:
            # Untouched: the file's end IS this part's end.
            ed: tuple[float, float | None] = (ed_lo, ed_hi)
        else:
            # `ed_lo` is negative (seconds before the end); project it onto this
            # part's end. `ed_hi` of None means "to the end" -> the part's end.
            lo = p_end + ed_lo if ed_lo < 0 else p_start + ed_lo
            hi = p_end if ed_hi is None else min(p_start + ed_hi, p_end)
            ed = (max(lo, p_start), hi)
        out.append((op, ed))

    return out


def describe(duration: float, n_parts: int) -> str:
    """One-line summary for run logs — a silent re-interpretation of an episode
    into N is exactly the kind of decision that should be visible in a batch."""
    if n_parts <= 1:
        return f"single part ({duration:.0f}s)"
    bounds = part_bounds(duration, n_parts)
    spans = ", ".join(f"{a:.0f}-{b:.0f}s" for a, b in bounds)
    return f"{n_parts} parts of {duration / n_parts:.0f}s [{spans}]"
