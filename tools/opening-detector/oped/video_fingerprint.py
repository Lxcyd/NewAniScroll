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

    Same URL/header handling as `audio._ffmpeg_decode`: HLS-only flags gated
    on `.m3u8`, `-ss`/`-sseof` seek BEFORE `-i` for window decoding — imported
    from `audio.py` (`_is_hls_url`) rather than duplicated, so both call sites
    can never disagree on what counts as HLS.
    """
    from .audio import _is_hls_url  # single source of truth for HLS gating

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info"]
    if referer:
        cmd += ["-headers", f"Referer: {referer}\r\n"]
    if _is_hls_url(src):
        cmd += ["-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0"]
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
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"ffmpeg (keyframes) failed for {src!r}:\n{err}")

    return _parse_keyframe_raw(proc.stdout, proc.stderr, SCALE_W, SCALE_H)


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
) -> VideoFingerprint:
    """Load-or-build a VideoFingerprint for `src`, cached on disk exactly like
    `theme_bank.cached_fingerprint` caches audio fingerprints — same
    (key, window) -> filename scheme, so the OP window, the ED window, and a
    whole-clip reference never collide, and a rerun skips the ffmpeg keyframe
    decode entirely on a cache hit.
    """
    cache_dir = Path(cache_dir)
    win_tag = ""
    if window is not None:
        start_s, dur_s = window
        win_tag = f".w{'' if start_s is None else round(start_s, 1)}_{'' if dur_s is None else round(dur_s, 1)}"

    cache_file = None
    if cache_key is not None:
        safe = cache_key.replace("/", "__").replace("\\", "__")
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / f"{safe}{win_tag}.vfp.npz"
        if cache_file.exists():
            return VideoFingerprint.load(cache_file)

    hashes, times = _ffmpeg_keyframe_hashes(src, referer=referer, window=window)
    fp = VideoFingerprint(hashes, times, n_frames=len(hashes))
    if cache_file is not None:
        fp.save(cache_file)
    return fp


# ── matching ─────────────────────────────────────────────────────────────────


def _popcount64(x: np.ndarray) -> np.ndarray:
    """Bit-count of a uint64 array. Numpy has no native popcount, so unpack
    and sum — cheap here since keyframe counts are tiny (tens to low
    hundreds), nowhere near audio-hash scale.
    """
    x = x.astype(np.uint64).copy()
    count = np.zeros(x.shape, dtype=np.uint64)
    for _ in range(64):
        count += x & np.uint64(1)
        x >>= np.uint64(1)
    return count.astype(np.int32)


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