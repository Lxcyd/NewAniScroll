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

Robustness (answering "what if the theme isn't where AnimeThemes says"):
  - Try ALL versions of the expected theme (JJK OP1 has 4) and keep the best.
  - If the windowed match fails, the caller can retry against the full episode
    (full_window=None) — rescues long cold-opens that push the OP past the
    window. That fallback is opt-in per call to keep the fast path fast.

No changes to fingerprint/matcher: `best_match` is already query↔reference.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .animethemes import Theme
from .audio import load_audio
from .fingerprint import Fingerprint, fingerprint
from .matcher import Match, best_match

# Default decode windows (seconds). OP: from episode start, covering a possible
# cold-open + the OP itself. ED: the tail, via end-of-file seek.
OP_WINDOW = (0.0, 240.0)          # first 4 min
ED_WINDOW = (-180.0, None)        # last 3 min (negative start = -sseof)


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


@dataclass
class ThemeHit:
    """A theme located inside one episode (the skip interval, episode time)."""

    kind: str          # "op" | "ed"
    slug: str          # which theme matched
    version: int
    start: float       # seconds, in EPISODE time (window offset already added)
    end: float
    votes: int
    score: float       # votes / matched-span seconds
    inferred: bool = False   # True when matched via cour fallback (no direct map)


def _fp_cached(samples_key: str, url: str, cache_dir: Path, *,
               referer: str | None = None) -> tuple[Fingerprint, float]:
    """Load-or-build a fingerprint for a reference clip, caching the FP itself.

    Returns (fingerprint, duration_seconds). The .npz sits next to the PCM
    cache so a re-run skips both the ffmpeg decode and the spectrogram.
    """
    safe = samples_key.replace("/", "__").replace("\\", "__")
    fp_file = cache_dir / f"{safe}.fp.npz"
    if fp_file.exists():
        fp = Fingerprint.load(fp_file)
        # duration is derivable from the cached PCM; recompute lazily only if
        # needed. Store it alongside as a tiny sidecar to avoid a reload.
        dur_file = cache_dir / f"{safe}.dur.txt"
        dur = float(dur_file.read_text()) if dur_file.exists() else 0.0
        return fp, dur
    cache_dir.mkdir(parents=True, exist_ok=True)
    samples = load_audio(url, cache_key=samples_key, cache_dir=cache_dir,
                         referer=referer)
    fp = fingerprint(samples)
    fp.save(fp_file)
    dur = len(samples) / 11025
    (cache_dir / f"{safe}.dur.txt").write_text(str(dur))
    return fp, dur


def build_references(
    theme: Theme,
    *,
    cache_dir: str | Path = "cache/audio",
    slug_prefix: str = "animethemes",
) -> list[ThemeReference]:
    """Fingerprint EVERY playable version of a theme (cached once each).

    Matching an episode against all versions rescues the case where the
    release uses a different cut than the one AnimeThemes' episode range names.
    """
    cache_dir = Path(cache_dir)
    refs: list[ThemeReference] = []
    seen: set[str] = set()
    for entry in theme.entries:
        if not entry.video_url or entry.video_url in seen:
            continue
        seen.add(entry.video_url)
        key = f"{slug_prefix}/{theme.slug}/v{entry.version}"
        fp, dur = _fp_cached(key, entry.video_url, cache_dir)
        refs.append(
            ThemeReference(
                kind=theme.kind,
                slug=theme.slug,
                version=entry.version,
                song=theme.song,
                video_url=entry.video_url,
                fp=fp,
                duration=dur,
            )
        )
    return refs


def _match_best_version(
    episode_fp: Fingerprint,
    refs: list[ThemeReference],
    window_offset: float,
    *,
    min_votes: int,
    min_score: float,
) -> ThemeHit | None:
    """Match an episode fingerprint against all versions of ONE theme; keep the
    strongest. `window_offset` (seconds) is added to the recovered query span
    to convert window-relative times back to absolute episode time.
    """
    best: tuple[Match, ThemeReference] | None = None
    for ref in refs:
        m = best_match(episode_fp, ref.fp, min_votes=min_votes)
        if m is None or m.score < min_score:
            continue
        if best is None or m.n_votes > best[0].n_votes:
            best = (m, ref)
    if best is None:
        return None
    m, ref = best
    return ThemeHit(
        kind=ref.kind,
        slug=ref.slug,
        version=ref.version,
        start=m.q_start + window_offset,
        end=m.q_end + window_offset,
        votes=m.n_votes,
        score=m.score,
    )


def detect_op_ed(
    resolve_window,
    episode_duration: float,
    op_refs: list[ThemeReference],
    ed_refs: list[ThemeReference],
    *,
    op_window: tuple[float | None, float | None] = OP_WINDOW,
    ed_window: tuple[float | None, float | None] = ED_WINDOW,
    min_votes: int = 40,
    min_score: float = 0.0,
    full_fallback: bool = True,
) -> list[ThemeHit]:
    """Locate the OP and ED inside one episode, decoding only short windows.

    `resolve_window(window)` is a caller-supplied closure returning the episode
    Fingerprint for a given decode window (so this module stays agnostic to how
    the stream is resolved/cached). It is called with the OP window, the ED
    window, and — only on windowed failure if `full_fallback` — with None
    (whole episode).

    Returns the accepted ThemeHits (0..2), each in absolute episode time.
    """
    hits: list[ThemeHit] = []

    def _abs_offset(win) -> float:
        # Convert a window's start into an absolute episode offset. A negative
        # start (-sseof) means "that many seconds before the end".
        if win is None:
            return 0.0
        start_s, _dur = win
        if start_s is None:
            return 0.0
        return episode_duration + start_s if start_s < 0 else start_s

    for refs, win, kind in ((op_refs, op_window, "op"), (ed_refs, ed_window, "ed")):
        if not refs:
            continue
        fp = resolve_window(win)
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
        if hit is not None:
            hits.append(hit)

    hits.sort(key=lambda h: h.start)
    return hits
