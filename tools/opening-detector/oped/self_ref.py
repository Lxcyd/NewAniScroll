"""Self-derived references — the fallback for when AnimeThemes can't help.

The whole detector is anchored on a KNOWN reference clip. That breaks in three
real situations, and in all three we ship nothing today:

  1. the anime has no AnimeThemes entry (or no theme video) — the batch
     pre-filter skips it before touching a stream;
  2. AnimeThemes' theme is NOT the one in our encode — a dub with a replaced
     opening, a streaming cut with a different OP, a rip whose audio doesn't
     correspond;
  3. the entry exists but the mapping is empty for our episodes.

Yet the original signal is still there: an OP/ED is *the segment that repeats
across episodes*. This module recovers it from the episodes themselves, then
hands the result back as a `ThemeReference` so the ENTIRE existing pipeline
(detect_op_ed_v2 → per-host → reconcile → season pass) applies unchanged.

How it works
------------
1. Sample a few episodes, STRIDED (ep 1, 4, 7, …), and fingerprint the same OP
   and ED windows the normal path uses — so when the windows are already cached
   this costs no network at all.
2. Match the sampled episodes pairwise. A repeated segment shows up as a sharp
   offset peak whose query span IS the segment, in each episode's own time.
3. Keep a segment only if it repeats in enough episodes with a plausible length,
   then slice it out of one episode's fingerprint (`slice_fingerprint`, no
   decode) to become the reference.

False positives are the whole difficulty here — plenty of things repeat across
episodes — so the guards are deliberately harsh:

  - **stride ≥ 3 between sampled episodes**: a RECAP repeats between ADJACENT
    episodes (ep N's recap is ep N−1's footage), never between ep 1 and ep 7.
    Sampling with a stride makes recaps structurally unable to vote.
  - **length band** (validate.MIN/MAX_THEME_LEN_S): kills eyecatch jingles
    (~5 s) and "the whole episode matched" degenerate cases.
  - **≥ MIN_SUPPORT distinct episodes** must carry the segment: a one-off pair
    is a coincidence, an OP is in every episode.
  - **cross-episode agreement**, on whichever quantity is actually invariant for
    that kind: an ED sits a stable distance from the END of the episode
    (POSITION_TOLERANCE_S, from-end so differing encode lengths don't matter),
    while an OP holds a stable LENGTH (LENGTH_TOLERANCE_S) — its absolute start
    moves with the cold-open and is not a usable invariant.
  - and downstream, every hit built on a derived reference is stamped
    `derived=True`, which the serve gate holds until the intra-season pass has
    confirmed it across the season. Nothing derived is ever served on the
    strength of one episode.

What it CANNOT do: name the theme (there is no title — `slug` is "SELF-OP") or
give a frame-accurate edge (no credited landmarks, so hits stay audio-aligned,
GOP-free but fade-blind). That is the honest trade: coverage where we had none,
at a lower confidence tier, never masquerading as a credited match.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass

from .fingerprint import Fingerprint, slice_fingerprint
from .matcher import best_match
from .theme_bank import ThemeReference
from . import validate

# Episodes sampled to look for the repeat, and the gap between them. The stride
# is the anti-recap guard (see module docstring); 4 samples give 6 pairs, enough
# for a majority vote while keeping the decode cost at ~4 windows per kind.
SAMPLE_COUNT = 4
SAMPLE_STRIDE = 3

# Distinct sampled episodes that must carry the segment. With SAMPLE_COUNT=4,
# 3 means a lone disagreeing episode is tolerated (a missing OP happens) but a
# 2-episode coincidence is not enough.
MIN_SUPPORT = 3

# How far apart an ED may land across episodes, measured from the END, and
# still be "the same place in the episode". Generous because encodes differ by
# a few seconds; the point is to reject a segment that floats anywhere (shared
# BGM), not to police jitter.
#
# ED ONLY. This used to gate the OP too, and it was wrong: an OP's absolute
# position is set by the COLD-OPEN, which is a storytelling choice that varies
# episode to episode by design. Measured over the 15-anime audit, 10 anime lost
# a perfectly clean OP to this rule — toradora reported the segment at 52.4 /
# 140.4 / 109.4 s (an 88 s spread) with 2500+ votes each. The ED escapes because
# it is anchored from the end, which is stable; that exact asymmetry (every ED
# recovered, no OP ever) is what exposed the bug.
POSITION_TOLERANCE_S = 25.0

# Cross-episode agreement on the segment's LENGTH — the OP's stability
# invariant, standing in for position. An opening is a fixed-length piece of
# film: it runs the same 88 s wherever the cold-open drops it. Shared BGM, the
# false positive POSITION_TOLERANCE_S was written to stop, has no such
# invariant — it matches for however long the two cues happen to overlap, so it
# still fails to cluster here. The slack is for fade-edge vote noise, not for
# genuinely different lengths, and it stacks on top of the guards that already
# applied: MIN_SUPPORT distinct episodes, the 25-150 s band, SELF_MIN_VOTES, and
# the anti-recap stride.
#
# Calibrated by replaying the cached audit (`_replay_selfref.py --tolerance`):
# 3 s -> 28 OPs recovered, 5 s -> 31, 8 s -> 32, 12 s -> 32. 8 is the knee — it
# admits noragami (93/88/93 s, one 90 s opening whose fade edge cost a few
# seconds of votes) and everything past it buys nothing while loosening the
# guard.
LENGTH_TOLERANCE_S = 8.0

# Vote floor for a self-match. Higher than the reference matcher's 40: both
# sides are full episode windows here, so incidental collisions are far more
# numerous than when matching against a short clean clip.
SELF_MIN_VOTES = 150


@dataclass
class DerivedSegment:
    """A repeated segment recovered from the episodes themselves."""

    kind: str                     # "op" | "ed"
    episode: int                  # the episode the reference was sliced from
    start: float                  # its position in THAT episode (absolute s)
    length: float
    support: int                  # distinct episodes that carried it
    positions: dict               # {episode: start} — for diagnostics


def _pairwise_spans(fps: dict[int, tuple[Fingerprint, float]]) -> dict[int, list[tuple[float, float]]]:
    """For every sampled pair, the repeated span as seen in EACH episode.

    `fps` is {episode: (fingerprint, abs_start_of_window)}. Returns
    {episode: [(start_abs, length), …]} — one entry per pair the episode took
    part in. Both directions of a pair are recorded, since the span is expressed
    in the QUERY's time and we need it for both episodes.
    """
    out: dict[int, list[tuple[float, float]]] = {ep: [] for ep in fps}
    eps = sorted(fps)
    for i, a in enumerate(eps):
        for b in eps[i + 1:]:
            fa, base_a = fps[a]
            fb, base_b = fps[b]
            if fa.hashes.size == 0 or fb.hashes.size == 0:
                continue
            m = best_match(fa, fb, min_votes=SELF_MIN_VOTES)
            if m is None:
                continue
            length = m.q_end - m.q_start
            if not (validate.MIN_THEME_LEN_S <= length <= validate.MAX_THEME_LEN_S):
                continue
            # q_* is in A's window time, r_* in B's — each gets its own absolute
            # position, which is the point: the two encodes are cut differently.
            out[a].append((base_a + m.q_start, length))
            out[b].append((base_b + m.r_start, m.r_end - m.r_start))
    return out


def _cluster(values: list[float], tol: float) -> tuple[float, list[int]]:
    """Largest cluster of `values` within `tol`: (center, member INDICES).

    Indices rather than a count so the caller can tell WHICH episodes agreed —
    needed to slice the reference from a supporting episode rather than from an
    outlier that merely took part in many pairs.
    """
    if not values:
        return 0.0, []
    best_center, best_idx = values[0], []
    for v in values:
        near = [i for i, x in enumerate(values) if abs(x - v) <= tol]
        if len(near) > len(best_idx):
            best_center = statistics.median([values[i] for i in near])
            best_idx = near
    return best_center, best_idx


def _agree(values: list[float], tol: float) -> tuple[float, int]:
    """Largest cluster of `values` within `tol`. Returns (center, size)."""
    center, idx = _cluster(values, tol)
    return center, len(idx)


def find_segment(
    kind: str,
    fps: dict[int, tuple[Fingerprint, float]],
    *,
    duration_by_ep: dict[int, float] | None = None,
) -> DerivedSegment | None:
    """The repeated OP/ED segment across sampled episodes, or None.

    `fps` = {episode: (window fingerprint, window absolute start)}.

    The cross-episode agreement runs on whichever quantity is invariant for the
    kind. For an ED that is the distance from the END, which `duration_by_ep`
    supplies (encodes differ in total length, so absolute starts legitimately
    disagree while seconds-from-end agree) — mirroring multi_host's ED
    anchoring. For an OP — and for an ED with no durations to work from — it is
    the segment's LENGTH, since an opening's absolute start moves with the
    cold-open. See POSITION_TOLERANCE_S / LENGTH_TOLERANCE_S.
    """
    if len(fps) < 2:
        return None
    spans = _pairwise_spans(fps)

    # Per episode, the position it most consistently reported.
    per_ep: dict[int, tuple[float, float]] = {}   # ep -> (start_abs, length)
    for ep, obs in spans.items():
        if not obs:
            continue
        center, n = _agree([s for s, _ in obs], tol=2.0)
        if n == 0:
            continue
        lengths = [ln for s, ln in obs if abs(s - center) <= 2.0]
        per_ep[ep] = (center, statistics.median(lengths))
    if len(per_ep) < MIN_SUPPORT:
        return None

    # Cross-episode agreement. Which quantity has to agree depends on the kind:
    # an ED sits at a stable distance from the END, an OP at a stable LENGTH
    # (its absolute start moves with the cold-open). See the two tolerance
    # constants above.
    eps_order = sorted(per_ep)
    if kind == "ed" and duration_by_ep and all(duration_by_ep.get(e) for e in eps_order):
        values = [duration_by_ep[e] - per_ep[e][0] for e in eps_order]
        tol = POSITION_TOLERANCE_S
    else:
        values = [per_ep[e][1] for e in eps_order]
        tol = LENGTH_TOLERANCE_S

    _center, members = _cluster(values, tol)
    if len(members) < MIN_SUPPORT:
        return None
    agreed = [eps_order[i] for i in members]

    # Length from the AGREEING episodes only — an outlier that was excluded from
    # the cluster must not drag the delivered length with it.
    length = statistics.median(per_ep[e][1] for e in agreed)
    if not (validate.MIN_THEME_LEN_S <= length <= validate.MAX_THEME_LEN_S):
        return None

    # Slice the reference from a SUPPORTING episode (most pairs agreeing) — the
    # cleanest copy of the segment.
    ref_ep = max(agreed, key=lambda e: len(spans[e]))
    return DerivedSegment(
        kind=kind,
        episode=ref_ep,
        start=per_ep[ref_ep][0],
        length=length,
        support=len(members),
        positions={e: round(per_ep[e][0], 2) for e in per_ep},
    )


def sample_episodes(episodes: list[int]) -> list[int]:
    """The strided sample used for self-matching (see the anti-recap guard).

    Skips episode 1 when there is room: first episodes are the ones most likely
    to have no OP at all, or an OP pushed minutes in by a long prologue — the
    worst possible template for "where does this segment live". Falls back to
    whatever is available on very short seasons.
    """
    eps = sorted(episodes)
    if not eps:
        return []
    body = eps[1:] if len(eps) > SAMPLE_COUNT else eps
    picked = body[::SAMPLE_STRIDE][:SAMPLE_COUNT]
    if len(picked) < 2:
        picked = eps[:SAMPLE_COUNT]
    return picked


def derive_references(
    episodes: list[int],
    resolve_window_fp,
    *,
    duration_by_ep: dict[int, float] | None = None,
    kinds: tuple[str, ...] = ("op", "ed"),
    log=None,
) -> dict[str, ThemeReference]:
    """End-to-end: sample → self-match → slice. Returns {kind: ThemeReference}.

    `resolve_window_fp(episode, kind)` returns (Fingerprint, window_abs_start)
    for that episode's OP or ED search window, or None if the episode couldn't
    be decoded. The caller owns stream resolution and caching, so on an anime
    the normal path already processed this is a pure cache read.
    """
    picked = sample_episodes(episodes)
    out: dict[str, ThemeReference] = {}
    for kind in kinds:
        fps: dict[int, tuple[Fingerprint, float]] = {}
        for ep in picked:
            try:
                got = resolve_window_fp(ep, kind)
            except Exception:
                got = None
            if got is not None and got[0] is not None:
                fps[ep] = got
        seg = find_segment(kind, fps, duration_by_ep=duration_by_ep)
        if seg is None:
            if log:
                log(f"  [self-ref] {kind}: no repeated segment across {sorted(fps)}")
            continue
        ref = build_reference(seg, fps)
        if ref is None:
            continue
        if log:
            log(f"  [self-ref] {kind}: {seg.length:.1f}s segment, support "
                f"{seg.support}/{len(fps)} eps, sliced from ep{seg.episode} "
                f"@{seg.start:.1f}s")
        out[kind] = ref
    return out


def build_reference(seg: DerivedSegment, fps: dict[int, tuple[Fingerprint, float]]) -> ThemeReference | None:
    """Turn a `DerivedSegment` into a `ThemeReference` the normal detector eats.

    Costs nothing: the segment is CUT OUT of the fingerprint we already have
    (`slice_fingerprint`), so no audio is decoded again. No video reference
    exists by construction, so hits against it stay audio-aligned — and are
    stamped `derived` by the caller so the serve gate treats them accordingly.
    """
    fp, base = fps.get(seg.episode, (None, 0.0))
    if fp is None or fp.hashes.size == 0:
        return None
    rel_start = seg.start - base
    sub = slice_fingerprint(fp, rel_start, rel_start + seg.length)
    if sub.hashes.size == 0:
        return None
    return ThemeReference(
        kind=seg.kind,
        slug=f"SELF-{seg.kind.upper()}",
        version=1,
        song=None,
        video_url="",
        fp=sub,
        duration=seg.length,
    )
