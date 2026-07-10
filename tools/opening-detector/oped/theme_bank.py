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
from .video_fingerprint import VideoFingerprint, best_match_video, extract_keyframe_hashes

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
    video_fp: VideoFingerprint | None = None  # keyframe hashes of the clean NC clip


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
    # Which signal produced the hit's ALIGNMENT: "audio" (frame-accurate) or
    # "video" (GOP-level, used when audio was too weak to match). The delivered
    # boundary is still projected onto ref.duration in both cases.
    source: str = "audio"
    # Where each delivered EDGE came from after fade-extension: "audio" (raw
    # projection/refine kept), "video" (image extended a cropped fade edge), or
    # "rms" (music onset/cut snap). Pure diagnostics — the numeric start/end is
    # what ships. Defaults to the projection source.
    edge_start_source: str = "audio"
    edge_end_source: str = "audio"


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

    `with_video=True` ALSO fingerprints the clean NC clip's keyframes (cached as
    `.vfp.npz`) so `detect_op_ed`'s `resolve_video` can cross-confirm the audio
    boundary. Off by default so the audio-only path pays nothing.
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

    def _build_one(entry) -> ThemeReference:
        key = f"{slug_prefix}/{theme.slug}/v{entry.version}"
        fp, dur = _fp_cached(key, entry.video_url, cache_dir)
        vfp = None
        if with_video:
            try:
                vfp = extract_keyframe_hashes(
                    entry.video_url, cache_key=key, cache_dir=video_cache_dir
                )
            except Exception:
                vfp = None  # video is confirmation-only; audio still ships
        return ThemeReference(
            kind=theme.kind,
            slug=theme.slug,
            version=entry.version,
            song=theme.song,
            video_url=entry.video_url,
            fp=fp,
            duration=dur,
            video_fp=vfp,
        )

    with ThreadPoolExecutor(max_workers=len(entries)) as pool:
        return list(pool.map(_build_one, entries))


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
    op_window: tuple[float | None, float | None] = OP_WINDOW,
    ed_window: tuple[float | None, float | None] = ED_WINDOW,
    min_votes: int = 40,
    min_score: float = MIN_SCORE_DEFAULT,
    full_fallback: bool = True,
    refine: bool = True,
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

    OP and ED are detected in PARALLEL. Detection LOGIC is byte-for-byte the same
    as running them sequentially — only the wall-clock ordering changes.

    Returns the accepted ThemeHits (0..2), each in absolute episode time.
    """

    def _abs_offset(win) -> float:
        # Convert a window's start into an absolute episode offset. A negative
        # start (-sseof) means "that many seconds before the end".
        if win is None:
            return 0.0
        start_s, _dur = win
        if start_s is None:
            return 0.0
        return episode_duration + start_s if start_s < 0 else start_s

    def _refine_hit(hit: ThemeHit, win) -> None:
        """Snap hit.start/end to the true onset/cut using the window's PCM. Edits
        the hit in place; a failure leaves the projection untouched."""
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
        hit.start = float(min(max(start, 0.0), episode_duration))
        hit.end = float(min(max(end, 0.0), episode_duration))

    def _video_hit_for(refs: list[ThemeReference], win, slug: str | None):
        """Best video match against the video refs of `slug` (or all refs when
        slug is None), in ABSOLUTE episode time. Returns (v_start, v_end, votes,
        ref) or None. Reused by both the confirm/extend path (slug pinned to the
        audio hit's theme) and the weak-audio fallback (slug=None, best overall).
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
            m = best_match_video(q, r.video_fp)
            if m is None:
                continue
            if best is None or m.n_votes > best[2]:
                best = (m.q_start + win_off, m.q_end + win_off, m.n_votes, r)
        return best

    def _apply_video(hit: ThemeHit, refs: list[ThemeReference], win) -> None:
        """Confirm the audio hit with video AND extend any fade edge the audio
        vote cropped. Audio alignment stays authoritative; video only ever
        EXTENDS a boundary outward (never pulls it in), and never past the clean
        theme clip's extent [theme_t0, theme_t0 + ref_duration]."""
        v = _video_hit_for(refs, win, hit.slug)
        if v is None:
            return
        v_start, v_end, v_votes, _ref = v

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

    def _video_sourced_hit(refs: list[ThemeReference], win) -> ThemeHit | None:
        """Build a hit whose ALIGNMENT comes from video, for when audio matched
        nothing (or only weakly). Projects onto the matched ref's clip length so
        the delivered interval still spans the full theme, and flags source=
        "video" so the consumer knows it's GOP-level (± a few seconds), not
        frame-accurate."""
        v = _video_hit_for(refs, win, None)
        if v is None:
            return None
        v_start, v_end, v_votes, ref = v
        if v_votes < VIDEO_EDGE_MIN_VOTES:
            return None
        ref_dur = ref.duration if ref.duration > 0 else (v_end - v_start)
        # Center the clip-length projection on the video span so a slightly short
        # visual match still delivers the full theme extent.
        proj_start = v_start
        proj_end = v_start + ref_dur
        return ThemeHit(
            kind=ref.kind, slug=ref.slug, version=ref.version,
            start=proj_start, end=proj_end,
            votes=v_votes, score=0.0,
            vote_start=v_start, vote_end=v_end,
            r_start=0.0, r_end=ref_dur, ref_duration=ref_dur,
            source="video", edge_start_source="video", edge_end_source="video",
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
        if hit is None and full_fallback:
            # Windowed match missed — retry on the whole episode (long cold-open
            # pushed the OP past the window, or an unusual layout). Only for the
            # failures, so the fast path stays windowed.
            fp_full = resolve_window(None)
            hit = _match_best_version(
                fp_full, refs, 0.0, min_votes=min_votes, min_score=min_score
            )
            used_win = None

        # Audio absent OR too weak → let the image become the timing source.
        # (Weak audio that the VF dub ducked, an encode that trimmed the audio,
        # etc. — the picture is intact even where the sound is corrupted.)
        if hit is None or not _is_strong(hit):
            v_hit = _video_sourced_hit(refs, used_win)
            # Take the video alignment when audio produced nothing, or when the
            # video match is stronger than the weak audio one. A strong audio hit
            # never reaches here, so this never overrides a trusted boundary.
            if v_hit is not None and (hit is None or v_hit.votes > hit.votes):
                hit = v_hit

        if hit is not None:
            if refine and hit.source == "audio":
                # RMS onset/cut snap only makes sense on an audio-aligned hit.
                _refine_hit(hit, used_win)
            if hit.source == "audio":
                _apply_video(hit, refs, used_win)
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