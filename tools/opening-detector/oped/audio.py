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
from .megaplay import is_megaplay, materialize_window, playlist_duration

# ashowinfo prints one `pts_time:<abs seconds>` per audio frame to stderr; with
# -copyts these are ABSOLUTE episode timestamps. We only need the first (the pts
# of output sample 0) to anchor the window on the shared absolute clock.
_ASHOWINFO_PTS_RE = re.compile(rb"pts_time:([\d.]+)")

# ffmpeg EXITS 0 after a partially-failed HTTP read: it reports the failure on
# stderr, fills what it could not fetch, and still writes a full-length stream.
# Checking only the return code and a non-empty buffer therefore accepts a
# degraded decode — which is then fingerprinted and CACHED, freezing the damage
# for every later run.
#
# Measured on charlotte ep2 / vidmoly-va: the cached 299.5 s window carried
# 19482 hashes against 23828 for a clean decode of the SAME window, and matched
# the OP at 563 votes / 42.5 s instead of 3501 votes / 33.1 s. Both decodes
# reported the full duration, so a length check cannot catch this — the audio
# was complete in extent and damaged in content. The host was dropped from the
# consensus and the failure looked like "vidmoly-va can't detect this episode".
#
# Raising instead of caching means the next run simply retries, exactly as
# theme_bank does for a truncated native reference decode. Deliberately narrow:
# only transport/decode failures, never the ordinary warnings ffmpeg prints on
# healthy streams.
_DECODE_ERROR_RE = re.compile(
    rb"Error in the pull function"
    rb"|Invalid data found when processing input"
    rb"|error while decoding"
    rb"|Connection reset|Broken pipe|Input/output error"
    rb"|Server returned 4|Server returned 5"
    rb"|Failed to (?:read|open)",
    re.IGNORECASE,
)


def _reject_degraded(stderr: bytes, src: str, what: str) -> None:
    """Raise when ffmpeg logged a transport/decode failure despite exiting 0."""
    hit = _DECODE_ERROR_RE.search(stderr or b"")
    if not hit:
        return
    err = stderr.decode("utf-8", "replace").strip()
    raise RuntimeError(
        f"ffmpeg exited 0 but reported a decode/transport failure for {src!r} "
        f"({what}) — refusing to cache a degraded decode. "
        f"Trigger: {hit.group(0).decode('utf-8', 'replace')!r}\nstderr:\n{err[-800:]}"
    )


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

    Megaplay's segments are PNG-decoy-wrapped, so ffmpeg reads its raw HLS as a
    lone `Video: png` stream with no audio and `-vn` yields 0 bytes. For megaplay
    we first materialise the window as a local, de-PNG'd .ts (see `oped.megaplay`)
    which keeps the same absolute PTS — the `-copyts -ss/-to` below then work on
    it unchanged, so the shared-clock contract still holds.
    """
    seek = start_abs
    if is_megaplay(src, referer):
        src = materialize_window(src, start_abs, dur, referer=referer)
        referer = None  # local file: no HTTP headers, no HLS demuxer flags
        # ffmpeg's input `-ss` is RELATIVE to the container's start_time (it adds
        # ic->start_time to the seek target, and `-seek_timestamp 1` does not
        # override that for mpegts — measured). The materialised .ts starts at the
        # first picked segment's PTS (~start_abs − _LEAD_S), not at 0, so passing
        # the absolute time seeks to roughly TWICE it, lands past EOF and decodes
        # zero frames. This only ever bit windows late in the episode — the ED —
        # which is why an OP-window materialisation (file starting at ~0) looked
        # fine. `-copyts` still keeps the OUTPUT pts absolute, so `ashowinfo`
        # below reports the true absolute anchor and the shared clock holds.
        seek = max(0.0, start_abs - _container_start(src))

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info"]
    cmd += _input_headers(src, referer)
    cmd += _hls_flags(src)
    # -copyts + absolute -ss (before -i) → range-limited fetch AND absolute pts.
    # Bound the end with -to (ABSOLUTE, before -i): with -copyts the timeline is
    # absolute, so `-t <dur>` is measured against it and truncates to ~nothing on
    # HLS (megaplay: `-t 113` yielded 2 frames). `-to <start+dur>` gives the full
    # window. None dur → decode to EOF.
    cmd += ["-copyts", "-ss", str(seek)]
    if dur is not None:
        cmd += ["-to", str(seek + dur)]
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
    _reject_degraded(proc.stderr, str(src), f"start_abs={start_abs}, dur={dur}")
    m = _ASHOWINFO_PTS_RE.search(proc.stderr)
    abs_start = float(m.group(1)) if m else float(start_abs)
    return samples, abs_start


def _container_start(path: str) -> float:
    """First timestamp of a LOCAL container, in seconds (0.0 if unknown).

    Only used to turn an absolute seek into the relative one ffmpeg's `-ss`
    actually wants; the probe is local, so it costs no network.
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=start_time",
         "-of", "default=nk=1:nw=1", path],
        capture_output=True, text=True,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


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


def _is_http(src: str) -> bool:
    return src.lower().startswith(("http://", "https://"))


def _input_headers(src: str, referer: str | None) -> list[str]:
    """`-headers` flags for the input, empty unless it is fetched over http.

    `-headers` belongs to ffmpeg's http protocol. Passing it for a LOCAL input
    is not merely useless, it is fatal: ffmpeg resolves the option against the
    file protocol, finds nothing and aborts with "Option headers not found"
    before it ever opens the input. The megaplay path already worked around
    this by nulling `referer` by hand after materialising its local .ts; this
    generalises that rule to every local input, which a split episode also is
    (bridge/resolve.mjs writes a local .ffconcat whose entries are remote).
    Those entries are then fetched by the demuxer's own http contexts, and
    measured against Vidmoly they need no Referer: the token is IP-bound.
    """
    if not referer or not _is_http(src):
        return []
    return ["-headers", f"Referer: {referer}\r\n"]


def _is_ffconcat(src: str) -> bool:
    """True for the concat list a split episode resolves to.

    See `_hls_flags` for why a split episode is fed through the concat demuxer
    rather than as one merged playlist.
    """
    return src.split("?", 1)[0].lower().endswith(".ffconcat")


def _hls_flags(src: str) -> list[str]:
    """Demuxer-specific input flags — empty for a plain file or MP4 URL.

    Two shapes need them, and their flag sets are mutually exclusive:

    HLS (.m3u8). The extension flags relax ffmpeg's segment allowlist (some
    hosts serve segments under decoy extensions).

    Concat list (.ffconcat). This is how a SPLIT episode arrives — one broadcast
    episode the host uploaded as two files (lib/multipartEpisodes.js), written
    by bridge/resolve.mjs. It is deliberately not a merged .m3u8: ffmpeg's HLS
    demuxer does not rebase timestamps across an `#EXT-X-DISCONTINUITY`, so on
    the real Re:Zero streams every seek past the junction (`-ss 1600`, `2000`,
    `2900`) decoded ZERO bytes, while the concat demuxer returned the full
    window at each. Passing the HLS flags here would be fatal, not merely
    useless — the concat demuxer aborts with "Option allowed_extensions not
    found" — hence the either/or.

    The protocol whitelist covers both: whenever the input is a LOCAL file
    whose entries are remote, ffmpeg defaults to `file,crypto,data` and refuses
    the http(s) URIs inside it. Remote inputs keep ffmpeg's own defaults — no
    behaviour change for any host that was already working.
    """
    if _is_ffconcat(src):
        return ["-f", "concat", "-safe", "0",
                "-protocol_whitelist", "file,crypto,data,http,https,tcp,tls"]
    if not _is_hls_url(src):
        return []
    flags = ["-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL",
             "-extension_picky", "0"]
    if not _is_http(src):
        flags += ["-protocol_whitelist", "file,crypto,data,http,https,tcp,tls"]
    return flags


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
    # Megaplay's PNG-decoy segments have to be de-wrapped locally (see
    # oped/megaplay.py) — ffmpeg reads the raw HLS as a lone `Video: png` with no
    # audio and `-vn` then errors with "Output file does not contain any stream".
    # `_ffmpeg_decode_abs` already did this; THIS path did not, so every window
    # decode (which is the one detect_anime actually calls) lost megaplay
    # whenever its rotating CDN served wrapped segments — silently, as a
    # per-host fetch failure rather than a wrong result. Measured on
    # erased/ep3 via megap.norami.top while SnK's CDN happened to serve
    # unwrapped segments, which is why the host looked healthy.
    if window is not None and is_megaplay(src, referer):
        start_s, dur_s = window
        # A negative start is `-sseof`, resolvable only by the demuxer we are
        # bypassing — anchor it on the playlist's own EXTINF total instead.
        if start_s is None:
            start_abs = 0.0
        elif start_s < 0:
            start_abs = max(0.0, playlist_duration(src, referer=referer) + start_s)
        else:
            start_abs = float(start_s)
        samples, _abs = decode_audio_abs(
            src, start_abs, dur_s, sample_rate=sample_rate, referer=referer
        )
        return samples

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    cmd += _input_headers(src, referer)
    cmd += _hls_flags(src)
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
    _reject_degraded(proc.stderr, str(src), f"window={window!r}")
    return samples
