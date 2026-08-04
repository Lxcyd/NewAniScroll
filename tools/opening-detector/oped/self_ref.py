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
  - **position agreement**: the segment must land at a consistent place across
    the sampled episodes (POSITION_TOLERANCE_S), measured from the start for an
    OP and from the END for an ED (encodes differ in length).
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

# How far apart the segment may land across episodes and still be "the same
# place in the episode". Generous because cold-opens genuinely vary by a few
# seconds between episodes; the point is to reject a segment that floats
# anywhere (shared BGM), not to police jitter.
POSITION_TOLERANCE_S = 25.0

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


def _agree(values: list[float], tol: float) -> tuple[float, int]:
    """Largest cluster of `values` within `tol`. Returns (center, size)."""
    if not values:
        return 0.0, 0
    best_center, best_n = values[0], 0
    for v in values:
        near = [x for x in values if abs(x - v) <= tol]
        if len(near) > best_n:
            best_center, best_n = statistics.median(near), len(near)
    return best_center, best_n


def find_segment(
    kind: str,
    fps: dict[int, tuple[Fingerprint, float]],
    *,
    duration_by_ep: dict[int, float] | None = None,
) -> DerivedSegment | None:
    """The repeated OP/ED segment across sampled episodes, or None.

    `fps` = {episode: (window fingerprint, window absolute start)}. For an ED,
    `duration_by_ep` lets positions be compared from the episode END (encodes
    differ in total length, so absolute starts legitimately disagree while
    seconds-from-end agree) — this mirrors multi_host's ED anchoring.
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

    # Cross-episode position agreement, on the duration-independent anchor.
    def anchor(ep: int) -> float:
        start = per_ep[ep][0]
        if kind == "ed" and duration_by_ep and duration_by_ep.get(ep):
            return duration_by_ep[ep] - start
        return start

    _center, support = _agree([anchor(e) for e in per_ep], tol=POSITION_TOLERANCE_S)
    if support < MIN_SUPPORT:
        return None

    length = statistics.median(ln for _s, ln in per_ep.values())
    if not (validate.MIN_THEME_LEN_S <= length <= validate.MAX_THEME_LEN_S):
        return None

    # Slice the reference from the episode whose observation is most supported
    # (most pairs agreeing) — the cleanest copy of the segment.
    ref_ep = max(per_ep, key=lambda e: len(spans[e]))
    return DerivedSegment(
        kind=kind,
        episode=ref_ep,
        start=per_ep[ref_ep][0],
        length=length,
        support=support,
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
