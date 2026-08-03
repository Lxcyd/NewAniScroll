"""Boundary refinement for matched OP/ED blocks.

The cross-episode matcher returns the full repeated block. When a shared recap
("Précédemment…") or cold-open is reused across episodes, it fingerprints as
repeated too and gets glued to the OP — inflating the block's LEFT edge by the
recap's length (verified on SnK S1: matched block started ~36s before the
musical OP onset).

Recap audio is speech/montage (lower, choppier RMS); the OP is sustained music
(higher, flatter RMS). So inside the matched block we find the onset of
sustained musical energy and snap the start there. The right edge (OP→silence
fall) the matcher already nails, so we only refine the side that needs it.
"""

from __future__ import annotations

import numpy as np

from . import SAMPLE_RATE
from .features import rms_envelope

# Back-compat alias; the canonical implementation now lives in features.py
# (vectorized). Kept so existing callers/tests importing _rms_envelope work.
_rms_envelope = rms_envelope


def refine_edges_ref_anchored(
    slice_samples: np.ndarray,
    *,
    proj_start_local: float,
    proj_end_local: float,
    vote_start_local: float,
    vote_end_local: float,
    r_start: float,
    r_end: float,
    ref_duration: float,
    sample_rate: int = SAMPLE_RATE,
    lead_s: float = 4.0,
    tail_extend_s: float = 4.0,
    sustain_s: float = 2.0,
    hop_s: float = 0.25,
) -> tuple[float, float]:
    """Snap projected OP/ED edges to the true music onset / music→silence cut,
    within bounds set by the reference geometry. Works in SLICE-LOCAL seconds
    (the caller passes a samples slice and the times expressed relative to that
    slice's start, then re-adds the base offset to the result).

    This is the reference-anchored refiner for the `theme_bank`/`multi_host`
    path (the old `refine_left_edge`/`refine_right_edge` below serve the legacy
    cross-episode path). The projection `[proj_start, proj_end]` already lines
    up with the AnimeThemes clip by construction (offset + [0, ref_duration]);
    this only corrects the residual where the episode's actual theme onset/cut
    sits a beat off the projection (a slightly different cut, a fade the encode
    lengthened/shortened). It NEVER invents a boundary far from the projection —
    every search is tightly bounded, and if no clear onset/cut is found the
    projected edge is returned unchanged.

    Left edge — find the music ONSET:
      • Search a small window around `proj_start_local`. If the vote span
        already reached the theme's true start (`r_start ≈ 0`), the onset may
        sit slightly LEFT of the dense votes (a fade the anchors missed), so we
        allow searching back to `proj_start_local - lead_s`. We never accept an
        onset earlier than the projection minus `lead_s`.
    Right edge — find the music→silence CUT:
      • The vote span's right edge (`vote_end_local`) is a lower bound; the true
        cut can sit up to `(ref_duration - r_end)` later (fade-out the anchors
        missed), plus a small `tail_extend_s` slack. Search that tail for the
        energy collapse.
    """
    n = slice_samples.size
    if n < sample_rate // 2:
        return proj_start_local, proj_end_local
    times, rms = rms_envelope(slice_samples, hop_s=hop_s)
    if rms.size < 3 or rms.max() <= 0:
        return proj_start_local, proj_end_local

    sustain_n = max(1, int(sustain_s / hop_s))

    # ── LEFT: music onset ────────────────────────────────────────────────────
    # Threshold on the theme body's own energy (median over the projected span),
    # so a quiet fade or lead-in dialogue sits below it and sustained music above.
    body_lo = max(0.0, proj_start_local)
    body_hi = min(times[-1], proj_end_local)
    body_mask = (times >= body_lo) & (times <= body_hi)
    thresh = float(np.median(rms[body_mask])) if body_mask.any() else float(np.median(rms))

    # Search band for the onset: from (projection - lead) up to the vote start
    # (the onset can't be later than where hashes already densely agreed).
    lo_t = max(0.0, proj_start_local - lead_s)
    hi_t = max(lo_t, min(vote_start_local, proj_end_local))
    band = np.nonzero((times >= lo_t) & (times <= hi_t))[0]
    refined_start = proj_start_local
    if band.size:
        above = rms[band] >= thresh
        run = 0
        onset_local_idx = None
        for i, a in enumerate(above):
            run = run + 1 if a else 0
            if run >= sustain_n:
                onset_local_idx = i - sustain_n + 1
                break
        if onset_local_idx is not None:
            cand = float(times[band[onset_local_idx]] - hop_s / 2)
            # Clamp: never earlier than the allowed lead, never past the votes.
            refined_start = float(min(max(cand, lo_t), hi_t))

    # ── RIGHT: music→silence cut ─────────────────────────────────────────────
    peak = float(rms.max())
    search_lo = max(refined_start, vote_end_local - 2.0)
    search_hi = min(times[-1], proj_end_local + tail_extend_s)
    tail = np.nonzero((times >= search_lo) & (times <= search_hi))[0]
    refined_end = proj_end_local
    if tail.size >= 2:
        rt = rms[tail]
        low = rt < 0.2 * peak
        cut_local_idx = None
        for i in range(1, len(low)):
            if low[i] and rt[i - 1] >= 0.2 * peak:
                cut_local_idx = i
                break
        if cut_local_idx is not None:
            cand = float(times[tail[cut_local_idx]] - hop_s / 2)
            refined_end = float(min(max(cand, search_lo), search_hi))

    if refined_end <= refined_start:
        return proj_start_local, proj_end_local
    return refined_start, refined_end


def refine_left_edge(
    samples: np.ndarray,
    block_start: float,
    block_end: float,
    *,
    hop_s: float = 0.25,
    sustain_s: float = 6.0,
) -> float:
    """Return a refined start: trim a non-musical recap/cold-open glued to the
    LEFT of the OP block, snapping the start to the music onset.

    Crucial guard: ONLY trim when the block actually STARTS with non-music. Many
    episodes have no recap (the OP begins at t=0), and a naive "first sustained
    energy onset" would cut several seconds INTO the OP (seen on SnK ep3/ep6:
    OP from 0:00, over-trimmed ~40s). So we first check whether the block's
    opening ~8s is dialogue-like; if it's already music, return unchanged.
    """
    s0 = int(block_start * SAMPLE_RATE)
    s1 = int(block_end * SAMPLE_RATE)
    block = samples[s0:s1]
    if block.size < SAMPLE_RATE:
        return block_start

    # Guard: a recap/cold-open only exists when the block starts well INTO the
    # episode (the recap pushed the OP later). If the OP block begins near t=0,
    # there's nothing in front of it to trim — refining would cut into the OP
    # itself (SnK ep3/ep6: OP from 0:00). DSP can't tell a music-backed recap
    # from the OP, but position can: only episodes with a real recap have a
    # late OP-block start.
    if block_start < 20.0:
        return block_start

    times, rms = _rms_envelope(block, hop_s=hop_s)
    if rms.size == 0:
        return block_start

    # Threshold = the block's own median energy. The OP (music) sits above it;
    # a quieter recap/dialogue sits below.
    thresh = np.median(rms)
    sustain_n = max(1, int(sustain_s / hop_s))

    above = rms >= thresh
    # Find the first index that starts a run of >= sustain_n consecutive
    # above-threshold windows.
    run = 0
    onset_idx = None
    for i, a in enumerate(above):
        run = run + 1 if a else 0
        if run >= sustain_n:
            onset_idx = i - sustain_n + 1
            break

    if onset_idx is None:
        return block_start

    refined = block_start + times[onset_idx] - 0.5  # -0.5: window center→edge
    # Never push the start past the block; clamp to [block_start, block_end].
    return float(min(max(refined, block_start), block_end))


def refine_right_edge(
    samples: np.ndarray,
    block_start: float,
    block_end: float,
    *,
    hop_s: float = 0.25,
    search_s: float = 12.0,
) -> float:
    """Return a refined end: the music→silence fall near block_end.

    A credits theme ends with a sharp energy drop to near-silence (verified on
    SnK: ED fell from ~0.12 to ~0.001 at the cut). We look in the last
    search_s seconds of the block for the largest sustained drop and snap the
    end there. If no clear fall is found, return block_end unchanged.
    """
    s0 = int(max(block_start, block_end - search_s) * SAMPLE_RATE)
    s1 = int(block_end * SAMPLE_RATE)
    tail = samples[s0:s1]
    if tail.size < SAMPLE_RATE:
        return block_end

    times, rms = _rms_envelope(tail, hop_s=hop_s)
    if rms.size < 3:
        return block_end

    peak = rms.max()
    # First index (scanning forward in the tail) where energy collapses below
    # 20% of the tail's peak and stays low — that's the credits cut.
    low = rms < 0.2 * peak
    cut_idx = None
    for i in range(1, len(low)):
        if low[i] and rms[i - 1] >= 0.2 * peak:
            cut_idx = i
            break

    if cut_idx is None:
        return block_end

    base = max(block_start, block_end - search_s)
    refined = base + times[cut_idx] - 0.5
    return float(min(max(refined, block_start), block_end))
