"""Audio extraction + on-disk caching.

ffmpeg pulls mono PCM at SAMPLE_RATE. We cache the raw float32 samples as .npy
keyed by (source path, mtime, sample_rate) so a library of hundreds of episodes
is never re-decoded needlessly (spec: never recompute uselessly).
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

import numpy as np

from . import SAMPLE_RATE


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
) -> np.ndarray:
    """Return mono float32 samples in [-1, 1], cached on disk.

    `src` may be a local file OR any URL ffmpeg can read (http/m3u8) — that is
    how the real-episode adapter feeds streamed audio in without downloading
    video.

    Caching:
      - local file -> keyed by path+size+mtime automatically.
      - URL        -> NOT cacheable by URL (signed tokens rotate), so pass an
        explicit stable `cache_key` (e.g. "snk/s1/vostfr/ep1"). Without one,
        URL audio is decoded fresh every call (the slow path).
    """
    src = Path(src) if "://" not in str(src) else src
    is_url = not isinstance(src, Path)

    cache_file = None
    if cache_key is not None:
        safe = cache_key.replace("/", "__").replace("\\", "__")
        cache_dir = Path(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / f"{safe}.{sample_rate}.npy"
    elif not is_url:
        cache_dir = Path(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / f"{_cache_key(src, sample_rate)}.npy"

    if cache_file is not None and cache_file.exists():
        return np.load(cache_file)

    samples = _ffmpeg_decode(str(src), sample_rate, referer=referer)

    if cache_file is not None:
        np.save(cache_file, samples)
    return samples


def _ffmpeg_decode(src: str, sample_rate: int, referer: str | None = None) -> np.ndarray:
    """Decode `src` to mono float32 PCM via ffmpeg, read from stdout.

    Some hosts (embed4me) 403 the m3u8 unless a Referer header is sent; pass it
    via `referer`. Sibnet's noip URLs need nothing.
    """
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if referer:
        cmd += ["-headers", f"Referer: {referer}\r\n"]
    cmd += [
        "-i", src,
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
    return np.frombuffer(proc.stdout, dtype="<f4").copy()
