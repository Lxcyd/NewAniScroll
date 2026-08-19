"""Megaplay (MegaCloud) segment de-obfuscation.

Megaplay serves HLS whose media segments are **PNG-decoy-wrapped**: each segment
is a ~70-byte 1x1 PNG (`\\x89PNG…IEND`) with the real MPEG-TS payload concatenated
right after it (the first byte past the PNG is the TS sync `0x47`, and the payload
then syncs at the usual 188-byte stride). ffmpeg reads the PNG header, decides the
whole rendition is `Video: png` with no audio, and `-vn` then drops the only
"stream" — so a direct decode yields 0 bytes.

This wrapper is why the detector's server-side ffmpeg pull recovers NOTHING from
megaplay even though the browser (hls.js) plays it fine. It is NOT steganography:
stripping the PNG prefix recovers a plain, decodable TS.

Strategy: rather than teach ffmpeg to read the disguised stream, we materialise
the requested [start_abs, start_abs+dur] window as a **local .ts file** — resolve
the variant playlist, pick the segments covering the window (by cumulative
EXTINF, which equals the stream's absolute PTS base on megaplay — see
video_fingerprint.keyframe_hashes_abs' 1260.0/-ss-1254.99 measurement), download
each, strip the PNG decoy, and concatenate. Because each segment keeps its
original absolute PTS, the existing `-copyts -ss <abs> -to <abs+dur>` decode in
audio.py / video_fingerprint.py works UNCHANGED on the local file — no HLS
demuxer flags, no A/V-clock reconciliation. The assembled window is cached so the
audio pass and the video pass (and re-runs) share one download.
"""

from __future__ import annotations

import hashlib
import os
import urllib.parse
import urllib.request
from pathlib import Path

# Segment-fetch identity. Megaplay's segments (and the ibyteimg-hosted ones it
# splices in) all validate against the megaplay Referer.
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# Lead-in before the requested start: ffmpeg's `-ss <abs>` needs a keyframe at or
# before the seek point, so we include a couple of extra segments ahead of the
# window. ~15s comfortably covers megaplay's GOP/segment size.
_LEAD_S = 15.0
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


# Known megaplay CDN domains. This list is a HINT, never the primary test: the
# CDN rotates (it has been mewstream.buzz, then kotocdn.site, then shiora.top…)
# and every rotation silently disables the de-PNG path — the stream then decodes
# as a lone `Video: png` with no audio and the host contributes nothing, which is
# exactly how megaplay went from working to 0-hit without any error.
_MEGAPLAY_DOMAINS = (
    "megaplay.buzz",
    "kotocdn.site",
    "mewstream.buzz",
    "lostproject.club",
    "shiora.top",
)


def is_megaplay(url: str | None, referer: str | None = None) -> bool:
    """True for a megaplay HLS stream.

    The REFERER is the reliable signal: the resolver stamps every megaplay
    stream with `https://megaplay.buzz/` (the embed validates segment fetches on
    it), and unlike the CDN hostname it does not rotate. The domain list is kept
    as a secondary match for callers that have no referer to hand.
    """
    for value in (referer, url):
        if not value:
            continue
        v = value.lower()
        if any(d in v for d in _MEGAPLAY_DOMAINS):
            return True
    return False


def depng(buf: bytes) -> bytes:
    """Return the MPEG-TS payload from a PNG-decoy-wrapped segment.

    Unwrapped input is returned as-is. For a wrapped one, skip past the PNG
    (its `IEND` chunk) and snap to the first real TS sync run (`0x47` repeating
    at the 188-byte stride) so a stray 0x47 inside the trailing PNG bytes can't
    misalign the demuxer.
    """
    if buf[:8] != _PNG_MAGIC:
        return buf
    iend = buf.find(b"IEND")
    start = iend + 8 if iend >= 0 else 0  # IEND + 4-byte CRC
    limit = min(start + 8192, len(buf) - 188 * 4)
    for off in range(start, max(start + 1, limit)):
        if (buf[off] == 0x47 and buf[off + 188] == 0x47
                and buf[off + 376] == 0x47 and buf[off + 564] == 0x47):
            return buf[off:]
    return buf[start:]


def _fetch(url: str, referer: str | None) -> bytes:
    headers = {"User-Agent": _UA}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def _variant_url(master_url: str, referer: str | None) -> str:
    """First non-iframe rendition of a master playlist (or the URL itself when
    it is already a media playlist)."""
    text = _fetch(master_url, referer).decode("utf-8", "replace")
    if "#EXT-X-STREAM-INF" not in text:
        return master_url  # already a media playlist
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            return urllib.parse.urljoin(master_url, s)
    return master_url


def _segments(variant_url: str, referer: str | None) -> list[tuple[str, float, float]]:
    """[(abs_url, seg_start_s, seg_end_s)] in playlist order. seg_start is the
    cumulative EXTINF sum, which is megaplay's absolute PTS base."""
    text = _fetch(variant_url, referer).decode("utf-8", "replace")
    out: list[tuple[str, float, float]] = []
    t = 0.0
    dur = None
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#EXTINF:"):
            try:
                dur = float(s[len("#EXTINF:"):].split(",")[0])
            except ValueError:
                dur = None
        elif s and not s.startswith("#"):
            d = dur if dur is not None else 4.0
            abs_u = urllib.parse.urljoin(variant_url, s)
            out.append((abs_u, t, t + d))
            t += d
            dur = None
    return out


def playlist_duration(master_url: str, *, referer: str | None = None) -> float:
    """Total stream duration (s) as the EXTINF sum of the variant playlist.

    Needed because the window decode path expresses the ED as a NEGATIVE start
    (`-sseof`), which only ffmpeg's demuxer can resolve — and megaplay never
    reaches that demuxer, since its PNG-wrapped segments have to be materialised
    locally first. Summing EXTINF gives the same anchor without a probe, and it
    is the very clock `_segments` already uses for the absolute PTS base.
    """
    segs = _segments(_variant_url(master_url, referer), referer)
    return segs[-1][2] if segs else 0.0


def materialize_window(
    master_url: str,
    start_abs: float,
    dur: float | None,
    *,
    referer: str | None = None,
    cache_dir: str | Path = "cache/megaplay",
) -> str:
    """Build (and cache) a local de-PNG'd .ts covering [start_abs, start_abs+dur]
    and return its path. The file keeps megaplay's absolute PTS, so ffmpeg's
    absolute `-ss`/`-to` seek onto it directly.

    `dur=None` means "to the end" (used for full-tail decodes). The master URL is
    stable per (mal, episode), so the cache key survives re-runs.
    """
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(
        f"{master_url}|{round(start_abs, 1)}|{'' if dur is None else round(dur, 1)}"
        .encode("utf-8")
    ).hexdigest()[:20]
    out_path = cache_dir / f"{key}.ts"
    if out_path.exists() and out_path.stat().st_size > 0:
        return str(out_path)

    variant = _variant_url(master_url, referer)
    segs = _segments(variant, referer)
    if not segs:
        raise RuntimeError(f"megaplay: no segments in playlist for {master_url!r}")

    lo = max(0.0, start_abs - _LEAD_S)
    hi = float("inf") if dur is None else start_abs + dur
    picked = [u for (u, s0, s1) in segs if s1 > lo and s0 < hi]
    if not picked:  # window past the end → fall back to the tail
        picked = [segs[-1][0]]

    tmp = out_path.with_suffix(".ts.part")
    with open(tmp, "wb") as f:
        for seg_url in picked:
            f.write(depng(_fetch(seg_url, referer)))
    tmp.replace(out_path)
    _prune(cache_dir)
    return str(out_path)


# Disk budget for the materialised windows. Each one is a real slice of video
# (tens of MB), one per (episode, window), and nothing ever deleted them: the
# 2026-08-07 overnight lot grew this directory to 68 GB and filled the disk,
# which then failed every write in the run with `OSError: [Errno 28]`. The
# files are pure cache — regenerable from the master URL — so evicting the
# oldest is free apart from a re-fetch.
MEGAPLAY_CACHE_BUDGET_BYTES = int(
    float(os.environ.get("OPED_MEGAPLAY_CACHE_GB", "8")) * 1024 ** 3
)


def _prune(cache_dir: Path) -> None:
    """Keep the directory under budget, oldest-first.

    Deliberately cheap and best-effort: it runs after a write, skips files
    another thread still holds (Windows refuses those), and never raises — a
    cache that cannot be trimmed must not take the batch down with it.
    """
    try:
        files = [(p, p.stat()) for p in cache_dir.glob("*.ts")]
    except OSError:
        return
    total = sum(st.st_size for _, st in files)
    if total <= MEGAPLAY_CACHE_BUDGET_BYTES:
        return
    for path, st in sorted(files, key=lambda x: x[1].st_mtime):
        try:
            path.unlink()
            total -= st.st_size
        except OSError:
            continue  # in use by another worker — the next prune gets it
        if total <= MEGAPLAY_CACHE_BUDGET_BYTES * 0.8:
            return
