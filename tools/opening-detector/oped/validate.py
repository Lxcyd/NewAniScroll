"""Plausibility checks — the false-positive brake for detected OP/ED hits.

The matcher answers "where does this reference align best?", never "is this a
real OP/ED?". Everything in here answers the second question, using facts that
hold for every anime regardless of title, host or language:

  - an OP/ED sequence is 25-150 s long (TV-size). A delivered interval outside
    that band means we projected the WRONG reference length (an AnimeThemes
    "full version" rip, a truncated clip) — the alignment may be right while the
    interval shipped to the player is not;
  - a delivered edge that had to be CLAMPED to the episode bounds means the
    reference overflows the episode there — a real theme fits inside it;
  - the audio vote span and the delivered length must roughly agree: a 90 s
    reference that only voted over 12 s of episode is a coincidence, not a
    theme;
  - an OP and an ED cannot overlap.

Design rule: these produce REASONS, not decisions. A reason in `BLOCKING` holds
the hit back from being served (precision-first: store it, flag it, don't skip
on it); everything else is advisory metadata for the season pass and for
debugging. Nothing here ever MOVES a timestamp — a bad hit is dropped or held,
never "fixed" into an invented one.
"""

from __future__ import annotations

# ── plausibility band for a TV-size OP/ED ────────────────────────────────────
# Real sequences cluster at 89-92 s; short-form/ONA openings go down to ~30 s
# and a handful of long ones reach ~120 s. 25/150 is deliberately generous — the
# point is to catch a *category* error (full-version rip ~4 min, a 5 s scrap),
# not to police borderline lengths.
MIN_THEME_LEN_S = 25.0
MAX_THEME_LEN_S = 150.0

# A clamped edge is only meaningful if the clamp actually cut something. Below
# this the "clamp" is float noise on an interval that ends exactly at the
# episode boundary (a real ED that runs to the last frame).
CLAMP_EPSILON_S = 0.5

# The audio vote span (where hashes actually agreed) must cover at least this
# fraction of the delivered interval, otherwise the reference was projected far
# beyond any evidence. Fades and dialogue ducking legitimately kill votes over a
# chunk of a theme, hence the low floor — this catches "12 s of votes stretched
# into a 90 s skip", not a normally fading edge.
MIN_VOTE_SPAN_FRAC = 0.25

# Rival-peak ratio (matcher.best_match_ranked) above which the audio alignment
# is considered CONTESTED: another placement of the same reference in the same
# window drew nearly as many votes. 0.6 keeps normal matches (a true theme wins
# by several times over) while catching the reprise case that produced the
# cyberpunk ED false positive.
AMBIGUOUS_PEAK_RATIO = 0.6

# Max gap (s) between the coarse AUDIO t0 and the landmark IMAGE t0 for the two
# signals to be describing the same event. Inside it, the image is a refinement
# (that's its job — the ALIGN window is ±4 s). Beyond it they located DIFFERENT
# things and neither can be trusted without arbitration.
AV_DIVERGENCE_S = 4.0

# Two different THEMES (OP1 vs OP2, not two versions of one) matching the same
# window with fills this close means we cannot tell which one plays here. Their
# lengths differ, so picking wrong ships a wrong `end`.
THEME_MARGIN_MIN = 0.10

# Reasons that hold a hit back from being SERVED. Everything else is advisory.
BLOCKING = frozenset({
    "implausible_length",
    "end_clamped",
    "vote_span_too_short",
    "av_divergence",
    "ambiguous_audio_peak",
    "ambiguous_theme",
    "op_ed_overlap",
    "season_outlier",
})


def hit_anomalies(hit, episode_duration: float) -> list[str]:
    """Plausibility reasons for ONE hit, in its own host's episode time.

    `hit` is a ThemeHit (or anything exposing the same attributes). Ordered
    most-structural first so a log line reads usefully when several fire.
    """
    out: list[str] = []
    length = hit.end - hit.start

    if not (MIN_THEME_LEN_S <= length <= MAX_THEME_LEN_S):
        out.append("implausible_length")

    # The delivered end was cut by the episode bound: the reference doesn't fit
    # where we placed it. (start<0 clamps the same way but is far rarer and is
    # covered by the length check, so it stays advisory.)
    projected_end = hit.start + (hit.ref_duration or length)
    if projected_end - episode_duration > CLAMP_EPSILON_S:
        out.append("end_clamped")

    # Vote-span coverage — audio-aligned hits only. An image-sourced hit has no
    # audio votes by construction (source="video"/no-audio path) and must not be
    # punished for it.
    if hit.votes > 0 and length > 0:
        vote_span = max(0.0, hit.vote_end - hit.vote_start)
        if vote_span / length < MIN_VOTE_SPAN_FRAC:
            out.append("vote_span_too_short")

    # Audio and image located different things (only set when BOTH ran).
    if getattr(hit, "av_delta", None) is not None and hit.av_delta > AV_DIVERGENCE_S:
        out.append("av_divergence")

    # A contested audio peak is only blocking when the IMAGE didn't settle it:
    # a credited/video-sourced t0 IS the picture's own answer, so the rival audio
    # peak is moot there.
    if getattr(hit, "peak_margin", 0.0) >= AMBIGUOUS_PEAK_RATIO and hit.source not in (
        "credited", "video",
    ):
        out.append("ambiguous_audio_peak")

    if getattr(hit, "theme_margin", None) is not None and hit.theme_margin < THEME_MARGIN_MIN:
        out.append("ambiguous_theme")

    return out


def pair_anomalies(hits) -> dict[str, list[str]]:
    """Cross-hit reasons for one episode's hits, keyed by kind.

    Today: an OP and an ED that overlap. One of the two is a mis-location (most
    often an OP matched inside the ED region on a short episode), and we cannot
    tell which — so BOTH are held rather than guessing.
    """
    out: dict[str, list[str]] = {}
    op = next((h for h in hits if h.kind == "op"), None)
    ed = next((h for h in hits if h.kind == "ed"), None)
    if op is not None and ed is not None:
        if min(op.end, ed.end) - max(op.start, ed.start) > 0:
            out["op"] = ["op_ed_overlap"]
            out["ed"] = ["op_ed_overlap"]
    return out


def annotate(hits, episode_duration: float) -> None:
    """Fill `hit.anomalies` in place for every hit of ONE episode+host."""
    pairs = pair_anomalies(hits)
    for h in hits:
        h.anomalies = hit_anomalies(h, episode_duration) + pairs.get(h.kind, [])


def blocking(reasons) -> list[str]:
    """The subset of `reasons` that must hold a hit back from serving."""
    return [r for r in reasons if r in BLOCKING]
