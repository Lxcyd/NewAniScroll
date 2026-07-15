"""Reference-anchored OP/ED detection using AnimeThemes clean theme audio.

The original series-bank matches episode ↔ episode: it needs several full
episode streams from the SAME host, aligned cuts, and it only recovers a
RELATIVE offset between two episodes. This module inverts the problem using a
GROUND-TRUTH reference:

  1. AnimeThemes hands us the exact OP/ED as a clean NC .webm.
  2. Fingerprint that theme ONCE (cached on disk, PCM AND fingerprint).
  3. For each episode, match episode ↔ theme. The offset-histogram peak's
     query span (q_start, q_end) is the theme's location INSIDE the episode —
     i.e. the frame-accurate skip interval, in episode time.

Speed strategy (the episode download is the bottleneck):
  - We do NOT decode the whole ~24 min episode. The OP lives in the first
    minutes, the ED in the last, so we decode two SHORT WINDOWS via ffmpeg
    input seeking (see audio.load_audio window=). ffmpeg then range-requests
    only those slices instead of streaming the whole file.
  - Reference themes are fingerprinted once per (anime, theme, version) and
    the Fingerprint itself is cached (.npz), so re-runs skip the spectrogram.
  - Episode WINDOW fingerprints are ALSO cached now (`cached_fingerprint`),
    not just their raw PCM — see that function's docstring. This is purely a
    caching optimization: the numbers a fresh (uncached) run produces are
    unchanged, only their recomputation on a rerun is skipped.
  - OP and ED are independent per episode (different windows, different refs),
    so `detect_op_ed` resolves+matches them concurrently instead of one after
    the other — see that function's docstring. No detection parameter changes.

Robustness (answering "what if the theme isn't where AnimeThemes says"):
  - Try ALL versions of the expected theme (JJK OP1 has 4) and keep the best.
  - If the windowed match fails, the caller can retry against the full episode
    (full_window=None) — rescues long cold-opens that push the OP past the
    window. That fallback is opt-in per call to keep the fast path fast.

No changes to fingerprint/matcher: `best_match` is already query↔reference.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from . import SAMPLE_RATE
from .animethemes import Theme
from .audio import load_audio
from .fingerprint import Fingerprint, fingerprint
from .matcher import Match, best_match
from .refine import refine_edges_ref_anchored
from .video_fingerprint import (
    DENSE_FPS,
    DENSE_HALF_WINDOW_S,
    HAMMING_THRESHOLD,
    HAMMING_THRESHOLD_CREDITED,
    VideoFingerprint,
    anchor_by_landmarks,
    best_match_video,
    decode_dense_window,
    extract_keyframe_hashes,
    keyframe_hashes_abs,
    pick_landmarks,
    refine_edge_credited_video,
)

# Default decode windows (seconds). OP: from episode start, covering a possible
# cold-open + the OP itself. ED: the tail, via end-of-file seek.
OP_WINDOW = (0.0, 240.0)          # first 4 min
ED_WINDOW = (-180.0, None)        # last 3 min (negative start = -sseof)

# Quality gate: votes/second of the matched span. 0.0 = off (the old default).
# Real themes are dense clusters; a thin-but-wide spurious cluster has low
# density. Calibrated on SnK S1 — see the calibration note in the plan.
MIN_SCORE_DEFAULT = 0.15

# Fraction of the VIDEO match span that must fall inside the audio span to count
# as confirmation (video ⊆ audio). Same metric validated in diag_full.py.
VIDEO_CONTAINMENT = 0.7

# Above these thresholds the AUDIO hit is "strong": its alignment is trusted and
# the image is used only to EXTEND cropped fade edges (never to move a strong
# audio boundary). Below them the audio is "weak" and the image is allowed to
# BECOME the timing source (VF dub ducking the theme under dialogue, an encode
# that trims the audio, aggressive compression). Calibrated on SnK + a VF title
# where the ED is sung under speech — see the plan's calibration note.
AUDIO_STRONG_VOTES = 120
AUDIO_STRONG_SCORE = 0.5

# Video-edge extension guardrails.
#   - VIDEO_EDGE_MIN_VOTES: a video match must clear this to be trusted to move a
#     fade edge (same floor family as best_match_video's own min_votes=50).
#   - VIDEO_EDGE_ADJACENCY_S: the video span must be CONTIGUOUS with the audio
#     span (start/end within this gap) to count as "the same segment's fade" —
#     an isolated video cluster elsewhere in the window is rejected, so we never
#     stretch a boundary onto an unrelated visual shot.
VIDEO_EDGE_MIN_VOTES = 50
VIDEO_EDGE_ADJACENCY_S = 6.0

# When a CREDITED (with-credits) theme rip is available, its frames carry the
# same on-screen credits as the episode, so a true frame pair differs by
# re-encode noise only — the match is frame-accurate, not GOP-level. Above this
# vote floor a credited match is trusted enough to BECOME the delivered
# alignment and override even a strong audio hit (the user wants the credited
# visual boundary prioritised over audio when it's available and confident).
# Set a notch above VIDEO_EDGE_MIN_VOTES so a marginal credited match doesn't
# yank a solid audio boundary; a weaker credited match still cross-confirms /
# extends via the audio path. Only credited refs get this power — a plain NC
# ref still pays the credit penalty and stays subordinate to audio.
CREDITED_ALIGN_MIN_VOTES = 60

# Sanity band for the dense credited refiner when it sharpens an AUDIO-sourced
# edge (source=="audio" but a credited ref exists). The dense image match is the
# authority for the picture edge, but only within this many seconds of the audio
# projection — a larger disagreement means the two signals located different
# things (a wrong theme version, a mid-episode false match) and we KEEP the audio
# edge rather than trust a distant image transition. Credited-SOURCED hits are
# already image-authoritative and are not subject to this band.
DENSE_AUDIO_SHARPEN_BAND_S = 2.0

# Max disagreement (seconds) between a credited video alignment and a STRONG audio
# alignment for the credited match to be allowed to OVERRIDE the audio timing.
# Credited priority exists to sharpen fade edges the audio can't see, so a genuine
# credited refinement sits within a couple of seconds of the audio. A far larger
# gap means the credited match itself is unreliable — sparse HLS keyframes (a
# 137-vote credited vs a 2616-vote audio on megaplay), or an edge on a featureless
# solid-colour card the image matcher can't pin — so we KEEP the strong audio
# alignment instead of letting the weak picture drag it off. Only gates STRONG
# audio; weak/absent audio still yields to credited as before.
CREDITED_OVERRIDE_AGREE_BAND_S = 4.0


@dataclass
class ThemeReference:
    """A fingerprinted clean theme version, ready to match episodes against."""

    kind: str          # "op" | "ed"
    slug: str          # "OP1"
    version: int
    song: str | None
    video_url: str
    fp: Fingerprint
    duration: float    # seconds of the reference clip
    video_fp: VideoFingerprint | None = None  # keyframe hashes of the IMAGE ref
    video_ref_url: str | None = None  # URL the keyframes came from (credited
                                      # clip when available, else the NC clip)
    # Distinctive reference frames [(r_time, dHash), ...] for landmark anchoring
    # (see video_fingerprint.pick_landmarks). Precomputed once from the NATIVE
    # decode of the credited clip so `r_time` is frame-exact (a 2fps decode
    # quantises r_time to 0.5s and biases every projection — Stage 3). Locating
    # the theme in an episode needs only these pairs, not the whole ref.
    landmarks: list = field(default_factory=list)
    # Length of the credited clip from its NATIVE decode (frames/fps), the
    # canonical frame-accurate OP/ED duration used by the Stage-4 boundary
    # `end = theme_t0 + ref_native_dur`. Distinct from `duration` (the AUDIO
    # clip length, ~equal but 2fps/decoder-rounded). 0.0 when no video ref built.
    ref_native_dur: float = 0.0


@dataclass
class ThemeHit:
    """A theme located inside one episode (the skip interval, episode time).

    `start`/`end` are the DELIVERED skip interval: the reference theme's full
    extent projected onto episode time (see `_match_best_version`), so they
    correspond to the AnimeThemes NC clip's first/last frame — NOT the raw
    dense-vote span. `vote_start`/`vote_end` keep that raw dense-vote span (the
    portion of the theme that actually collided on hashes) for confidence gating
    and for reference-anchored edge refinement.
    """

    kind: str          # "op" | "ed"
    slug: str          # which theme matched
    version: int
    start: float       # seconds, in EPISODE time (window offset already added)
    end: float
    votes: int
    score: float       # votes / matched-span seconds
    # Raw dense-vote span in EPISODE time (window offset added) — where hashes
    # actually agreed. Narrower than start/end when fades produced no anchors.
    vote_start: float = 0.0
    vote_end: float = 0.0
    # Where the vote span landed in REFERENCE (theme) time. r_start≈0 means the
    # match reached the theme's true start; r_start well inside the theme means
    # earlier theme audio existed but didn't vote (VF ducking/compression).
    r_start: float = 0.0
    r_end: float = 0.0
    ref_duration: float = 0.0   # the reference clip's full length (canonical OP/ED len)
    inferred: bool = False   # True when matched via cour fallback (no direct map)
    confirmed_by_video: bool = False  # audio+video agreed (containment) — confidence only
    video_disagreement: bool = False  # both matched but diverged — anomaly flag
    # Which signal produced the hit's ALIGNMENT:
    #   "audio"    — audio-histogram alignment (frame-accurate); the default.
    #   "credited" — a with-credits AnimeThemes rip matched the episode frames;
    #                frame-accurate and PRIORITISED over audio (same on-screen
    #                credits as the episode → tight image match).
    #   "video"    — a clean NC rip matched; GOP-level (± a few seconds), used
    #                only when audio was too weak/absent to match.
    # The delivered boundary is still projected onto ref.duration in every case.
    source: str = "audio"
    # Where each delivered EDGE came from after fade-extension: "audio" (raw
    # projection/refine kept), "video" (image extended a cropped fade edge), or
    # "rms" (music onset/cut snap). Pure diagnostics — the numeric start/end is
    # what ships. Defaults to the projection source.
    edge_start_source: str = "audio"
    edge_end_source: str = "audio"
    # Episode time where the credited image reference's frame 0 lands, recovered
    # from the coarse video match (offset + window base). It's the stable anchor
    # the dense sub-second refiner uses to map episode frames onto reference
    # frames (ep frame at t ↔ ref frame at t - video_theme_t0). None when no
    # video match produced an alignment. More reliable than re-deriving from
    # vote_start - r_start, which refine may have since moved.
    video_theme_t0: float | None = None
    # Stage-4 landmark-anchor confidence (detect_op_ed_v2). n_landmarks = accepted
    # landmarks; consensus_frac = fraction within ±1 frame of the mode (see
    # video_fingerprint.anchor_by_landmarks). 0.0 when the image anchor did not
    # run or fell back to the audio t0. These SOFT-DEPRECATE votes/score as the
    # confidence signal for image-sourced hits without removing those fields.
    n_landmarks: int = 0
    consensus_frac: float = 0.0
    # True when the image anchor was too weak (below the consensus floor) and the
    # delivered t0 fell back to the coarse AUDIO locate — still shipped (no gap),
    # but flagged low-confidence for multi-host reconciliation.
    low_confidence: bool = False


def _window_tag(window: tuple[float | None, float | None] | None) -> str:
    """Cache-filename tag for a decode window.

    Mirrors the tagging scheme in `audio.load_audio` so the OP window, the ED
    window, and the whole-clip case (window=None, tag="") all cache under
    distinct filenames and never collide — including for the reference-theme
    cache, where window is always None, so this is a no-op there and existing
    `.fp.npz` files on disk stay valid untouched.
    """
    if window is None:
        return ""
    start_s, dur_s = window
    start_part = "" if start_s is None else str(round(start_s, 1))
    dur_part = "" if dur_s is None else str(round(dur_s, 1))
    return f".w{start_part}_{dur_part}"


def cached_fingerprint(
    samples_key: str,
    url: str,
    cache_dir: str | Path,
    *,
    window: tuple[float | None, float | None] | None = None,
    referer: str | None = None,
) -> tuple[Fingerprint, float]:
    """Load-or-build a Fingerprint for a clip or episode WINDOW, caching the
    fingerprint itself on disk (not just the decoded PCM).

    Before this, `audio.load_audio` already cached the raw PCM per (key,
    window), but the spectrogram + constellation-hash pass (`fingerprint()`)
    was recomputed from that cached PCM on every call. For repeated runs over
    the same episode/window — e.g. re-running a debug session, or building up
    `--out` incrementally episode by episode — this made the decode "free" but
    the fingerprinting step was still paid every time. Caching the Fingerprint
    itself (an .npz of hashes/times, tiny compared to PCM) skips both steps on
    a cache hit.

    Returns (fingerprint, duration_seconds). `duration` is recovered from a
    small sidecar `.dur.txt` written alongside the `.fp.npz` so a cache hit
    never needs to reload the PCM to know the clip length.
    """
    cache_dir = Path(cache_dir)
    safe = samples_key.replace("/", "__").replace("\\", "__")
    tag = _window_tag(window)
    fp_file = cache_dir / f"{safe}{tag}.fp.npz"
    if fp_file.exists():
        fp = Fingerprint.load(fp_file)
        dur_file = cache_dir / f"{safe}{tag}.dur.txt"
        dur = float(dur_file.read_text()) if dur_file.exists() else 0.0
        return fp, dur
    cache_dir.mkdir(parents=True, exist_ok=True)
    samples = load_audio(url, cache_key=samples_key, cache_dir=cache_dir,
                          window=window, referer=referer)
    fp = fingerprint(samples)
    fp.save(fp_file)
    dur = len(samples) / 11025
    (cache_dir / f"{safe}{tag}.dur.txt").write_text(str(dur))
    return fp, dur


def _fp_cached(samples_key: str, url: str, cache_dir: Path, *,
               referer: str | None = None) -> tuple[Fingerprint, float]:
    """Whole-clip fingerprint cache used by `build_references` (reference
    theme videos, never windowed). Kept as a thin alias over
    `cached_fingerprint` with window=None so the on-disk filename is byte-for-
    byte identical to before this patch — no cache invalidation for existing
    `.fp.npz` reference files.
    """
    return cached_fingerprint(samples_key, url, cache_dir, window=None, referer=referer)


# A credited theme clip is a full OP/ED (~85-95s). A native decode that returns
# far fewer frames than that (a rate-limited/reset fetch) is degenerate: too few
# landmarks to anchor, and a truncated ref_native_dur would shorten every end.
# Require most of the clip decoded before trusting/caching it. Duration is the
# real gate; the frame floor rejects the 0-2 frame case even if pts look long.
_NATIVE_REF_MIN_FRAMES = 500
_NATIVE_REF_MIN_DUR_S = 60.0


def _native_ref_ok(vfp: VideoFingerprint) -> bool:
    """True when a native credited-clip decode is complete enough to trust for
    landmark anchoring (see `_NATIVE_REF_MIN_*`)."""
    return (
        vfp is not None
        and vfp.hashes.size >= _NATIVE_REF_MIN_FRAMES
        and vfp.times.size > 0
        and float(vfp.times.max()) >= _NATIVE_REF_MIN_DUR_S
    )


# build_references fetches every (theme, version) concurrently, and the caller
# (detect_anime) fans THAT out again per theme — so a full-clip native pull races
# many others against animethemes.moe and a rate-limit/reset yields a truncated
# decode. It's a one-time cached cost, so retry a couple of times with a short
# backoff before giving up (then the ref degrades to audio-only anchoring).
_NATIVE_REF_RETRIES = 3
_NATIVE_REF_BACKOFF_S = 2.0

# A full-clip native decode is heavy and animethemes.moe rate-limits: when
# build_references fans out every (theme, version) — and the caller fans THAT out
# per theme — a dozen simultaneous full-clip pulls get reset, so the retry above
# alone wasn't enough (all siblings retried in lockstep and re-collided). Serialise
# just the native decodes through one lock: the 2fps keyframe pull and audio stay
# concurrent (they're small), but only ONE full-clip native fetch hits the CDN at
# a time. It's a one-time cached cost, so the wall-clock hit is paid once.
_NATIVE_REF_LOCK = __import__("threading").Lock()


def _decode_native_ref(url: str) -> VideoFingerprint | None:
    """Native (fps=None) full-clip decode with a bounded retry, serialised across
    threads (see `_NATIVE_REF_LOCK`). Returns a VideoFingerprint only when it
    passes `_native_ref_ok`, else None."""
    import time as _time
    with _NATIVE_REF_LOCK:
        for attempt in range(_NATIVE_REF_RETRIES):
            try:
                vfp = keyframe_hashes_abs(url, 0.0, None, fps=None)
            except Exception:
                vfp = None
            if _native_ref_ok(vfp):
                return vfp
            if attempt < _NATIVE_REF_RETRIES - 1:
                _time.sleep(_NATIVE_REF_BACKOFF_S * (attempt + 1))
    return None


def build_references(
    theme: Theme,
    *,
    cache_dir: str | Path = "cache/audio",
    slug_prefix: str = "animethemes",
    with_video: bool = False,
    video_cache_dir: str | Path = "cache/video",
) -> list[ThemeReference]:
    """Fingerprint EVERY playable version of a theme (cached once each).

    Matching an episode against all versions rescues the case where the
    release uses a different cut than the one AnimeThemes' episode range names.

    Versions are fingerprinted CONCURRENTLY: each is an independent download +
    spectrogram computation, and a theme can have several versions (JJK OP1
    has 4), so this is a straightforward wall-clock win with zero change to
    what's computed for each version.

    `with_video=True` ALSO fingerprints the theme's keyframes (cached as
    `.vfp.npz`) so `detect_op_ed`'s `resolve_video` can cross-confirm the audio
    boundary. The image reference is the CREDITED clip when AnimeThemes has one
    (its on-screen credits match the aired episode's overlaid frames, so the
    keyframe hashes line up far tighter than a clean NC clip would), else the NC
    clip. Off by default so the audio-only path pays nothing.
    """
    cache_dir = Path(cache_dir)
    entries = []
    seen: set[str] = set()
    for entry in theme.entries:
        if not entry.video_url or entry.video_url in seen:
            continue
        seen.add(entry.video_url)
        entries.append(entry)

    if not entries:
        return []

    def _build_one(entry) -> ThemeReference | None:
        key = f"{slug_prefix}/{theme.slug}/v{entry.version}"
        # The AUDIO fingerprint is essential (v2 LOCATE needs it). A version whose
        # NC/credited audio clip is broken on animethemes.moe (a persistent 5XX —
        # seen on ChainsawMan-ED4-NCBD1080.webm) or transiently unavailable must
        # NOT sink the whole anime: skip just that version and let the others ship
        # (a theme usually has a usable version; a per-episode-ED series has many).
        # Bounded retry first, since a 5XX is often transient under concurrency.
        fp = dur = None
        for attempt in range(_NATIVE_REF_RETRIES):
            try:
                fp, dur = _fp_cached(key, entry.video_url, cache_dir)
                break
            except Exception:
                if attempt < _NATIVE_REF_RETRIES - 1:
                    __import__("time").sleep(_NATIVE_REF_BACKOFF_S * (attempt + 1))
        if fp is None:
            return None
        vfp = None
        # IMAGE reference: prefer the CREDITED clip (its on-screen credits match
        # the aired episode's overlaid frames), falling back to the NC clip when
        # AnimeThemes has no credited rip. A distinct cache_key (+cred) keeps the
        # credited keyframe fingerprint from colliding with any NC `.vfp.npz`.
        video_ref_url = entry.video_url_credited or entry.video_url
        video_key = key + ("+cred" if entry.video_url_credited else "")
        landmarks: list = []
        ref_native_dur = 0.0
        if with_video:
            try:
                # 2fps keyframe fingerprint — the coarse cross-confirm signal used
                # by the current cascade (best_match_video / _video_hit_for).
                vfp = extract_keyframe_hashes(
                    video_ref_url, cache_key=video_key, cache_dir=video_cache_dir
                )
            except Exception:
                vfp = None  # video is confirmation-only; audio still ships
            try:
                # NATIVE decode of the whole credited clip: landmarks with
                # frame-exact r_time (Stage-3 fix) + the canonical native duration
                # for the Stage-4 end boundary. Cached under a distinct
                # `.native.vfp.npz` so it never collides with the 2fps `vfp` above.
                #
                # Only a NON-degenerate decode is cached. build_references fetches
                # every version concurrently, so this native pull races the 2fps
                # one against animethemes.moe; a rate-limit/reset can return 0-few
                # frames. Caching that empty result froze the failure permanently
                # (0-frame OP refs → the image ALIGN always fell back to audio).
                # Requiring a plausible frame count before saving means a transient
                # failure is simply RETRIED on the next run instead of persisted.
                native_file = Path(video_cache_dir) / (
                    f"{video_key.replace('/', '__')}.native.vfp.npz"
                )
                nref = None
                if native_file.exists():
                    cached = VideoFingerprint.load(native_file)
                    if _native_ref_ok(cached):
                        nref = cached
                if nref is None:
                    decoded = _decode_native_ref(video_ref_url)
                    if decoded is not None:
                        native_file.parent.mkdir(parents=True, exist_ok=True)
                        decoded.save(native_file)
                        nref = decoded
                if nref is not None:
                    landmarks = pick_landmarks(nref)
                    ref_native_dur = float(nref.times.max())
            except Exception:
                landmarks = []      # anchoring degrades to audio-only; still ships
                ref_native_dur = 0.0
        return ThemeReference(
            kind=theme.kind,
            slug=theme.slug,
            version=entry.version,
            song=theme.song,
            video_url=entry.video_url,
            fp=fp,
            duration=dur,
            video_fp=vfp,
            video_ref_url=video_ref_url,
            landmarks=landmarks,
            ref_native_dur=ref_native_dur,
        )

    with ThreadPoolExecutor(max_workers=len(entries)) as pool:
        built = list(pool.map(_build_one, entries))
    # Drop versions whose audio ref could not be fetched (see _build_one); the
    # anime still ships with the versions that succeeded.
    return [r for r in built if r is not None]


def _match_best_version(
    episode_fp: Fingerprint,
    refs: list[ThemeReference],
    window_offset: float,
    *,
    min_votes: int,
    min_score: float,
    min_fill: float = 0.5,
) -> ThemeHit | None:
    """Match an episode fingerprint against all versions of ONE theme; keep the
    version whose vote span best FILLS its own reference length. `window_offset`
    (seconds) converts window-relative times back to absolute episode time.

    Boundary policy (the precision decision): the delivered `start`/`end` are
    the reference clip's FULL extent projected onto episode time via the
    frame-accurate alignment offset —

        start = offset_seconds + 0.0            (+ window_offset)
        end   = offset_seconds + ref.duration   (+ window_offset)

    — so they line up with the AnimeThemes NC clip's first and last frame BY
    CONSTRUCTION, instead of the raw dense-vote span (`m.q_start/q_end`) which
    clips fade-in/out where few hashes form. offset_seconds = m.q_start -
    m.r_start (the theme's t0 in query time). The raw vote span is retained on
    the hit (vote_start/end, r_start/end) for confidence and edge refinement.

    Version selection: prefer the version whose vote span covers the largest
    FRACTION of its own reference duration (`fill`). A release that airs a
    different cut/length than one AnimeThemes version will vote densely on the
    version it actually matches and sparsely on the others, so fill — not raw
    vote count — is the right discriminator. A version below `min_fill` is a
    partial/spurious match and is rejected.
    """
    best: tuple[Match, ThemeReference, float] | None = None
    for ref in refs:
        m = best_match(episode_fp, ref.fp, min_votes=min_votes)
        if m is None or m.score < min_score:
            continue
        ref_dur = ref.duration if ref.duration > 0 else max(m.r_end, 1e-6)
        fill = min(1.0, (m.r_end - m.r_start) / max(ref_dur, 1e-6))
        if fill < min_fill:
            continue
        if best is None or fill > best[2]:
            best = (m, ref, fill)
    if best is None:
        return None
    m, ref, _fill = best

    # Theme t0 in query time = where the reference's frame 0 lands.
    theme_t0 = m.q_start - m.r_start
    ref_dur = ref.duration if ref.duration > 0 else m.r_end
    proj_start = theme_t0 + window_offset
    proj_end = theme_t0 + ref_dur + window_offset
    return ThemeHit(
        kind=ref.kind,
        slug=ref.slug,
        version=ref.version,
        start=proj_start,
        end=proj_end,
        votes=m.n_votes,
        score=m.score,
        vote_start=m.q_start + window_offset,
        vote_end=m.q_end + window_offset,
        r_start=m.r_start,
        r_end=m.r_end,
        ref_duration=ref_dur,
    )


def detect_op_ed(
    resolve_window,
    episode_duration: float,
    op_refs: list[ThemeReference],
    ed_refs: list[ThemeReference],
    *,
    resolve_samples=None,
    resolve_video=None,
    resolve_video_dense=None,
    resolve_window_duration=None,
    op_window: tuple[float | None, float | None] = OP_WINDOW,
    ed_window: tuple[float | None, float | None] = ED_WINDOW,
    min_votes: int = 40,
    min_score: float = MIN_SCORE_DEFAULT,
    full_fallback: bool = True,
    refine: bool = True,
    sharpen_audio_with_credited: bool = True,
) -> list[ThemeHit]:
    """Locate the OP and ED inside one episode, decoding only short windows.

    `resolve_window(window)` is a caller-supplied closure returning the episode
    Fingerprint for a given decode window (so this module stays agnostic to how
    the stream is resolved/cached). It is called with the OP window, the ED
    window, and — only on windowed failure if `full_fallback` — with None
    (whole episode).

    `resolve_samples(window)` (optional) returns the raw mono PCM for the SAME
    window — used only to snap the projected edges to the true music onset/cut
    (`refine`). Because `audio.load_audio` caches per (key, window), asking for
    the same window that produced the fingerprint is a cache hit, not a second
    decode. When None, boundaries are the pure reference projection (no snap).

    `resolve_video(window)` (optional) returns a VideoFingerprint for the window;
    if it and a `.video_fp` reference are present, a video match is computed and
    used ONLY to set `confirmed_by_video` / `video_disagreement` on the hit — the
    numeric boundary stays audio-frame-accurate and is never averaged with video.

    `resolve_video_dense(window, fps)` (optional) returns a densely-sampled
    VideoFingerprint for a TIGHT window at the given `fps` (the caller wires this
    to `extract_keyframe_hashes(..., fps=fps)` with an fps-tagged cache). When
    present with a credited image reference, the delivered edges are pinned to the
    sub-second image transition via `refine_edge_credited_video` — this is the
    ~0.25s precision path, and it OWNS the credited hit's start AND end (replacing
    the old audio `end_only` snap). `sharpen_audio_with_credited` (default True)
    also lets it tighten an AUDIO-sourced edge when a credited ref exists, guarded
    by `DENSE_AUDIO_SHARPEN_BAND_S`.

    `resolve_window_duration(window)` (optional) returns the ACTUAL decoded length
    (seconds) of a window. It matters only for the ED `-sseof` window: ffmpeg's
    keyframe seek can overshoot (megaplay HLS returned ~175s for a `-sseof 180`),
    so the window's true start is EOF - decoded_len, not the nominal EOF-180. With
    this wired, every ED timestamp is anchored on the real decoded extent instead
    of shipping ~5s early on hosts whose seek overshot. Without it, the nominal
    anchor is used (correct for hosts that decode the full window).

    OP and ED are detected in PARALLEL. Detection LOGIC is byte-for-byte the same
    as running them sequentially — only the wall-clock ordering changes.

    Returns the accepted ThemeHits (0..2), each in absolute episode time.
    """

    _win_dur_cache: dict = {}

    def _window_decoded_dur(win) -> float | None:
        """Actual decoded length (seconds) of a window, via the optional
        `resolve_window_duration` callback. Memoised per window (it's called
        repeatedly for the same window from every _abs_offset use)."""
        if resolve_window_duration is None or win is None:
            return None
        if win not in _win_dur_cache:
            try:
                _win_dur_cache[win] = resolve_window_duration(win)
            except Exception:
                _win_dur_cache[win] = None
        return _win_dur_cache[win]

    def _abs_offset(win) -> float:
        # Convert a window's start into an absolute episode offset. A negative
        # start (-sseof) means "that many seconds before the end".
        if win is None:
            return 0.0
        start_s, _dur = win
        if start_s is None:
            return 0.0
        if start_s < 0:
            # -sseof seeks to the nearest keyframe <= (EOF - |start_s|) and then
            # decodes to EOF, so the window's TRUE start is EOF - (actual decoded
            # length), which a keyframe seek routinely overshoots: on megaplay's
            # HLS a `-sseof 180` returned only ~175s, so the nominal anchor
            # (EOF-180) was ~5s early and EVERY ED timestamp shipped ~5s low
            # (21:10 instead of 21:15). Recover the real anchor from the decoded
            # length; the well-behaved hosts decode a full 180s so their offset is
            # unchanged. Falls back to the nominal anchor when the length is
            # unknown (no duration callback wired).
            d = _window_decoded_dur(win)
            if d is not None and d > 0:
                return max(0.0, episode_duration - d)
            return episode_duration + start_s
        return start_s

    def _window_span(win) -> tuple[float, float]:
        """Absolute episode-time range a decode window actually covers."""
        if win is None:
            return (0.0, episode_duration)
        _start_s, dur_s = win
        lo = _abs_offset(win)
        hi = episode_duration if dur_s is None else lo + dur_s
        return (max(0.0, lo), min(episode_duration, hi))

    def _window_clipped(hit: ThemeHit, win) -> bool:
        """True when the matched theme extends past the decode window, so the
        windowed match could only see PART of it — the segment straddles the
        window edge (e.g. a JJK OP that starts after a >2:30 cold-open runs past
        the 4-min OP window). Such a hit is truncated AT the window boundary,
        with its end clamped to the edge; the caller then re-matches on the whole
        episode to recover the full extent.

        Compares the theme's projected full extent [theme_t0, theme_t0 +
        ref_duration] against the window's covered range. A 1s margin absorbs
        projection rounding so a theme that merely reaches the boundary isn't
        needlessly re-decoded. A window that already ends at the episode boundary
        can't clip on that side (the theme legitimately runs to the end)."""
        if win is None:
            return False
        lo, hi = _window_span(win)
        theme_lo = hit.vote_start - hit.r_start            # ref frame 0 in ep time
        theme_hi = theme_lo + hit.ref_duration
        right_clip = hi < episode_duration - 1.0 and theme_hi > hi + 1.0
        left_clip = lo > 1.0 and theme_lo < lo - 1.0
        return right_clip or left_clip

    def _refine_hit(hit: ThemeHit, win, *, end_only: bool = False) -> None:
        """Snap hit.start/end to the true onset/cut using the window's PCM. Edits
        the hit in place; a failure leaves the projection untouched.

        `end_only` snaps ONLY the trailing edge and leaves hit.start untouched.
        Used for a CREDITED hit, whose start is already frame-accurate (the
        picture matched) but whose end came from `r_end_raw` — the last 2fps
        video sample that hash-matched — and so overshoots the real cut by up to
        a sample period (biased outward by the `.max()`) plus any fade/black tail
        the credited clip holds that still dHash-matches. The audio energy→silence
        collapse is the frame-accurate end; snap to it without disturbing the
        trusted credited start."""
        if resolve_samples is None:
            return
        win_off = _abs_offset(win)
        try:
            samples = resolve_samples(win)
        except Exception:
            return
        if samples is None or samples.size == 0:
            return
        # Slice a padded region around the projection, in window-relative sec.
        lead, tail = 5.0, 6.0
        s_lo = max(0.0, (hit.start - win_off) - lead)
        s_hi = (hit.end - win_off) + tail
        i0 = int(s_lo * SAMPLE_RATE)
        i1 = min(samples.size, int(s_hi * SAMPLE_RATE))
        if i1 - i0 < SAMPLE_RATE // 2:
            return
        sl = samples[i0:i1]
        base = i0 / SAMPLE_RATE  # slice start in window-relative seconds
        rs, re = refine_edges_ref_anchored(
            sl,
            proj_start_local=(hit.start - win_off) - base,
            proj_end_local=(hit.end - win_off) - base,
            vote_start_local=(hit.vote_start - win_off) - base,
            vote_end_local=(hit.vote_end - win_off) - base,
            r_start=hit.r_start,
            r_end=hit.r_end,
            ref_duration=hit.ref_duration,
        )
        start = base + rs + win_off
        end = base + re + win_off
        if not end_only:
            hit.start = float(min(max(start, 0.0), episode_duration))
        hit.end = float(min(max(end, 0.0), episode_duration))

    def _credited_ref_for(refs: list[ThemeReference], hit: ThemeHit) -> ThemeReference | None:
        """The credited image reference matching this hit's theme (slug pinned),
        i.e. one whose keyframes came from the with-credits rip. None when the
        theme has no credited rip (older BD-only titles) — the caller then keeps
        the audio refine."""
        for r in refs:
            if r.slug != hit.slug:
                continue
            if r.video_ref_url and r.video_ref_url != r.video_url:
                return r
        return None

    def _refine_credited_dense(
        hit: ThemeHit, refs: list[ThemeReference], win, *, audio_sharpen: bool = False
    ) -> bool:
        """Pin hit.start/end to the sub-second IMAGE transition against the
        credited reference, decoding a tight dense window around each edge.

        This is the ~0.25s precision path. For a credited-SOURCED hit it OWNS
        both edges (the picture is the answer). For an audio-sourced hit
        (`audio_sharpen=True`) it only tightens an edge that lands within
        DENSE_AUDIO_SHARPEN_BAND_S of the audio projection — a farther image
        transition is a different match and is ignored, keeping the audio edge.

        Returns True when at least one edge was moved. On any missing prerequisite
        (no dense resolver, no credited ref, no recovered anchor) returns False so
        the caller can fall back to the audio refine."""
        if resolve_video_dense is None or hit.video_theme_t0 is None:
            return False
        ref = _credited_ref_for(refs, hit)
        if ref is None or not ref.video_ref_url:
            return False
        theme_t0 = hit.video_theme_t0

        def _dense_edge(edge_kind: str, edge_t: float) -> float | None:
            try:
                ep_fp = resolve_video_dense(
                    (max(0.0, edge_t - DENSE_HALF_WINDOW_S), DENSE_HALF_WINDOW_S * 2.0),
                    DENSE_FPS,
                )
            except Exception:
                return None
            if ep_fp is None or ep_fp.hashes.size == 0:
                return None
            ep_win_off = max(0.0, edge_t - DENSE_HALF_WINDOW_S)
            # The reference edge that this episode edge corresponds to (ref time).
            ref_edge_t = edge_t - theme_t0
            try:
                ref_fp, ref_win_off = decode_dense_window(
                    ref.video_ref_url,
                    ref_edge_t,
                    cache_key=f"{ref.slug}+cred/dense",
                    cache_dir="cache/video",
                )
            except Exception:
                return None
            if ref_fp is None or ref_fp.hashes.size == 0:
                return None
            return refine_edge_credited_video(
                ep_fp, ref_fp,
                edge_kind=edge_kind,
                theme_t0_ep_t=theme_t0,
                ep_win_off=ep_win_off,
                ref_win_off=ref_win_off,
            )

        moved = False
        new_start = _dense_edge("start", hit.start)
        if new_start is not None:
            if not audio_sharpen or abs(new_start - hit.start) <= DENSE_AUDIO_SHARPEN_BAND_S:
                hit.start = float(min(max(new_start, 0.0), episode_duration))
                hit.edge_start_source = "credited"
                moved = True
        new_end = _dense_edge("end", hit.end)
        if new_end is not None:
            if not audio_sharpen or abs(new_end - hit.end) <= DENSE_AUDIO_SHARPEN_BAND_S:
                hit.end = float(min(max(new_end, 0.0), episode_duration))
                hit.edge_end_source = "credited"
                moved = True
        if hit.end <= hit.start:
            # Degenerate result — should not happen, but never ship an inverted
            # interval; the caller's fallback / clamp keeps the projection.
            return False
        return moved

    def _video_hit_for(refs: list[ThemeReference], win, slug: str | None):
        """Best video match against the video refs of `slug` (or all refs when
        slug is None), in ABSOLUTE episode time. Returns a dict or None:
            theme_t0  — episode time where the clip's frame 0 lands (= win_off +
                        winning offset). The frame-accurate anchor.
            v_start   — dense-cluster start in episode time (raw vote start).
            v_end     — dense-cluster end in episode time.
            r_start_raw/r_end_raw — matched clip-time extent (0..ref.duration),
                        UNGATED by dense clustering, so a mid-theme gap can't
                        truncate the delivered span.
            votes, ref.
        Reused by the confirm/extend path (slug pinned to the audio hit's theme)
        and the weak-audio fallback (slug=None, best overall).
        """
        if resolve_video is None:
            return None
        candidates = [
            r for r in refs
            if getattr(r, "video_fp", None) is not None
            and r.video_fp.hashes.size > 0
            and (slug is None or r.slug == slug)
        ]
        if not candidates:
            return None
        try:
            q = resolve_video(win)
        except Exception:
            return None
        if q is None or q.hashes.size == 0:
            return None
        win_off = _abs_offset(win)
        best = None
        for r in candidates:
            # A credited image reference carries the same on-screen credits as the
            # episode, so a true frame pair now differs by re-encode noise only —
            # use the tight threshold. An NC-only fallback ref still pays the full
            # credit penalty (see video_fingerprint.HAMMING_THRESHOLD comment), so
            # keep the loose default there.
            is_credited = bool(r.video_ref_url) and r.video_ref_url != r.video_url
            thr = HAMMING_THRESHOLD_CREDITED if is_credited else HAMMING_THRESHOLD
            m = best_match_video(q, r.video_fp, hamming_threshold=thr)
            if m is None:
                continue
            if best is None or m.n_votes > best["votes"]:
                best = {
                    "theme_t0": m.offset + win_off,
                    "v_start": m.q_start + win_off,
                    "v_end": m.q_end + win_off,
                    "r_start_raw": m.r_start_raw,
                    "r_end_raw": m.r_end_raw,
                    "votes": m.n_votes,
                    "ref": r,
                }
        return best

    def _apply_video(hit: ThemeHit, refs: list[ThemeReference], win) -> None:
        """Confirm the audio hit with video AND extend any fade edge the audio
        vote cropped. Audio alignment stays authoritative; video only ever
        EXTENDS a boundary outward (never pulls it in), and never past the clean
        theme clip's extent [theme_t0, theme_t0 + ref_duration]."""
        v = _video_hit_for(refs, win, hit.slug)
        if v is None:
            return
        # Record the credited alignment anchor on the audio hit too, so the dense
        # sub-second refiner can sharpen an audio-sourced boundary when a credited
        # ref exists (the picture edge audio can't see on a fade-to-black).
        hit.video_theme_t0 = v["theme_t0"]
        v_start, v_end, v_votes = v["v_start"], v["v_end"], v["votes"]

        # Containment confidence flag (unchanged semantics): does the video slice
        # sit inside the audio span?
        ov = max(0.0, min(hit.end, v_end) - max(hit.start, v_start))
        v_len = max(1e-6, v_end - v_start)
        if ov / v_len >= VIDEO_CONTAINMENT:
            hit.confirmed_by_video = True
        else:
            hit.video_disagreement = True

        if v_votes < VIDEO_EDGE_MIN_VOTES:
            return  # too weak to trust for moving a fade edge

        # The theme clip's full extent in episode time — the hard cap for any
        # extension (we never claim more than the AnimeThemes clip covers).
        # Recover theme frame-0 from the vote span + ref geometry (NOT hit.start,
        # which refine may have moved) so the cap is stable regardless of refine.
        cap_lo = hit.vote_start - hit.r_start           # theme frame 0 in ep time
        cap_hi = cap_lo + hit.ref_duration              # theme last frame in ep time

        # LEFT edge: extend earlier only if the video starts before the audio AND
        # is contiguous with it (same segment's fade-in), clamped to the clip.
        if (v_start < hit.start
                and (hit.start - v_start) <= VIDEO_EDGE_ADJACENCY_S):
            new_start = max(v_start, cap_lo)
            if new_start < hit.start:
                hit.start = new_start
                hit.edge_start_source = "video"

        # RIGHT edge: extend later only if the video ends after the audio AND is
        # contiguous (same segment's fade-out / staff-roll), clamped to the clip.
        if (v_end > hit.end
                and (v_end - hit.end) <= VIDEO_EDGE_ADJACENCY_S):
            new_end = min(v_end, cap_hi)
            if new_end > hit.end:
                hit.end = new_end
                hit.edge_end_source = "video"

        # Keep edges sane after moving them.
        hit.start = float(min(max(hit.start, 0.0), episode_duration))
        hit.end = float(min(max(hit.end, 0.0), episode_duration))

    def _ref_is_credited(ref: ThemeReference) -> bool:
        """True when this ref's image fingerprint came from the credited (with-
        credits) rip, not the NC clip — a credited match is frame-accurate."""
        return bool(ref.video_ref_url) and ref.video_ref_url != ref.video_url

    def _video_sourced_hit(
        refs: list[ThemeReference], win, slug: str | None = None,
        min_votes: int = VIDEO_EDGE_MIN_VOTES,
    ) -> ThemeHit | None:
        """Build a hit whose ALIGNMENT comes from video. Tags source="credited"
        when the matched ref is the with-credits rip (frame-accurate) or "video"
        for an NC-only match (GOP-level, ± a few seconds). `slug` pins the match
        to one theme; None = best overall (weak-audio fallback). `min_votes` is
        the confidence floor.

        Boundary policy differs by source, and this is the precision fix:

          CREDITED — deliver what the picture actually matched, anchored on the
            winning alignment offset (theme_t0 = where the clip's frame 0 lands):
              start = theme_t0 + r_start_raw
              end   = theme_t0 + r_end_raw
            r_start_raw/r_end_raw are the matched clip-time extent BEFORE dense
            clustering, so (a) a >gap hole mid-theme can't truncate the end to a
            sub-cluster (the earlier bug: JJK ED1 dense span stopped at r≈53s and
            delivered 22:12, while the raw votes cover r=0..87 → true end ≈22:46,
            matching the on-screen last frame ~22:43), and (b) we never
            extrapolate past where the episode frames stopped colliding — so a
            clip LONGER than the aired segment doesn't overshoot the real end.

          NC "video" (fallback only) — keep the clip-length projection: a loose
            NC match is coarse and only fires when audio failed, where spanning
            the whole theme is the safer default than a short visual cluster."""
        v = _video_hit_for(refs, win, slug)
        if v is None:
            return None
        v_votes = v["votes"]
        if v_votes < min_votes:
            return None
        ref = v["ref"]
        credited = _ref_is_credited(ref)
        src = "credited" if credited else "video"
        ref_dur = ref.duration if ref.duration > 0 else (v["v_end"] - v["v_start"])
        theme_t0 = v["theme_t0"]
        if credited:
            # The matched picture IS the frame-accurate answer.
            proj_start = theme_t0 + v["r_start_raw"]
            proj_end = theme_t0 + v["r_end_raw"]
        else:
            # Coarse NC fallback: span the full theme from the recovered start.
            proj_start = theme_t0
            proj_end = theme_t0 + ref_dur
        return ThemeHit(
            kind=ref.kind, slug=ref.slug, version=ref.version,
            start=proj_start, end=proj_end,
            votes=v_votes, score=0.0,
            vote_start=v["v_start"], vote_end=v["v_end"],
            r_start=v["r_start_raw"], r_end=v["r_end_raw"], ref_duration=ref_dur,
            source=src, edge_start_source=src, edge_end_source=src,
            video_theme_t0=theme_t0,
        )

    def _is_strong(hit: ThemeHit) -> bool:
        return hit.votes >= AUDIO_STRONG_VOTES and hit.score >= AUDIO_STRONG_SCORE

    def _detect_kind(refs: list[ThemeReference], win) -> ThemeHit | None:
        if not refs:
            return None
        fp = resolve_window(win)
        used_win = win
        hit = _match_best_version(
            fp, refs, _abs_offset(win), min_votes=min_votes, min_score=min_score
        )
        # Fall back to the WHOLE episode when the fast window either missed the
        # theme entirely (hit is None: a long cold-open or unusual layout put the
        # OP/ED outside the window) OR only caught PART of it (the theme straddles
        # the window edge, so the windowed hit is truncated at the boundary — the
        # JJK late-OP case, where all hosts agreed on a wrong 4:00 end because the
        # OP window stops at 4:00 while the OP runs to ~4:42). Keep the full hit
        # only when it covers MORE of the reference; otherwise the windowed hit —
        # which is frame-accurate on the fast path — stands. Only the failures and
        # the straddlers pay the full decode; a fully-in-window OP/ED does not.
        if full_fallback and (hit is None or _window_clipped(hit, win)):
            # Recover the truncated/out-of-window theme. When the windowed match
            # DID locate it (the straddle case: an in-window hit whose theme runs
            # past the edge), we know roughly where it sits, so decode only a
            # WIDENED window covering the theme's full extent — ~2 min instead of
            # the whole ~24-min episode. Only when the window missed the theme
            # ENTIRELY (hit is None: a very late OP / unusual layout) do we pay the
            # whole-episode decode, since then we have no idea where it is.
            if hit is not None:
                theme_lo = hit.vote_start - hit.r_start
                theme_hi = theme_lo + hit.ref_duration
                pad = 12.0
                w_start = max(0.0, theme_lo - pad)
                fb_win = (w_start, (theme_hi + pad) - w_start)
            else:
                fb_win = None
            fp_fb = resolve_window(fb_win)
            fb_hit = _match_best_version(
                fp_fb, refs, _abs_offset(fb_win),
                min_votes=min_votes, min_score=min_score,
            )
            if fb_hit is not None and (
                hit is None
                or (fb_hit.r_end - fb_hit.r_start) > (hit.r_end - hit.r_start)
            ):
                hit = fb_hit
                used_win = fb_win

        # Video-decode window for the steps below. On the fast path it's the
        # original window. On the full-episode fallback the audio match already
        # located the theme, so decode video only AROUND it rather than rescanning
        # the whole episode's keyframes — otherwise a straddling OP would cost a
        # ~24-min keyframe decode. When audio failed entirely (hit is None) we keep
        # None so the video path can still search the whole episode.
        video_win = used_win
        if used_win is None and hit is not None:
            _pad = 8.0
            _lo = max(0.0, hit.start - _pad)
            video_win = (_lo, (hit.end - hit.start) + 2 * _pad)

        # CREDITED-FRAME PRIORITY. A with-credits AnimeThemes rip carries the same
        # on-screen credits as the episode, so a confident frame match is
        # frame-accurate and is PRIORITISED over audio. Pin the credited match to
        # the audio hit's theme when we have one (keeps OP1-vs-OP2 disambiguation
        # from the audio vote); otherwise take the best credited match overall.
        # Only a genuinely credited ref that clears CREDITED_ALIGN_MIN_VOTES may
        # override audio — an NC-only ref returns source="video" and is rejected.
        cred_hit = _video_sourced_hit(
            refs, video_win,
            slug=(hit.slug if hit is not None else None),
            min_votes=CREDITED_ALIGN_MIN_VOTES,
        )
        if cred_hit is not None and cred_hit.source == "credited":
            # A STRONG audio hit is only overridden when the credited alignment
            # AGREES with it (their theme-t0 anchors within the band). A gross
            # disagreement means the credited match is unreliable (sparse HLS
            # keyframes, a featureless card edge) — keep the strong audio timing
            # and just flag it. Weak/absent audio still yields to credited.
            audio_t0 = None if hit is None else (hit.vote_start - hit.r_start)
            gross_disagree = (
                hit is not None
                and _is_strong(hit)
                and cred_hit.video_theme_t0 is not None
                and audio_t0 is not None
                and abs(cred_hit.video_theme_t0 - audio_t0) > CREDITED_OVERRIDE_AGREE_BAND_S
            )
            if gross_disagree:
                hit.video_disagreement = True
            else:
                if hit is not None:
                    ov = max(0.0, min(hit.end, cred_hit.end) - max(hit.start, cred_hit.start))
                    span = max(1e-6, cred_hit.end - cred_hit.start)
                    if ov / span >= VIDEO_CONTAINMENT:
                        cred_hit.confirmed_by_video = True
                    else:
                        cred_hit.video_disagreement = True
                hit = cred_hit

        # Audio absent OR too weak (and no credited win) → let a clean NC image
        # become the timing source. (VF dub ducked the theme under dialogue, an
        # encode trimmed the audio, etc. — the picture is intact even where the
        # sound is corrupted.)
        elif hit is None or not _is_strong(hit):
            v_hit = _video_sourced_hit(refs, video_win)
            # Take the video alignment when audio produced nothing, or when the
            # video match is stronger than the weak audio one. A strong audio hit
            # never reaches here, so this never overrides a trusted boundary.
            if v_hit is not None and (hit is None or v_hit.votes > hit.votes):
                hit = v_hit

        if hit is not None:
            if hit.source == "audio":
                # Cross-confirm + extend fade edges with the coarse video match;
                # this also records hit.video_theme_t0 for the dense sharpen below.
                _apply_video(hit, refs, video_win)

            if refine and hit.source == "credited":
                # Both edges come from the sub-second IMAGE transition against the
                # credited reference — frame-accurate for the picture, including a
                # fade-to-black end (where audio says nothing about the last
                # visible frame). Falls back to the audio end-snap only if the
                # dense refine can't run (no dense resolver, no credited ref).
                if not (refine and resolve_video_dense is not None
                        and _refine_credited_dense(hit, refs, used_win)):
                    _refine_hit(hit, used_win, end_only=True)
            elif refine and hit.source == "audio":
                # Audio alignment is frame-accurate for the MUSIC. Where a credited
                # ref exists, tighten the PICTURE edges to the dense image
                # transition (guarded to stay near the audio projection); else fall
                # back to the RMS onset/cut snap.
                sharpened = (
                    sharpen_audio_with_credited
                    and hit.votes >= CREDITED_ALIGN_MIN_VOTES
                    and _refine_credited_dense(hit, refs, used_win, audio_sharpen=True)
                )
                if not sharpened:
                    _refine_hit(hit, used_win)
        return hit

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(_detect_kind, op_refs, op_window),
            pool.submit(_detect_kind, ed_refs, ed_window),
        ]
        hits = [f.result() for f in futures]

    kept = [h for h in hits if h is not None]
    kept.sort(key=lambda h: h.start)
    return kept


# ── Stage 4: image-credited pipeline (LOCATE audio → ALIGN image) ──────────────
#
# The replacement for the override cascade above. One linear path per (kind):
#   A. LOCATE (audio, coarse, ABSOLUTE) — find roughly WHERE the theme is and
#      WHICH version (OP1 vs OP2). Audio measures the music; that's all we ask.
#   B. ALIGN (image landmarks, native, ABSOLUTE) — anchor on distinctive frames
#      INSIDE the theme to pin theme_t0 frame-accurate (Stage 3). The picture is
#      the authority for the boundary.
#   C. BORDS — start = theme_t0 ; end = theme_t0 + ref_native_dur.
#   D. Fallback — if the image anchor is too weak (below the consensus floor),
#      ship the coarse AUDIO t0 flagged low_confidence rather than dropping the
#      hit (agreed policy: never a gap when audio located the theme).
#
# No -sseof, no _abs_offset, no override bands: the resolvers hand back ABSOLUTE
# timelines (shared clock), so audio and image t0 are directly comparable.

# LOCATE search windows, in ABSOLUTE episode seconds. OP: from the start (covers a
# cold-open). ED: the tail, expressed as seconds-before-end (resolved against the
# probed duration by the caller-agnostic helper below).
OP_SEARCH = (0.0, 300.0)          # first 5 min
ED_SEARCH_FROM_END = 240.0        # last 4 min

# Minimum landmark consensus to trust the IMAGE t0. Below it we keep the audio t0
# and flag low_confidence. On JJK ED all hosts land at 0.73-0.82, and a spurious
# anchor scatters (no mode) → well separated. n floor guards the degenerate 1-2
# landmark case where a "fraction" is meaningless.
ALIGN_MIN_CONSENSUS_FRAC = 0.5
ALIGN_MIN_LANDMARKS = 4

# Extra native video decoded on each side of the coarse audio t0 for the ALIGN
# window. The theme spans [t0, t0+ref_dur]; pad so every landmark (incl. the
# last, near ref_dur) is inside the decoded region even if the audio t0 is a few
# seconds off.
ALIGN_PAD_S = 4.0


def detect_op_ed_v2(
    episode_duration: float,
    op_refs: list[ThemeReference],
    ed_refs: list[ThemeReference],
    *,
    resolve_audio_abs,
    resolve_video_abs=None,
    op_search: tuple[float, float] = OP_SEARCH,
    ed_search_from_end: float = ED_SEARCH_FROM_END,
    min_votes: int = 40,
    min_score: float = MIN_SCORE_DEFAULT,
    min_fill: float = 0.5,
) -> list[ThemeHit]:
    """Locate OP and ED with the image-credited pipeline (see section banner).

    Resolvers (caller supplies, ABSOLUTE timeline — shared clock):
      resolve_audio_abs(start_abs, dur) -> (Fingerprint, abs_start)
          episode audio fingerprint for [start_abs, start_abs+dur]; abs_start is
          the realized absolute time of sample 0 (a seek rounds start_abs).
      resolve_video_abs(start_abs, dur, fps) -> VideoFingerprint
          native (fps=None) episode keyframes with ABSOLUTE pts.

    Returns 0..2 ThemeHits in absolute episode time. Runs OP and ED in parallel;
    logic is identical to sequential.
    """

    def _locate_audio(refs, start_abs, dur):
        """A. Coarse audio locate. Returns (best ThemeReference, theme_t0_abs,
        Match) or None. theme_t0_abs = abs_start + (q_start - r_start)."""
        try:
            fp, abs_start = resolve_audio_abs(start_abs, dur)
        except Exception:
            return None
        if fp is None:
            return None
        best = None  # (fill, ref, m)
        for ref in refs:
            m = best_match(fp, ref.fp, min_votes=min_votes)
            if m is None or m.score < min_score:
                continue
            ref_dur = ref.duration if ref.duration > 0 else max(m.r_end, 1e-6)
            fill = min(1.0, (m.r_end - m.r_start) / max(ref_dur, 1e-6))
            if fill < min_fill:
                continue
            if best is None or fill > best[0]:
                best = (fill, ref, m)
        if best is None:
            return None
        _fill, ref, m = best
        theme_t0_abs = abs_start + (m.q_start - m.r_start)
        return ref, theme_t0_abs, m

    def _align_image(ref, theme_t0_coarse):
        """B. Native landmark anchor around the coarse t0. Returns LandmarkAnchor
        or None (no video resolver / no landmarks / no image decode / nothing
        accepted). None → the caller keeps the coarse audio t0."""
        if resolve_video_abs is None or not ref.landmarks:
            return None
        span = ref.ref_native_dur if ref.ref_native_dur > 0 else ref.duration
        start_abs = max(0.0, theme_t0_coarse - ALIGN_PAD_S)
        dur = span + 2 * ALIGN_PAD_S
        try:
            ep_vfp = resolve_video_abs(start_abs, dur, None)
        except Exception:
            return None
        if ep_vfp is None or ep_vfp.hashes.size == 0:
            return None
        return anchor_by_landmarks(ep_vfp, ref.landmarks)

    def _detect_kind(refs, start_abs, dur):
        if not refs:
            return None
        loc = _locate_audio(refs, start_abs, dur)
        if loc is None:
            return None
        ref, theme_t0_audio, m = loc

        ref_dur = ref.ref_native_dur if ref.ref_native_dur > 0 else (
            ref.duration if ref.duration > 0 else m.r_end
        )
        anc = _align_image(ref, theme_t0_audio)
        strong = (
            anc is not None
            and anc.n_accepted >= ALIGN_MIN_LANDMARKS
            and anc.consensus_frac >= ALIGN_MIN_CONSENSUS_FRAC
        )
        if strong:
            theme_t0 = anc.theme_t0          # C. image is the authority
            source = "credited"
            low_conf = False
        else:
            theme_t0 = theme_t0_audio        # D. fall back to coarse audio t0
            source = "audio"
            low_conf = True

        start = float(min(max(theme_t0, 0.0), episode_duration))
        end = float(min(max(theme_t0 + ref_dur, 0.0), episode_duration))
        return ThemeHit(
            kind=ref.kind, slug=ref.slug, version=ref.version,
            start=start, end=end,
            votes=m.n_votes, score=m.score,
            vote_start=theme_t0_audio + m.r_start, vote_end=theme_t0_audio + m.r_end,
            r_start=m.r_start, r_end=m.r_end, ref_duration=ref_dur,
            source=source,
            edge_start_source=source, edge_end_source=source,
            video_theme_t0=(anc.theme_t0 if anc is not None else None),
            n_landmarks=(anc.n_accepted if anc is not None else 0),
            consensus_frac=(anc.consensus_frac if anc is not None else 0.0),
            low_confidence=low_conf,
        )

    ed_start = max(0.0, episode_duration - ed_search_from_end)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(_detect_kind, op_refs, op_search[0], op_search[1]),
            pool.submit(_detect_kind, ed_refs, ed_start, ed_search_from_end),
        ]
        hits = [f.result() for f in futures]

    kept = [h for h in hits if h is not None]
    kept.sort(key=lambda h: h.start)
    return kept