"""Audio extraction + on-disk caching.

ffmpeg pulls mono PCM at SAMPLE_RATE. We cache the raw float32 samples as .npy
keyed by (source path, mtime, sample_rate) so a library of hundreds of episodes
is never re-decoded needlessly (spec: never recompute uselessly).
"""

from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path

import numpy as np

from . import SAMPLE_RATE

# ashowinfo prints one `pts_time:<abs seconds>` per audio frame to stderr; with
# -copyts these are ABSOLUTE episode timestamps. We only need the first (the pts
# of output sample 0) to anchor the window on the shared absolute clock.
_ASHOWINFO_PTS_RE = re.compile(rb"pts_time:([\d.]+)")


def _cache_key(src: Path, sample_rate: int) -> str:
    st = src.stat()
    raw = f"{src.resolve()}|{st.st_size}|{int(st.st_mtime)}|{sample_rate}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def load_audio(
    src: str | Path,
    *,
    sample_rate: int = SAMPLE_RATE,
    cache_dir: str | Path = "cache/audio",
    cache_key: str | None = None,
    referer: str | None = None,
    window: tuple[float | None, float | None] | None = None,
) -> np.ndarray:
    """Return mono float32 samples in [-1, 1], cached on disk.

    `src` may be a local file OR any URL ffmpeg can read (http/m3u8) — that is
    how the real-episode adapter feeds streamed audio in without downloading
    video.

    `window=(start_s, dur_s)` decodes ONLY that slice via ffmpeg input seeking
    (`-ss`/`-t` BEFORE `-i`), so for a streamed URL ffmpeg issues an HTTP Range
    request (mp4) or fetches only the covering HLS segments (m3u8) — it does NOT
    pull the whole ~24 min episode. This is the main speedup for OP/ED: the OP
    lives in the first minutes and the ED in the last, so two short windows
    replace a full-episode download. `start_s=None` means from the start;
    `start_s<0` seeks from END-OF-FILE (`-sseof`), ideal for the ED window.
    `dur_s=None` means "to the end". Input seeking is coarse (nearest keyframe),
    but the offset-histogram matcher recovers the absolute alignment anyway, so
    the residual seek error does not hurt precision.

    Caching:
      - local file -> keyed by path+size+mtime automatically.
      - URL        -> NOT cacheable by URL (signed tokens rotate), so pass an
        explicit stable `cache_key` (e.g. "snk/s1/vostfr/ep1"). Without one,
        URL audio is decoded fresh every call (the slow path).
      - a `window` is folded into the cache filename, so the OP window and the
        ED window of the same episode cache independently and never collide.
    """
    src = Path(src) if "://" not in str(src) else src
    is_url = not isinstance(src, Path)

    win_tag = ""
    if window is not None:
        start_s, dur_s = window
        win_tag = f".w{'' if start_s is None else round(start_s, 1)}_{'' if dur_s is None else round(dur_s, 1)}"

    cache_file = None
    if cache_key is not None:
        safe = cache_key.replace("/", "__").replace("\\", "__")
        cache_dir = Path(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / f"{safe}{win_tag}.{sample_rate}.npy"
    elif not is_url:
        cache_dir = Path(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / f"{_cache_key(src, sample_rate)}{win_tag}.npy"

    if cache_file is not None and cache_file.exists():
        return np.load(cache_file)

    samples = _ffmpeg_decode(str(src), sample_rate, referer=referer, window=window)

    if cache_file is not None:
        np.save(cache_file, samples)
    return samples


def decode_audio_abs(
    src: str,
    start_abs: float,
    dur: float | None = None,
    *,
    sample_rate: int = SAMPLE_RATE,
    referer: str | None = None,
) -> tuple[np.ndarray, float]:
    """Decode `[start_abs, start_abs+dur]` (or to EOF when `dur` is None) with
    ABSOLUTE timestamps, returning `(mono float32 samples, abs_start)`.

    `abs_start` is the true absolute episode time (seconds) of output sample 0.
    A keyframe/segment seek rounds `start_abs` (megaplay landed at 1260.0 for a
    requested 1254.99), so we recover the realized start from `ashowinfo` rather
    than trusting the requested value. `-copyts` keeps the muxer from rebasing
    timestamps to zero, so those pts are absolute.

    This is the audio half of the shared-clock foundation: the video decoder
    (`video_fingerprint.keyframe_hashes_abs`) uses the same `-copyts` + absolute
    `-ss`, so both timelines share one clock and
    `theme_t0_abs = abs_start + q_start_seconds` is directly comparable to the
    video match's absolute offset — no `-sseof` anchor guessing, no A/V drift.
    """
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info"]
    if referer:
        cmd += ["-headers", f"Referer: {referer}\r\n"]
    if _is_hls_url(src):
        cmd += ["-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0"]
    # -copyts + absolute -ss (before -i) → range-limited fetch AND absolute pts.
    # Bound the end with -to (ABSOLUTE, before -i): with -copyts the timeline is
    # absolute, so `-t <dur>` is measured against it and truncates to ~nothing on
    # HLS (megaplay: `-t 113` yielded 2 frames). `-to <start+dur>` gives the full
    # window. None dur → decode to EOF.
    cmd += ["-copyts", "-ss", str(start_abs)]
    if dur is not None:
        cmd += ["-to", str(start_abs + dur)]
    cmd += ["-i", src]
    cmd += [
        "-vn",
        "-af", f"aresample={sample_rate},ashowinfo",  # ashowinfo → per-frame abs pts
        "-ac", "1",
        "-ar", str(sample_rate),
        "-f", "f32le",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"ffmpeg (abs) failed for {src!r}:\n{err}")
    samples = np.frombuffer(proc.stdout, dtype="<f4").copy()
    if samples.size == 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(
            f"ffmpeg returned 0 bytes of audio for {src!r} "
            f"(start_abs={start_abs}, dur={dur}). stderr:\n{err}"
        )
    m = _ASHOWINFO_PTS_RE.search(proc.stderr)
    abs_start = float(m.group(1)) if m else float(start_abs)
    return samples, abs_start


def _is_hls_url(src: str) -> bool:
    """True if `src` points at an HLS playlist (.m3u8), ignoring query params.

    The `-allowed_extensions` / `-allowed_segment_extensions` /
    `-extension_picky` flags below are private options of ffmpeg's HLS
    demuxer (`hls,applehttp`). They do not exist for other demuxers (e.g.
    plain MP4, as served by sendvid) and ffmpeg hard-errors with
    "Option ... not found" if you pass them for a non-HLS input. So they must
    only be added when the source is actually an .m3u8 — never unconditionally.
    """
    return ".m3u8" in src.split("?", 1)[0].lower()


def _ffmpeg_decode(
    src: str,
    sample_rate: int,
    referer: str | None = None,
    window: tuple[float | None, float | None] | None = None,
) -> np.ndarray:
    """Decode `src` to mono float32 PCM via ffmpeg, read from stdout.

    Some hosts (embed4me, megaplay's mewstream/zapora CDN) 403 the m3u8
    unless a Referer header is sent; pass it via `referer`. Sibnet's noip
    URLs need nothing.

    Some HLS hosts (megaplay's zapora CDN) serve real media segments under a
    disguised extension (e.g. `.jpg` for actual audio/video segments, an
    anti-scraping trick). ffmpeg's default segment-extension allowlist
    rejects those with "Invalid data found" unless we relax it — but that
    relaxation is HLS-only, see `_is_hls_url`.

    When `window=(start_s, dur_s)` is given, seek options go BEFORE `-i` so the
    seek happens at the demuxer/network layer (fast, range-limited download)
    rather than after full decode. A negative `start_s` uses `-sseof` to seek
    relative to end-of-file — the cheap way to grab just the ED tail.
    """
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if referer:
        cmd += ["-headers", f"Referer: {referer}\r\n"]
    if _is_hls_url(src):
        cmd += ["-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0"]
    if window is not None:
        start_s, dur_s = window
        if start_s is not None:
            # Input seeking: placed before -i so ffmpeg range-requests / skips
            # segments instead of decoding from 0.
            cmd += (["-sseof", str(start_s)] if start_s < 0 else ["-ss", str(start_s)])
        cmd += ["-i", src]
        if dur_s is not None:
            cmd += ["-t", str(dur_s)]
    else:
        cmd += ["-i", src]
    cmd += [
        "-vn",                      # audio only — never touch video
        "-ac", "1",                 # mono
        "-ar", str(sample_rate),    # downsample
        "-f", "f32le",              # raw float32 little-endian to stdout
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"ffmpeg failed for {src!r}:\n{err}")
    samples = np.frombuffer(proc.stdout, dtype="<f4").copy()
    if samples.size == 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(
            f"ffmpeg returned 0 bytes of audio for {src!r} (window={window!r}) "
            f"— stream likely unreachable/empty for this segment. stderr:\n{err}"
        )
    return samples
