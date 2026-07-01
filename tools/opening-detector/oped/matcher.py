"""Cross-episode matching via hash-collision offset voting.

Given two fingerprints A (query) and B (reference), every shared hash yields a
candidate offset (t_A - t_B). If A and B contain the same OP recording, a large
set of hashes agree on ONE offset -> a sharp peak in the offset histogram. The
peak's offset is the alignment; the spread of anchor times that voted for it
gives the matched SPAN, i.e. the repeated segment's start/end.

This is what makes the homemade fingerprinter the right choice: the offset is
recovered to one STFT hop (~11.6 ms), finer than a video frame.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import HOP_SECONDS
from .fingerprint import Fingerprint


@dataclass
class Match:
    """A repeated segment found between query and reference."""

    offset_frames: int      # t_query - t_reference at alignment
    offset_seconds: float
    n_votes: int            # hashes agreeing on this offset
    # Span in QUERY time (seconds) covered by the agreeing anchors.
    q_start: float
    q_end: float
    # Same span mapped into REFERENCE time.
    r_start: float
    r_end: float
    score: float            # votes normalized by span length (votes/sec)

    @property
    def duration(self) -> float:
        return self.q_end - self.q_start


def _matching_offsets(
    q: Fingerprint, r: Fingerprint
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For every (query_hash == ref_hash) collision, return parallel arrays
    (offset, q_time, r_time) in frames. Uses sorted-hash intersection.
    """
    qh, rh = q.hashes, r.hashes
    # Find, for each unique hash present in both, the index ranges.
    # searchsorted on the sorted ref hashes gives the matching block per query.
    offsets: list[np.ndarray] = []
    q_times: list[np.ndarray] = []
    r_times: list[np.ndarray] = []

    # Walk unique query hashes; for each, grab all ref anchors with same hash.
    uniq, starts = np.unique(qh, return_index=True)
    starts = np.append(starts, len(qh))
    for k, h in enumerate(uniq):
        lo = np.searchsorted(rh, h, side="left")
        hi = np.searchsorted(rh, h, side="right")
        if hi == lo:
            continue
        qt = q.times[starts[k]:starts[k + 1]]            # query anchors w/ hash h
        rt = r.times[lo:hi]                               # ref anchors w/ hash h
        # Cartesian pairing of the (usually tiny) collision sets.
        qq = np.repeat(qt, len(rt))
        rr = np.tile(rt, len(qt))
        offsets.append(qq.astype(np.int64) - rr.astype(np.int64))
        q_times.append(qq)
        r_times.append(rr)

    if not offsets:
        empty = np.empty(0, dtype=np.int64)
        return empty, empty, empty
    return (
        np.concatenate(offsets),
        np.concatenate(q_times).astype(np.int64),
        np.concatenate(r_times).astype(np.int64),
    )


def best_match(
    q: Fingerprint,
    r: Fingerprint,
    *,
    min_votes: int = 40,
    offset_tolerance: int = 1,
) -> Match | None:
    """Return the strongest aligned repeated segment, or None.

    `offset_tolerance` (in frames) merges near-equal offsets so a tiny bit of
    clock drift between encodes doesn't split the vote across adjacent bins.
    """
    offsets, q_times, r_times = _matching_offsets(q, r)
    if offsets.size == 0:
        return None

    # Histogram of offsets. Bin width = (2*tol + 1) frames.
    bin_w = 2 * offset_tolerance + 1
    binned = np.round(offsets / bin_w).astype(np.int64)
    vals, counts = np.unique(binned, return_counts=True)
    top = int(np.argmax(counts))
    n_votes = int(counts[top])
    if n_votes < min_votes:
        return None

    return _build_match(offsets, q_times, r_times, binned, vals[top], n_votes)


def _dense_span(q_times, *, gap_s: float = 8.0):
    """Largest contiguous cluster of anchor times (seconds).

    Sort the query anchor frames; a gap larger than gap_s splits clusters.
    Return (start_s, end_s, mask_into_sorted) for the cluster holding the most
    anchors — that's the real repeated segment, free of coincidental outliers.
    """
    order = np.argsort(q_times)
    qs = q_times[order]
    gap_frames = gap_s / HOP_SECONDS
    # Boundaries where consecutive anchors jump more than gap_frames apart.
    breaks = np.nonzero(np.diff(qs) > gap_frames)[0]
    starts = np.concatenate(([0], breaks + 1))
    ends = np.concatenate((breaks + 1, [len(qs)]))  # exclusive
    # Pick the cluster with the most anchors.
    best = int(np.argmax(ends - starts))
    lo, hi = starts[best], ends[best]
    keep = order[lo:hi]
    start_s = float(qs[lo] * HOP_SECONDS)
    end_s = float(qs[hi - 1] * HOP_SECONDS)
    return start_s, end_s, np.sort(keep)


def _build_match(offsets, q_times, r_times, binned, peak_bin, n_votes) -> Match:
    sel = binned == peak_bin
    offset_frames = int(np.median(offsets[sel]))
    q_sel, r_sel = q_times[sel], r_times[sel]

    # A repeated segment is a DENSE cluster of agreeing anchors. A handful of
    # coincidental anchors elsewhere in the episode share the same offset by
    # chance and, with a raw min/max, would balloon the span across the whole
    # episode (seen on SnK: an ED bin stretched 165s→1531s). Take the largest
    # contiguous run of query anchors (gap-based clustering) as the segment.
    # `keep` indexes into the ORIGINAL q_sel/r_sel arrays so the reference span
    # is built from the SAME matched pairs.
    q_start, q_end, keep = _dense_span(q_sel)
    r_kept = r_sel[keep]
    r_start = float(r_kept.min() * HOP_SECONDS)
    r_end = float(r_kept.max() * HOP_SECONDS)
    span = max(q_end - q_start, 1e-6)
    return Match(
        offset_frames=offset_frames,
        offset_seconds=offset_frames * HOP_SECONDS,
        n_votes=n_votes,
        q_start=q_start,
        q_end=q_end,
        r_start=r_start,
        r_end=r_end,
        score=n_votes / span,
    )


def all_matches(
    q: Fingerprint,
    r: Fingerprint,
    *,
    min_votes: int = 200,
    offset_tolerance: int = 1,
) -> list[Match]:
    """Return EVERY aligned repeated segment (one per strong offset bin).

    best_match returns only the single top bin, so when an episode pair shares
    BOTH an OP and an ED they sit in two distinct offset bins — the ED would be
    invisible to a top-1 caller. The OP/ED detector needs all of them.
    """
    offsets, q_times, r_times = _matching_offsets(q, r)
    if offsets.size == 0:
        return []
    bin_w = 2 * offset_tolerance + 1
    binned = np.round(offsets / bin_w).astype(np.int64)
    vals, counts = np.unique(binned, return_counts=True)
    out = []
    for v, c in zip(vals, counts):
        if c >= min_votes:
            out.append(_build_match(offsets, q_times, r_times, binned, v, int(c)))
    out.sort(key=lambda m: m.n_votes, reverse=True)
    return out


# ── Series bank ──────────────────────────────────────────────────────────────


@dataclass
class EpisodeSegment:
    """A repeated segment found in one episode, with its corroboration."""

    ep_index: int          # 0-based index into the fingerprint list
    start: float           # seconds, in this episode's time
    end: float
    votes: int             # strongest pairwise vote count
    corroborating: set     # set of other ep_index that share this segment

    @property
    def duration(self) -> float:
        return self.end - self.start

    def as_candidate(self):
        # (start, end, votes, corroboration_count) — the classify.py contract.
        return (self.start, self.end, self.votes, len(self.corroborating))


def _overlaps(a_start, a_end, b_start, b_end, tol=10.0) -> bool:
    """Two segments in the SAME episode are the same if they overlap (with a
    small tolerance), used to merge a segment found against several partners."""
    return a_start < b_end + tol and b_start < a_end + tol


class SeriesBank:
    """Cross-episode repeated-segment index.

    Instead of comparing each episode only to its immediate neighbours, every
    episode is matched against ALL others (within a window, configurable). A
    segment that repeats ANYWHERE — even once — surfaces, which is what a
    neighbour-only matcher missed for OP/ED that change across the season. Each
    surfaced segment carries the set of episodes that corroborate it, so the
    classifier can tell a real (multi-episode) OP/ED from a one-off.

    Handles MISSING episodes naturally: absent indices simply never match.
    """

    def __init__(self, fingerprints: list[Fingerprint], *, window: int | None = None,
                 min_votes: int = 200):
        self.fps = fingerprints
        self.window = window           # None = compare against all episodes
        self.min_votes = min_votes
        # Per episode: list[EpisodeSegment]
        self.segments: list[list[EpisodeSegment]] = [[] for _ in fingerprints]

    def build(self) -> None:
        n = len(self.fps)
        for i in range(n):
            if self.fps[i] is None:
                continue
            found: list[EpisodeSegment] = []
            for j in range(n):
                if i == j or self.fps[j] is None:
                    continue
                if self.window is not None and abs(i - j) > self.window:
                    continue
                for m in all_matches(self.fps[i], self.fps[j], min_votes=self.min_votes):
                    self._absorb(found, i, j, m)
            self.segments[i] = found

    def _absorb(self, found, i, j, m: Match) -> None:
        """Merge match m into episode i's segment list, or extend an existing
        overlapping segment and record j as corroborating."""
        for seg in found:
            if _overlaps(seg.start, seg.end, m.q_start, m.q_end):
                seg.start = min(seg.start, m.q_start)
                seg.end = max(seg.end, m.q_end)
                seg.votes = max(seg.votes, m.n_votes)
                seg.corroborating.add(j)
                return
        found.append(EpisodeSegment(i, m.q_start, m.q_end, m.n_votes, {j}))

    def candidates(self, ep_index: int) -> list:
        """Candidate tuples for classify.classify_episode."""
        return [s.as_candidate() for s in self.segments[ep_index]]

    def block_map(self, kind_zone) -> list:
        """Group episodes by which repeated segment ('block') they share, e.g.
        'OP_1 covers ep A..B'. kind_zone(seg, dur) -> 'op'|'ed'|None decides
        membership; here we just expose the raw per-episode segments and leave
        block grouping to the runner which knows episode durations."""
        return self.segments
