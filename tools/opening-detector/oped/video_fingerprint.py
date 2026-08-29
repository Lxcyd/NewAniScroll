"""Keyframe perceptual-hash video fingerprinting — the OP/ED detector's
complementary signal to audio (see `fingerprint.py`/`matcher.py`).

WHY THIS EXISTS
----------------
Audio alone has precise blind spots: a cold-open with no real theme song, a
VF dub that ducks/mutes the OP/ED theme under dialogue, an encode that trims
the last second of audio in a bad fade, or aggressive audio compression on
one host that starves the hash-collision vote below `min_votes` — in every
one of these cases the PICTURE is untouched even though the audio signal is
degraded or absent. Video is a complementary signal, not a replacement: its
temporal resolution is far coarser than audio's (~seconds vs ~11.6ms), but it
covers exactly the failure modes where audio is the corrupted channel.

APPROACH — same architecture as audio, applied to images
----------------------------------------------------------
  1. Decode ONLY the I-frames (`-skip_frame:v nokey`) — a GOP is typically
     2-10s, so a 4-minute window yields ~25-100 keyframes instead of ~5700 at
     24fps decoding everything. This is the entire cost lever: full decode is
     expensive, keyframe-only decode is nearly free.
  2. Downscale radically (64x36, grayscale) — plenty for a perceptual hash,
     negligible CPU/bandwidth.
  3. Hash each frame with dHash (64-bit gradient-difference hash) — fast,
     robust to re-encode noise, insensitive to small color/brightness shifts
     between hosts.
  4. Match via the SAME offset-histogram voting as audio (see `matcher.py`),
     except equality-of-hash becomes Hamming-distance-within-tolerance
     (frames re-encoded by a different host are never bit-identical), and the
     span-clustering gap is wider than audio's since keyframe anchors are far
     sparser than audio anchors.

Precision: a video-only match is accurate to about one GOP length (a few
seconds) — not frame-accurate like audio, but plenty for a skip button.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# Downscale target for the perceptual hash. 64x36 keeps 16:9 aspect ratio;
# dHash needs (hash_w+1) x hash_h pixels for its horizontal-gradient scheme.
HASH_W = 8            # -> 64-bit hash (HASH_W * HASH_H bits)
HASH_H = 8
def _run_timed(cmd, src):
    """ffmpeg with a wall-clock ceiling — see audio.FFMPEG_TIMEOUT_S for why a
    missing timeout froze a whole overnight lot."""
    from .audio import FFMPEG_TIMEOUT_S
    try:
        return subprocess.run(cmd, capture_output=True, timeout=FFMPEG_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"ffmpeg timeout after {FFMPEG_TIMEOUT_S:.0f}s for {src!r} — "
            f"host stalled, skipping"
        ) from None


SCALE_W = 32          # smaller than before: we sample many more frames now
SCALE_H = 18          # (fixed-rate, not keyframe-only), so keep each one tiny

# Matching tolerance / clustering, deliberately looser than audio's since
# re-encodes are never bit-identical. TWO thresholds, chosen by what the image
# reference is (see theme_bank._video_hit_for):
#
#   HAMMING_THRESHOLD (12) — the NC-only FALLBACK. When AnimeThemes has no
#     credited rip, the reference is a CLEAN clip while the episode has credits
#     composited over the same footage. We measured that "credit penalty" by
#     frame-aligning a theme's credited vs NC rip: median ~2 bits when credits
#     are sparse (bocchi OP1) but ~10 on busy endings (bocchi ED1/ED2) and ~30
#     on a dense sequence (chainsaw OP1) — i.e. it can reach random-pair range
#     (~32). 12 is the pragmatic ceiling that still keeps SOME true pairs in the
#     bad case without dragging in junk; 8 starved the vote below min_votes.
#
#   HAMMING_THRESHOLD_CREDITED (8) — the DEFAULT now that a credited reference
#     exists for almost every theme. Episode-credited vs reference-credited pays
#     re-encode noise ONLY (the credit overlay is present on BOTH sides and
#     cancels), so the true-pair distance collapses back to a few bits and we can
#     tighten to 8 — sharper spans, fewer spurious clusters — while a random
#     frame pair still averages ~32 bits apart, well clear.
HAMMING_THRESHOLD = 12          # bits (out of 64) — NC-only fallback reference.
HAMMING_THRESHOLD_CREDITED = 8  # credited reference: only re-encode noise remains.
CLUSTER_GAP_S = 4.0       # dense-span clustering gap, seconds. At 2fps sampling
                          # (see SAMPLE_FPS) anchors are dense, so a real OP/ED
                          # segment has no internal gap this large — a jump this
                          # big means a different (spurious) cluster.

# Fixed-rate sampling beats I-frame-only for THIS job. Keyframe-only decoding is
# cheapest, but a 90s OP has only ~10-45 I-frames; after Hamming filtering and
# clustering that leaves too few votes and yields 6-18s spans instead of ~90s.
# Sampling at a low fixed rate (downscaled to gray, still tiny) gives ~180
# anchors over a 90s theme — dense enough for a credible span and a strong vote,
# for a negligible decode cost since we downscale to 32x18 gray.
SAMPLE_FPS = 2.0

# Dense edge refinement. The coarse 2fps match localises an edge to ~1s (2fps
# sampling + 1s vote bins); we then re-decode a TIGHT window around each edge at
# a much higher rate to pin the sub-second transition where the episode frames
# start/stop matching the credited reference. Cost is bounded: ±3s * 12fps ≈ 72
# tiny (32x18 gray) frames per edge.
DENSE_FPS = 12.0                          # ~83ms/frame → well under the 0.25s target
DENSE_HALF_WINDOW_S = 3.0                 # search ±3s around the coarse edge
DENSE_EDGE_HAMMING = HAMMING_THRESHOLD_CREDITED  # credited-vs-credited: re-encode noise only


@dataclass
class VideoFingerprint:
    """Keyframe dHashes for one clip/window. Parallel arrays, time-sorted."""

    hashes: np.ndarray   # uint64, one 64-bit dHash per keyframe
    times: np.ndarray    # float32, seconds (window offset added by the caller,
                          # same convention as theme_bank.ThemeHit)
    n_frames: int        # keyframes actually decoded (coverage/debug stat)

    def save(self, path) -> None:
        np.savez_compressed(path, hashes=self.hashes, times=self.times, n_frames=self.n_frames)

    @classmethod
    def load(cls, path) -> "VideoFingerprint":
        d = np.load(path)
        return cls(d["hashes"], d["times"], int(d["n_frames"]))


@dataclass
class VideoMatch:
    """A repeated segment found between query and reference keyframes."""

    n_votes: int
    q_start: float
    q_end: float
    r_start: float
    r_end: float
    score: float
    # The winning alignment offset (query_time - ref_time), i.e. where the clip's
    # r=0 lands in query time. Stable anchor for a frame-accurate credited
    # projection: theme frame 0 = offset, theme frame T = offset + T.
    offset: float = 0.0
    # RAW matched clip-time extent at the winning offset, BEFORE dense-span
    # clustering (r_start/r_end above are the clustered sub-span). A credited
    # projection uses this so a >gap_s hole in the middle of a real theme doesn't
    # truncate the delivered end to a sub-cluster.
    r_start_raw: float = 0.0
    r_end_raw: float = 0.0

    @property
    def duration(self) -> float:
        return self.q_end - self.q_start


_SHOWINFO_PTS_RE = re.compile(rb"pts_time:([\d.]+)")


def _parse_keyframe_raw(
    raw_video: bytes, stderr: bytes, scale_w: int, scale_h: int
) -> tuple[np.ndarray, np.ndarray]:
    """Turn raw grayscale keyframe bytes + ffmpeg's `showinfo` stderr into
    (hashes[uint64], times[float32 seconds]).

    Split out from `_ffmpeg_keyframe_hashes` so a caller that already ran its
    OWN ffmpeg process (e.g. a future fused audio+video single-fetch decoder
    in audio.py) can reuse this parsing/hashing step without re-invoking
    ffmpeg a second time for the same window.
    """
    frame_bytes = scale_w * scale_h
    n_frames = len(raw_video) // frame_bytes
    if n_frames == 0:
        return np.empty(0, np.uint64), np.empty(0, np.float32)
    frames = np.frombuffer(raw_video[: n_frames * frame_bytes], dtype=np.uint8).reshape(
        n_frames, scale_h, scale_w
    )

    pts = [float(m.group(1)) for m in _SHOWINFO_PTS_RE.finditer(stderr)]
    # showinfo's pts count SHOULD equal the decoded frame count, but the `fps=`
    # filter routinely flushes a few extra duplicated/padding frames at segment
    # boundaries on HLS (seen on megaplay: 360 rawvideo frames vs 350 showinfo
    # pts) — those trailing frames carry no pts line. Earlier this ANY mismatch
    # discarded every real timestamp for a synthetic 1s-spaced linspace, which
    # both doubled the spacing (true rate is SAMPLE_FPS=2) and de-anchored the
    # timeline, smearing the offset histogram and starving the vote below
    # min_votes — the ED video match then always returned None. Instead: keep the
    # real pts, and align frames↔pts by their common prefix (both are in emission
    # order, so pair i is frame i with pts i). Drop the untimed tail frames rather
    # than the timestamps. Only when showinfo yielded NOTHING do we synthesize
    # spacing, and then at the true 1/SAMPLE_FPS interval, not 1s.
    if pts:
        keep = min(len(pts), n_frames)
        frames = frames[:keep]
        times = np.asarray(pts[:keep], dtype=np.float32)
    else:
        step = 1.0 / SAMPLE_FPS
        times = np.arange(n_frames, dtype=np.float32) * step

    hashes = _dhash_batch(frames)
    return hashes, times


def _ffmpeg_keyframe_hashes(
    src: str,
    *,
    referer: str | None = None,
    window: tuple[float | None, float | None] | None = None,
    fps: float = SAMPLE_FPS,
) -> tuple[np.ndarray, np.ndarray]:
    """Decode `src` (optionally within `window`) sampled at a fixed `fps`,
    downscaled to grayscale 32x18, and return (hashes[uint64], times[float32
    seconds]).

    We deliberately do NOT restrict to I-frames anymore: a 90s theme has only a
    handful of keyframes, too few to vote a credible span (that was the cause of
    the 6-18s spurious spans). Sampling at `fps` (default 2) yields ~180 anchors
    over a 90s theme for a negligible cost — each frame is 32x18 gray (576 bytes)
    and the `fps` filter drops the rest of the stream before scaling.

    Single ffmpeg process: the `fps=` filter resamples to the fixed rate and
    `showinfo` prints each OUTPUT frame's `pts_time` to stderr, which we parse
    for exact per-frame timestamps without a second ffprobe pass.

    Same URL/header handling as `audio._ffmpeg_decode`: demuxer flags gated on
    the source shape (.m3u8 / .ffconcat), `-headers` only for http inputs,
    `-ss`/`-sseof` seek BEFORE `-i` for window decoding — imported from
    `audio.py` rather than duplicated, so both call sites can never disagree.
    """
    from .audio import _hls_flags, _input_headers  # single source of truth

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info"]
    cmd += _input_headers(src, referer)
    cmd += _hls_flags(src)
    if window is not None:
        start_s, dur_s = window
        if start_s is not None:
            cmd += (["-sseof", str(start_s)] if start_s < 0 else ["-ss", str(start_s)])
        cmd += ["-i", src]
        if dur_s is not None:
            cmd += ["-t", str(dur_s)]
    else:
        cmd += ["-i", src]

    cmd += [
        "-vf", f"fps={fps},scale={SCALE_W}:{SCALE_H},format=gray,showinfo",
        "-an",           # video only — audio is a separate pass (see audio.py)
        "-f", "rawvideo",
        "-pix_fmt", "gray",
        "-",
    ]
    # Timed for the same reason as audio.py's decodes: an unbounded ffmpeg on a
    # remote stream hangs the entire batch when the CDN stops answering.
    proc = _run_timed(cmd, src)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"ffmpeg (keyframes) failed for {src!r}:\n{err}")

    return _parse_keyframe_raw(proc.stdout, proc.stderr, SCALE_W, SCALE_H)


def keyframe_hashes_abs(
    src: str,
    start_abs: float,
    dur: float | None = None,
    *,
    fps: float = SAMPLE_FPS,
    referer: str | None = None,
    cache_key: str | None = None,
    cache_dir: str | Path = "cache/video",
) -> VideoFingerprint:
    """Decode `[start_abs, start_abs+dur]` at `fps`, downscaled gray, with
    ABSOLUTE timestamps (`-copyts` + absolute `-ss`), returning a
    VideoFingerprint whose `times` are absolute episode seconds.

    Measured on megaplay's HLS: with `-copyts` the `showinfo` pts come out
    absolute (first frame pts 1260.0 for a `-ss 1254.99`) and agree with the
    audio pass's `ashowinfo` pts (1260.08) to within the container A/V offset —
    i.e. audio and video share ONE clock. This is what lets the image own the
    boundary in absolute time without any `-sseof` anchor or A/V reconciliation.
    The `times` are used as-is (no window offset added by the caller).

    When `cache_key` is given the result is cached on disk keyed by
    (cache_key, start_abs, dur, fps): the v2 ALIGN window is derived from the
    coarse audio t0, which is deterministic per (host, episode), so the abs
    window is stable across re-runs and the native decode is skipped on a hit.
    Rounded to 0.1s so trivial float jitter doesn't miss the cache.
    """
    from .audio import _hls_flags, _input_headers
    from .megaplay import is_megaplay, materialize_window

    cache_file = None
    if cache_key is not None:
        safe = cache_key.replace("/", "__").replace("\\", "__")
        s_tag = f"{round(start_abs, 1)}"
        d_tag = "" if dur is None else f"{round(dur, 1)}"
        f_tag = "native" if fps is None else f"{fps:g}"
        cache_dir = Path(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / f"{safe}.abs{s_tag}_{d_tag}.fps{f_tag}.vfp.npz"
        if cache_file.exists():
            return VideoFingerprint.load(cache_file)

    # Megaplay's HLS segments are PNG-decoy-wrapped (ffmpeg sees a lone
    # `Video: png`, no real video/audio). Materialise the window as a local,
    # de-PNG'd .ts that keeps the same absolute PTS, so the `-copyts -ss/-to`
    # decode below works on it unchanged. See oped/megaplay.py + audio.py.
    if is_megaplay(src, referer):
        src = materialize_window(src, start_abs, dur, referer=referer)
        referer = None

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info"]
    cmd += _input_headers(src, referer)
    cmd += _hls_flags(src)
    # -to (ABSOLUTE end, before -i) not -t: with -copyts the timeline is absolute
    # so -t truncates to ~nothing on HLS (megaplay: 2 frames). See audio.py.
    cmd += ["-copyts", "-ss", str(start_abs)]
    if dur is not None:
        cmd += ["-to", str(start_abs + dur)]
    cmd += ["-i", src]
    # fps=None → NO fps filter: decode every native frame with its real pts. Used
    # for edge refinement, where sampling to a grid would cap precision at the
    # grid; native frames give ±1 real frame (~42ms) accuracy.
    scale_chain = f"scale={SCALE_W}:{SCALE_H},format=gray,showinfo"
    vf = scale_chain if fps is None else f"fps={fps},{scale_chain}"
    cmd += ["-vf", vf, "-an", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    proc = _run_timed(cmd, src)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"ffmpeg (abs keyframes) failed for {src!r}:\n{err}")
    hashes, times = _parse_keyframe_raw(proc.stdout, proc.stderr, SCALE_W, SCALE_H)
    vfp = VideoFingerprint(hashes, times, n_frames=len(hashes))
    if cache_file is not None and hashes.size:
        vfp.save(cache_file)
    return vfp


def _dhash_batch(frames: np.ndarray) -> np.ndarray:
    """Vectorized dHash: for each frame, compare adjacent-pixel brightness on
    an (HASH_W+1) x HASH_H grid — bit=1 if left pixel < right pixel. Robust to
    re-encode brightness/contrast shifts since it's a GRADIENT sign, not an
    absolute pixel-value comparison.
    """
    n = frames.shape[0]
    small = _resize_gray_batch(frames, HASH_W + 1, HASH_H)
    diff = small[:, :, 1:] > small[:, :, :-1]   # (n, HASH_H, HASH_W) bool
    bits = diff.reshape(n, -1)                  # (n, HASH_W*HASH_H)
    weights = 1 << np.arange(bits.shape[1], dtype=np.uint64)
    return (bits.astype(np.uint64) * weights).sum(axis=1)


def _resize_gray_batch(frames: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    """Area-averaging batch downscale (box filter). Each output cell is the MEAN
    of the input pixels it covers, not a single sampled pixel.

    Averaging (vs the earlier nearest-neighbor sampling) is what makes the dHash
    stable ACROSS HOSTS: a re-encode adds block/ringing noise and shifts pixels
    by a fraction, so a single sampled pixel can flip a gradient sign, but the
    average over a cell barely moves. This is exactly the robustness the
    cross-host match needs — it's why some hosts (sibnet/vidmoly) were falling
    past the Hamming threshold before while megaplay passed. Frames are tiny
    (32x18), so the double reduceat is cheap and needs no image library.
    """
    _, h, w = frames.shape
    f = frames.astype(np.float32)
    # Row edges: split [0,h) into out_h near-equal contiguous bands, average each.
    y_edges = (np.arange(out_h) * h // out_h)
    x_edges = (np.arange(out_w) * w // out_w)
    y_counts = np.diff(np.append(y_edges, h))
    x_counts = np.diff(np.append(x_edges, w))
    rows = np.add.reduceat(f, y_edges, axis=1) / y_counts[None, :, None]
    cols = np.add.reduceat(rows, x_edges, axis=2) / x_counts[None, None, :]
    return cols


def extract_keyframe_hashes(
    src: str,
    *,
    cache_key: str | None = None,
    cache_dir: str | Path = "cache/video",
    referer: str | None = None,
    window: tuple[float | None, float | None] | None = None,
    fps: float = SAMPLE_FPS,
) -> VideoFingerprint:
    """Load-or-build a VideoFingerprint for `src`, cached on disk exactly like
    `theme_bank.cached_fingerprint` caches audio fingerprints — same
    (key, window) -> filename scheme, so the OP window, the ED window, and a
    whole-clip reference never collide, and a rerun skips the ffmpeg keyframe
    decode entirely on a cache hit.

    `fps` MUST be part of the cache identity: the same (key, window) decoded at
    the coarse SAMPLE_FPS and at DENSE_FPS produce completely different
    hashes/times, and returning one for the other silently corrupts the match.
    A dense re-decode over a small edge window (see `decode_dense_window`) is
    exactly this case. The tag is empty at SAMPLE_FPS so existing 2fps caches
    stay valid and aren't invalidated.
    """
    cache_dir = Path(cache_dir)
    win_tag = ""
    if window is not None:
        start_s, dur_s = window
        win_tag = f".w{'' if start_s is None else round(start_s, 1)}_{'' if dur_s is None else round(dur_s, 1)}"
    fps_tag = "" if fps == SAMPLE_FPS else f".fps{fps:g}"

    cache_file = None
    if cache_key is not None:
        safe = cache_key.replace("/", "__").replace("\\", "__")
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / f"{safe}{win_tag}{fps_tag}.vfp.npz"
        if cache_file.exists():
            return VideoFingerprint.load(cache_file)

    hashes, times = _ffmpeg_keyframe_hashes(src, referer=referer, window=window, fps=fps)
    fp = VideoFingerprint(hashes, times, n_frames=len(hashes))
    if cache_file is not None:
        fp.save(cache_file)
    return fp


# ── matching ─────────────────────────────────────────────────────────────────


# 8-bit popcount lookup table: _POPCOUNT_LUT[b] = number of set bits in byte b.
# Built once at import. Summing the eight per-byte counts of a uint64 gives its
# popcount with no Python-level loop.
_POPCOUNT_LUT = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


def _popcount64(x: np.ndarray) -> np.ndarray:
    """Bit-count of a uint64 array, via an 8-bit lookup table.

    Numpy has no native popcount. The previous version summed 64 shift+mask
    passes over the whole array — correct but ~64 uint64 ops/element. Instead we
    view each uint64 as its 8 constituent bytes, look each byte's set-bit count
    up in `_POPCOUNT_LUT`, and sum the 8 counts. Bit-for-bit identical result
    (verified against the shift-and-sum version across random inputs), but the
    per-element work drops from 64 passes to one gather + one reduce — measured
    ~3x faster on the (n_q, n_r) video distance matrix and ~17x on the 1-D
    landmark-anchor arrays. Called on every keyframe distance in
    `best_match_video`, `anchor_by_landmarks`, `landmark_scores` and the dense
    edge refiner, so it's the video path's inner CPU loop.
    """
    x = np.ascontiguousarray(x, dtype="<u8")
    # view the (…,) uint64 array as (…, 8) little-endian bytes, then LUT + sum.
    b = x.view(np.uint8).reshape(*x.shape, 8)
    return _POPCOUNT_LUT[b].sum(axis=-1).astype(np.int32)


def best_match_video(
    q: VideoFingerprint,
    r: VideoFingerprint,
    *,
    hamming_threshold: int = HAMMING_THRESHOLD,
    min_votes: int = 50,
    cluster_gap_s: float = CLUSTER_GAP_S,
) -> VideoMatch | None:
    """Same offset-histogram-voting idea as `matcher.best_match`, but every
    query keyframe is compared against every reference keyframe within
    Hamming distance — there's no exact-hash-equality shortcut like audio's
    sorted-hash intersection, since re-encoded frames are never bit-identical.
    Fine at these sizes: an O(n_q * n_r) distance matrix over tens-to-low-
    hundreds of keyframes is negligible.

    A "vote" is a (query_time, ref_time) pair whose hash distance is within
    `hamming_threshold`; the offset (q_time - r_time) with the most votes,
    clustered with a gap tolerance, is the alignment. Returns None below
    `min_votes`: at 2fps sampling a true 90s theme yields ~180 anchors and
    real matches land at 130-250 votes, while spurious hash-collision clusters
    top out around 25 — so a floor of 50 cleanly separates them (below it, junk
    clusters leak through and can even project past the episode end via the
    -sseof offset math).
    """
    if q.hashes.size == 0 or r.hashes.size == 0:
        return None

    dist = _popcount64(q.hashes[:, None] ^ r.hashes[None, :])   # (n_q, n_r)
    qi, ri = np.nonzero(dist <= hamming_threshold)
    if qi.size == 0:
        return None

    q_t = q.times[qi]
    r_t = r.times[ri]
    offsets = q_t - r_t

    # 1-second bins: keyframe timing jitter across re-encodes is larger than
    # audio's single-STFT-hop precision, and the target accuracy here is only
    # "a few seconds, GOP-level" anyway.
    binned = np.round(offsets).astype(np.int64)
    vals, counts = np.unique(binned, return_counts=True)
    top = int(np.argmax(counts))
    n_votes = int(counts[top])
    if n_votes < min_votes:
        return None

    sel = binned == vals[top]
    q_sel, r_sel = q_t[sel], r_t[sel]

    q_start, q_end, keep = _dense_span_video(q_sel, gap_s=cluster_gap_s)
    r_kept = r_sel[keep]
    span = max(q_end - q_start, 1e-6)
    return VideoMatch(
        n_votes=n_votes,
        q_start=q_start, q_end=q_end,
        r_start=float(r_kept.min()), r_end=float(r_kept.max()),
        score=n_votes / span,
        offset=float(vals[top]),
        # Full matched clip-time extent at this offset, ungated by clustering.
        r_start_raw=float(r_sel.min()), r_end_raw=float(r_sel.max()),
    )


def _dense_span_video(q_times: np.ndarray, *, gap_s: float):
    """Largest contiguous cluster of keyframe anchor times. Unlike audio's
    `matcher._dense_span`, video times are already seconds (not frame
    indices), so no HOP_SECONDS conversion is needed here.
    """
    order = np.argsort(q_times)
    qs = q_times[order]
    breaks = np.nonzero(np.diff(qs) > gap_s)[0]
    starts = np.concatenate(([0], breaks + 1))
    ends = np.concatenate((breaks + 1, [len(qs)]))
    best = int(np.argmax(ends - starts))
    lo, hi = starts[best], ends[best]
    keep = order[lo:hi]
    return float(qs[lo]), float(qs[hi - 1]), np.sort(keep)


# ── landmark (distinctive-frame) anchoring ────────────────────────────────────
#
# The precise, robust way to place a credited theme inside an episode: pick a few
# DISTINCTIVE reference frames (rich in detail, unique within the clip) and find
# where each re-appears in the episode. A distinctive frame has a rare dHash that
# relocates at the pixel in any re-encode, so its match is a sharp Hamming minimum
# — unlike a flat card/fade/black frame whose hash matches "everywhere". We anchor
# on those frames (NOT on the boundary, which may be a fade/solid), then project.
# Validated on JJK ED across all hosts incl. megaplay's sparse 2fps keyframes:
# accepted landmarks match at Hamming 0-3 with a wide 2nd-best gap, and the median
# theme_t0 is consistent to the sampling grid.


def landmark_scores(
    vfp: VideoFingerprint, *, neighbor_guard_s: float = 0.75
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-frame distinctiveness, from the dHash alone. Returns (score, detail,
    unique), parallel to vfp.hashes.

      detail  = min(popcount, 64-popcount) — bit balance. Flat/black/fade frames
                have a degenerate (mostly-0) hash → low detail; textured frames
                balance near 32 → high detail.
      unique  = min Hamming distance to every frame that isn't a temporal
                neighbour (within neighbor_guard_s). A frame with a near-twin
                elsewhere is ambiguous to relocate; a frame with none has a sharp
                minimum in the episode search.
      score   = detail * unique (both must be high).
    """
    h, t = vfp.hashes, vfp.times
    n = len(h)
    if n == 0:
        z = np.empty(0, np.float64)
        return z, z, z
    pc = _popcount64(h)
    detail = np.minimum(pc, 64 - pc).astype(np.float64)
    if n == 1:
        return detail, detail, np.zeros(1, np.float64)
    dist = _popcount64(h[:, None] ^ h[None, :]).astype(np.float64)
    dt = np.abs(t[:, None].astype(np.float64) - t[None, :].astype(np.float64))
    dist[dt <= neighbor_guard_s] = np.inf
    unique = dist.min(axis=1)
    unique[~np.isfinite(unique)] = 0.0
    return detail * unique, detail, unique


# Landmark selection. Frame-accuracy of theme_t0 comes from anchoring MANY
# strong landmarks and taking their consensus (see anchor_by_landmarks), so the
# picker must SUPPLY many strong ones — the earlier k=4 / gap-floor=8s starved a
# 90s theme to ~6-8 landmarks (some weak), of which only ~3 localised, and the
# median was noisy (±3-5 frames). Measured on the visually FLAT JJK ED (unique
# median only ~6 bits): with a distinctiveness FLOOR (min_unique) plus a smaller
# gap floor, the same 90s clip yields ~15-20 landmarks that each localise at
# Hamming ≤ 8, and ~70% land within ±1 frame of the mode. LANDMARK_MIN_UNIQUE=10
# is the elbow: below it weak near-twin frames leak in and mislocalise; above 12
# a flat clip runs short. LANDMARK_GAP_FLOOR_S=3 keeps them spread across the clip
# (not clustered in one busy shot) while still fitting ~20 on a 90s theme.
LANDMARK_MIN_UNIQUE = 10   # min Hamming distance to any non-neighbour frame (bits)
LANDMARK_GAP_FLOOR_S = 3.0
LANDMARK_K = 24            # ceiling; a flat clip supplies fewer, a busy one caps here


def pick_landmarks(
    vfp: VideoFingerprint,
    *,
    k: int = LANDMARK_K,
    min_gap_floor_s: float = LANDMARK_GAP_FLOOR_S,
    min_unique: int = LANDMARK_MIN_UNIQUE,
) -> list[tuple[float, int]]:
    """Choose up to `k` distinctive, well-separated landmarks from a reference
    fingerprint. Returns [(r_time, hash_uint64), ...] sorted by time — storable
    on ThemeReference INDEPENDENT of the fingerprint, so localisation later needs
    only these pairs. Spread is enforced (>= min_gap) so the projection is
    anchored across the clip, not clustered in one spot.

    A frame is eligible only if its `unique` distinctiveness (min Hamming to any
    non-neighbour frame) is at least `min_unique`: a landmark with a near-twin
    elsewhere in the clip relocates ambiguously in the episode and drags the
    projection off by whole frames. Filtering these out at selection time is what
    turns the noisy median into a tight per-host consensus (see
    `anchor_by_landmarks`). On a flat clip this yields fewer than `k` landmarks;
    that is fine — quality over count.
    """
    if len(vfp.hashes) == 0:
        return []
    score, _detail, unique = landmark_scores(vfp)
    t = vfp.times
    order = np.argsort(score)[::-1]  # best first
    picked: list[int] = []
    for i in order:
        if len(picked) >= k:
            break
        if unique[i] < min_unique:
            continue
        if all(abs(float(t[i]) - float(t[j])) >= min_gap_floor_s for j in picked):
            picked.append(int(i))
    picked.sort(key=lambda i: float(t[i]))
    return [(float(t[i]), int(vfp.hashes[i])) for i in picked]


# Native NTSC-film frame period (23.976fps). Landmark theme_t0 estimates that
# come from a native decode land ON this grid, so we snap to it to find the
# consensus. Not host-configurable: every host we ingest is 23.976fps content.
FRAME_S = 1001.0 / 24000.0                     # ~0.04171s (~41.7ms)
LANDMARK_CONSENSUS_FRAMES = 1                    # ±1 frame counts as "agrees"
LANDMARK_MIN_CONSENSUS = 4                       # need this many agreeing landmarks


@dataclass
class LandmarkAnchor:
    """Result of anchoring a set of reference landmarks in an episode."""

    theme_t0: float      # consensus projected reference-frame-0 time (episode
                         # time, absolute when ep_vfp carries abs pts)
    n_accepted: int      # landmarks that passed the Hamming + separation guards
    n_total: int         # landmarks attempted
    spread_s: float      # max-min of ALL accepted estimates (incl. outliers)
    n_consensus: int     # accepted estimates within ±1 frame of the mode
    consensus_frac: float  # n_consensus / n_accepted — the confidence signal


def anchor_by_landmarks(
    ep_vfp: VideoFingerprint,
    landmarks: list[tuple[float, int]],
    *,
    hamming_max: int = HAMMING_THRESHOLD_CREDITED,
    sep_min: int = 6,
    guard_s: float = 1.0,
) -> LandmarkAnchor | None:
    """Locate each reference landmark in `ep_vfp` and project a robust theme_t0.

    For each (r_time, hash): find the episode frame with the smallest Hamming
    distance; ACCEPT it only when that best distance <= `hamming_max` AND the
    2nd-best distance (outside a `guard_s` temporal guard around the winner) is at
    least `sep_min` farther — i.e. the localisation is unambiguous. Each accepted
    landmark yields an estimate theme_t0 = ep_time - r_time.

    CONSENSUS, not plain median (the frame-accuracy fix): measured on a flat clip,
    accepted estimates form a SHARP mode on the native frame grid with a few
    whole-frame outliers (a landmark that relocated to a neighbouring GOP frame).
    A plain median is dragged by those outliers (±3-5 frames of "spread"). Instead
    we snap every estimate to the 23.976fps grid, take the MODE frame, average only
    the estimates within ±`LANDMARK_CONSENSUS_FRAMES` of it, and report the
    consensus fraction as confidence. This is what makes theme_t0 frame-accurate:
    the ~70% of landmarks that agree pin it to ±1 frame, and the outliers are
    dropped rather than averaged in.

    Because it anchors on distinctive frames INSIDE the theme, it is immune to
    fade/solid boundaries and to sparse keyframes — the failure modes of matching
    the boundary itself.
    """
    if ep_vfp.hashes.size == 0 or not landmarks:
        return None
    t0s: list[float] = []
    for r_time, h in landmarks:
        d = _popcount64(ep_vfp.hashes ^ np.uint64(h))
        j = int(np.argmin(d))
        best = int(d[j])
        guard = np.abs(ep_vfp.times - ep_vfp.times[j]) > guard_s
        second = int(d[guard].min()) if guard.any() else 64
        if best <= hamming_max and (second - best) >= sep_min:
            t0s.append(float(ep_vfp.times[j]) - r_time)
    if not t0s:
        return None
    arr = np.asarray(t0s)

    # Snap to the native frame grid and find the mode frame; the consensus is the
    # estimates within ±LANDMARK_CONSENSUS_FRAMES of that mode.
    frames = np.round(arr / FRAME_S).astype(np.int64)
    vals, counts = np.unique(frames, return_counts=True)
    mode_frame = int(vals[np.argmax(counts)])
    in_consensus = np.abs(frames - mode_frame) <= LANDMARK_CONSENSUS_FRAMES
    theme_t0 = float(arr[in_consensus].mean())
    return LandmarkAnchor(
        theme_t0=theme_t0,
        n_accepted=len(t0s),
        n_total=len(landmarks),
        spread_s=float(arr.max() - arr.min()),
        n_consensus=int(in_consensus.sum()),
        consensus_frac=float(in_consensus.mean()),
    )


# ── dense sub-second edge refinement ──────────────────────────────────────────


def refine_edge_credited_video(
    ep_fp: VideoFingerprint,
    ref_fp: VideoFingerprint,
    *,
    edge_kind: str,               # "start" | "end"
    theme_t0_ep_t: float,         # episode time where the credited ref frame 0 lands
    ep_win_off: float,            # abs episode time of ep_fp's window start
    ref_win_off: float,           # abs ref time of ref_fp's window start
    fps: float = DENSE_FPS,
    hamming_threshold: int = DENSE_EDGE_HAMMING,
) -> float | None:
    """Locate the exact sub-second EPISODE time of an OP/ED edge by comparing
    densely-sampled episode frames against the aligned credited reference.

    PURE — takes two already-built fingerprints and the coarse alignment, and
    returns the absolute episode edge time (or None to keep the coarse
    estimate). No ffmpeg here (see `decode_dense_window` for the decode side),
    so it is unit-testable with synthetic fingerprints.

    Alignment: the coarse match already told us where the reference's frame 0
    lands in episode time (`theme_t0_ep_t`), so an episode frame at absolute
    time `t_ep` should equal the reference frame at `t_ref = t_ep - theme_t0`.
    We pair each episode frame with its NEAREST reference frame in that mapped
    time (residual ≤ ~1/fps, well under 0.25s at 12fps) and mark it matched when
    the dHash Hamming distance is within `hamming_threshold`.

    Transition finding (robust to fade-to-black, where both sides fade together
    and keep matching INTO the fade, so the last matched frame is exactly the
    desired last credited frame):
      • sustain = max(3, round(0.4*fps)) — a lone in-black or spurious match
        can't define an edge.
      • "start": first episode time that BEGINS a sustained matched run.
      • "end":   last matched frame whose preceding `sustain` frames also match.
    No sustained run → None (caller keeps the coarse edge).
    """
    if ep_fp.hashes.size == 0 or ref_fp.hashes.size == 0:
        return None

    ep_t_abs = ep_fp.times.astype(np.float64) + ep_win_off
    ref_t_abs = ref_fp.times.astype(np.float64) + ref_win_off
    order = np.argsort(ep_t_abs)
    ep_t_abs = ep_t_abs[order]
    ep_hashes = ep_fp.hashes[order]

    # Map each episode frame into reference time and pair with the nearest ref
    # frame; drop frames whose nearest ref frame is farther than one frame
    # period (outside the reference's decoded extent → no valid comparison).
    ref_order = np.argsort(ref_t_abs)
    ref_t_sorted = ref_t_abs[ref_order]
    ref_hashes_sorted = ref_fp.hashes[ref_order]
    mapped = ep_t_abs - theme_t0_ep_t
    idx = np.searchsorted(ref_t_sorted, mapped)
    idx = np.clip(idx, 0, len(ref_t_sorted) - 1)
    # searchsorted lands on the frame just RIGHT of `mapped`; check its left
    # neighbour too and keep whichever is closer.
    left = np.clip(idx - 1, 0, len(ref_t_sorted) - 1)
    pick_left = np.abs(ref_t_sorted[left] - mapped) < np.abs(ref_t_sorted[idx] - mapped)
    nearest = np.where(pick_left, left, idx)
    residual = np.abs(ref_t_sorted[nearest] - mapped)
    valid = residual <= (1.0 / fps + 1e-3)

    dist = _popcount64(ep_hashes ^ ref_hashes_sorted[nearest])
    matched = valid & (dist <= hamming_threshold)
    if not matched.any():
        return None

    sustain = max(3, int(round(0.4 * fps)))
    n = matched.size

    if edge_kind == "start":
        run = 0
        for i in range(n):
            run = run + 1 if matched[i] else 0
            if run >= sustain:
                return float(ep_t_abs[i - sustain + 1])
        return None

    # "end": scan from the right for the last frame that closes a sustained run.
    run = 0
    for i in range(n - 1, -1, -1):
        run = run + 1 if matched[i] else 0
        if run >= sustain:
            return float(ep_t_abs[i + sustain - 1])
    return None


def decode_dense_window(
    src: str,
    edge_t: float,
    *,
    referer: str | None = None,
    cache_key: str | None = None,
    cache_dir: str | Path = "cache/video",
    fps: float = DENSE_FPS,
    half_window_s: float = DENSE_HALF_WINDOW_S,
) -> tuple[VideoFingerprint, float]:
    """Decode a tight ±`half_window_s` window around `edge_t` at high `fps`,
    returning (fingerprint, window_start_offset). The offset is the absolute
    time of the window's first sample so the caller can convert the
    fingerprint's window-relative `times` back to absolute (as
    `refine_edge_credited_video` expects via `*_win_off`).

    Window start is clamped to >= 0; the cache key includes fps (see
    `extract_keyframe_hashes`) so dense windows never alias the 2fps cache.
    """
    win_start = max(0.0, edge_t - half_window_s)
    dur = half_window_s * 2.0
    fp = extract_keyframe_hashes(
        src,
        cache_key=cache_key,
        cache_dir=cache_dir,
        referer=referer,
        window=(win_start, dur),
        fps=fps,
    )
    return fp, win_start