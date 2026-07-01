"""Level 3 — single-episode OP/ED fallback (DSP only).

Triggers STRICTLY when level-1 repetition found no valid OP or ED candidate
(e.g. SnK ep1's sung ED is unique and never repeats; or a per-episode ED à la
Monogatari). No fingerprint help here, so this is best-effort: ~±1-2s, lower
confidence (spec accepts this for the ~5-10% of cases it covers).

Method: scan the OP/ED zone for the longest run of sustained music
(features.score_segment over a sliding window), bounded on the relevant side by
a music↔non-music transition. For the ED we additionally anchor the END on the
music→silence fall, which is the most reliable single cue (verified on SnK: a
clean drop at the credits cut).
"""

from __future__ import annotations

import numpy as np

from . import SAMPLE_RATE
from .classify import Detection
from .features import score_segment, rms_envelope

WIN_S = 6.0
HOP_S = 2.0
MUSIC_MIN = 0.55          # stricter than classify: no repetition to lean on
MIN_DUR = 60.0
MAX_DUR = 115.0


def _music_profile(samples, t0: float, t1: float):
    """Sliding music_likelihood over [t0, t1]. Returns (times, scores)."""
    times, scores = [], []
    t = t0
    while t + WIN_S <= t1:
        seg = samples[int(t * SAMPLE_RATE): int((t + WIN_S) * SAMPLE_RATE)]
        scores.append(score_segment(seg).music_likelihood)
        times.append(t + WIN_S / 2)
        t += HOP_S
    return np.array(times), np.array(scores)


def _music_runs(times, scores):
    """All contiguous runs of scores >= MUSIC_MIN as (start, end) seconds."""
    above = scores >= MUSIC_MIN
    runs = []
    i, n = 0, len(above)
    while i < n:
        if above[i]:
            j = i
            while j < n and above[j]:
                j += 1
            runs.append((times[i] - WIN_S / 2, times[j - 1] + WIN_S / 2))
            i = j
        else:
            i += 1
    return runs


def _longest_music_run(times, scores):
    runs = _music_runs(times, scores)
    return max(runs, key=lambda r: r[1] - r[0]) if runs else None


def _ends_in_silence(samples, end, drop_s=4.0) -> bool:
    """True if energy falls to near-silence right after `end` — the credits cut.
    The real ED ends on a hard drop; a post-credits block that runs to the
    episode's end does not."""
    a = samples[int(end * SAMPLE_RATE): int((end + drop_s) * SAMPLE_RATE)]
    b = samples[int((end - drop_s) * SAMPLE_RATE): int(end * SAMPLE_RATE)]
    if a.size < SAMPLE_RATE // 2 or b.size < SAMPLE_RATE // 2:
        return False
    import numpy as _np
    ra = _np.sqrt(_np.mean(a * a))
    rb = _np.sqrt(_np.mean(b * b))
    return ra < 0.3 * (rb + 1e-9)


def _snap_end_to_silence(samples, start, end, search_s=14.0):
    """Anchor the ED end on the music→silence fall within search_s before end."""
    s0 = int(max(start, end - search_s) * SAMPLE_RATE)
    s1 = int((end + 6) * SAMPLE_RATE)
    tail = samples[s0:s1]
    if tail.size < SAMPLE_RATE:
        return end
    times, rms = rms_envelope(tail, hop_s=0.25)
    if rms.size < 3:
        return end
    peak = rms.max()
    base = max(start, end - search_s)
    for i in range(1, len(rms)):
        if rms[i] < 0.2 * peak and rms[i - 1] >= 0.2 * peak:
            return float(base + times[i] - 0.5)
    return end


def detect_ed(samples, duration: float) -> Detection | None:
    """Find the ED in the last ~6 min.

    The ED is a sustained-music block that ENDS ON A HARD DROP to silence (the
    credits cut). A trailing post-credits/preview block is also musical but does
    NOT end on such a drop (it runs into the episode end). So we enumerate music
    runs and prefer the longest one whose end snaps to a silence fall; only if
    none is silence-terminated do we fall back to the longest run.

    Search window: the last ~3.5 min only. A wider window catches mid-episode
    insert songs / musical action scenes (seen on SnK ep4: a music block at
    ~19:29) which are NOT the ED. The ED reliably sits in the final minutes.
    """
    t0 = max(0.0, duration - 210)
    times, scores = _music_profile(samples, t0, duration)
    if scores.size == 0:
        return None
    runs = _music_runs(times, scores)
    if not runs:
        return None

    # Snap each run's end to its music→quiet fall, then keep ED-duration runs.
    candidates = []
    for start, end in runs:
        snapped = _snap_end_to_silence(samples, start, end)
        candidates.append((start, snapped, snapped - start))

    # The ED is the FIRST sustained music block of ED-like duration in the late
    # zone. An episode can have a special ED *and* a later post-credits/preview
    # block (both musical — SnK ep1: special ED ~22:06, post-credits ~23:54).
    # The ED always comes first, so among ED-duration runs we pick the EARLIEST,
    # not the longest (which would grab the post-credits). We do NOT require a
    # hard silence cut: a credits theme often fades into quiet dialogue, not
    # digital silence, so a strict silence test misses real EDs.
    edlike = [c for c in candidates if MIN_DUR <= c[2] <= MAX_DUR]
    if edlike:
        start, end, _ = min(edlike, key=lambda c: c[0])
    else:
        # No ED-duration run — take the longest, clamp over-long toward ~90s.
        start, end, dur = max(candidates, key=lambda c: c[2])
        if dur > MAX_DUR:
            start = end - 90.0
        elif dur < MIN_DUR:
            return None

    conf = _conf(scores)
    return Detection(float(start), float(end), conf, "fallback")


def _conf(scores) -> float:
    hi = scores[scores >= MUSIC_MIN]
    med = float(np.median(hi)) if hi.size else 0.0
    return round(0.5 * med + 0.2, 3)


def detect_op(samples, duration: float) -> Detection | None:
    """Find the OP in the first ~6 min by sustained music (cold-open tolerated)."""
    t1 = min(duration, 360.0)
    times, scores = _music_profile(samples, 0.0, t1)
    if scores.size == 0:
        return None
    run = _longest_music_run(times, scores)
    if run is None:
        return None
    start, end = run
    dur = end - start
    if not (MIN_DUR <= dur <= MAX_DUR):
        return None
    conf = _conf(scores)
    return Detection(float(start), float(end), conf, "fallback")
