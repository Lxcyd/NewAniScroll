"""Multi-host OP/ED detection + reconciliation.

WHY THIS EXISTS
---------------
The same episode, resolved from different players/hosts (Sibnet, embed4me,
sendvid, …), is NOT the same video: each host serves its own encode, and those
encodes differ in TOTAL DURATION — a few seconds to tens of seconds — because
of trimmed cold-opens, distributor ad-cards, black-frame padding, or a
different broadcast master. That means a skip interval detected against host A
is systematically WRONG on host B.

Two failure modes, handled differently by how the theme is anchored:

  • OP — anchored from the START of the episode. If the cold-open is the same
    length across hosts, the OP start is comparable directly. A host that
    trimmed/added a lead offsets the OP by a constant; consensus (below)
    rejects that host as an outlier instead of trusting one arbitrary encode.

  • ED — anchored from the END (we decode with -sseof). Its ABSOLUTE start
    depends on the host's total duration, so hosts with different lengths
    report different absolute ED starts even when the ED is "the same". The
    duration-INDEPENDENT quantity is SECONDS-FROM-END (`duration - start`);
    we reconcile on that. The delivered ED can then be re-projected onto the
    ACTIVE player's real duration at runtime (prod already knows the <video>
    duration in SkipOverlay), so a differently-trimmed stream stays correct.

WHAT IT PRODUCES
----------------
For each episode, a `ReconciledHit` per kind carrying BOTH representations:
  - `start` / `end`     — absolute seconds, in a canonical duration
  - `from_end_start`    — ED: seconds before the end (host-independent)
  - `canonical_duration`— the duration `start`/`end` are expressed against
  - `agreement`         — how many hosts agreed, and their spread (confidence)
so the importer/API can ship robust, self-describing skip data.

This module does NOT change the core detector: it calls `detect_op_ed` once per
host (each with that host's own duration) and reconciles the results. The
per-host calls are run IN PARALLEL (see `detect_op_ed_multi`) since each one
is an independent, network-bound decode + fingerprint + match — the dominant
cost of a multi-host run — and a single flaky/slow host must not stall its
peers.
"""

from __future__ import annotations

import statistics
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from . import validate
from .errors import ProcessKilled
from .theme_bank import (
    ThemeHit,
    ThemeReference,
    detect_op_ed,
    detect_op_ed_v2,
    ED_WINDOW,
    OP_WINDOW,
)


# A host whose recovered timecode sits further than this from the consensus is
# treated as an outlier (different encode / a mis-detection) and dropped. Chosen
# generously: real cross-host jitter is sub-second to a couple of seconds, while
# a differently-trimmed encode or a false match is off by many seconds.
OUTLIER_TOLERANCE_S = 4.0
# Looser tolerance when video-sourced hits are in the mix: a video alignment is
# only GOP-accurate (a few seconds), so audio-vs-video across hosts legitimately
# jitters more than audio-vs-audio. Used when at least one contributing hit is
# source="video".
OUTLIER_TOLERANCE_VIDEO_S = 7.0
# A video-sourced hit is trusted, but its vote count lives on a different scale
# than audio's (keyframe votes vs hash-collision votes) and it's coarser, so it
# should not dominate the vote-weighted consensus center. Scale its weight down.
VIDEO_WEIGHT_FACTOR = 0.4
# Below this many agreeing hosts we still emit a hit but flag it low-confidence
# (a single host can be right, but we can't cross-check it).
MIN_AGREE_FOR_CONFIDENT = 2
# Serve-gate ceiling on the agreeing-anchor spread. When ≥2 hosts "agree" but
# their anchors are this far apart, the agreement is fabricated by the _consensus
# outlier fallback (see its comment): the two hosts matched DIFFERENT occurrences
# of the theme, averaged into a timecode that exists on neither. A healthy spread
# can't exceed the upstream tolerance (4.0 audio / 7.0 video) EXCEPT through that
# fallback, so anything past a decade above it (the pathological case measured at
# 87-91s ≈ one ED length) is held back. 10 sits just above the structural floor;
# 15 or 20 give the same verdicts on the bench. Not a measure of accuracy on a
# single host (spread=0.0 there), so this only bites the ≥2 path.
SERVE_MAX_SPREAD_S = 10.0
# An `inferred` hit came from the cour-wide pool (a theme borrowed from ANOTHER
# episode because this one has no direct AnimeThemes mapping), so — unlike a
# directly-mapped theme — there is NO guarantee the sequence actually plays on
# this episode. Its song may still air over the end credits (the music matches)
# while the ED PICTURE is absent: that's a false positive on audio alone
# (measured on cyberpunk ep1 — 2 hosts agreed on an audio-only ED with zero
# video confirmation, matching the ED song's reprise, not the ED sequence). So
# an inferred hit is served ONLY when at least one host's IMAGE confirmed it.
# A directly-mapped hit is unaffected: AnimeThemes vouches that it belongs here.
INFERRED_REQUIRES_VIDEO = True
# A hit built on a SELF-DERIVED reference (oped/self_ref.py — the repeated
# segment recovered from the episodes themselves, used when AnimeThemes has no
# usable theme) has nothing vouching that the segment IS the OP/ED. Cross-host
# agreement doesn't help: every host carries the same segment, so they agree on
# a wrong answer just as readily as on a right one. Only the INTRA-SEASON pass
# (season_pass.py), which checks the segment lands consistently across the whole
# season, can promote it — so it is never served straight out of detection.
DERIVED_REQUIRES_SEASON = True
# Hosts whose episode duration differs from the majority by more than this
# fraction are not serving a differently-trimmed encode — they are serving
# DIFFERENT CONTENT. Real cross-host trim differences are seconds to tens of
# seconds (a few percent); anything past 15% is another episode entirely.
#
# Measured on bungou-stray-dogs `saison1hs`: anime-sama's hosts served the
# 700 s hors-série shorts while megaplay (whose embed is built from a MAL id +
# episode NUMBER, with no season signal — see adapter_aniscroll) and voir-anime
# served the 1420 s main-series episodes. The median of {700, 700, 1451, 1420}
# is 1060 s, a duration NO host has, and every ED from-end projection was then
# computed against it. Same failure shape as the fabricated consensus center in
# `_consensus`: a plausible-looking average of two incompatible populations.
DURATION_COHORT_TOL_FRAC = 0.15


@dataclass
class HostStream:
    """One resolved stream of an episode, with its own measured duration."""

    host: str
    url: str
    duration: float  # seconds — THIS host's encode length (differs across hosts)
    referer: str | None = None  # some hosts (megaplay) validate segment fetches
                                # by Referer only — must be passed to ffmpeg/probe
    # True when `duration` could not be probed and was ESTIMATED from the other
    # hosts of the same episode (F4). The OP is unaffected (its window and its
    # anchor are measured from the episode start, on the shared absolute clock),
    # but everything ED is anchored on the END, so an estimated length makes this
    # host's ED untrustworthy — the caller holds it back rather than dropping the
    # whole host and losing its OP too.
    duration_estimated: bool = False
    # Set when detection RAISED for this host — a transport failure (ffmpeg
    # timeout, 404, reset connection), not an absence of theme. Without it the
    # two are the same object downstream: an empty hit list. That silence is how
    # vidmoly-va's 57 % of missing audio windows looked exactly like "this
    # episode has no OP", and it is why the retrieval failure rate could not be
    # measured on any past run (07/08).
    detect_error: str | None = None


@dataclass
class ReconciledHit:
    """A cross-host consensus OP/ED interval, self-describing about duration.

    `start`/`end` are absolute seconds in `canonical_duration`'s timeline. For an
    ED, `from_end_start`/`from_end_end` give the duration-independent anchor so a
    consumer can re-project onto whatever duration the active player reports.
    """

    kind: str                       # "op" | "ed"
    slug: str
    start: float
    end: float
    canonical_duration: float
    from_end_start: float | None    # ED only: seconds before end (host-independent)
    from_end_end: float | None
    votes: int                      # summed votes of the agreeing hosts
    n_hosts_agree: int              # how many hosts landed within tolerance
    n_hosts_total: int              # how many hosts produced any hit for this kind
    spread_s: float                 # max−min of the agreeing anchor values
    # The hosts formed no single cluster (see _consensus): they split into
    # groups further apart than the outlier tolerance. `n_hosts_agree` then
    # counts only the largest group, and the hit is never served — picking a
    # side of a genuine disagreement is exactly the guess we refuse to make.
    hosts_split: bool = False
    # Hosts excluded before reconciliation because their episode duration put
    # them outside the majority cohort — they were serving different content
    # (wrong season, wrong episode). Non-zero means the source catalogues
    # disagree about what this episode IS, which is worth surfacing even though
    # the delivered timings are unaffected.
    hosts_wrong_duration: int = 0
    inferred: bool = False
    n_video_confirm: int = 0        # agreeing hosts whose video confirmed the audio
    video_disagreement: bool = False  # any agreeing host had audio/video divergence
    # Plausibility reasons (oped/validate.py) shared by ALL agreeing hosts. Only
    # unanimous ones land here: a reason raised by a single host is that host's
    # problem (its own row carries it), while a reason every host raises is a
    # property of the detection itself and holds the consensus back.
    anomalies: list = field(default_factory=list)
    # Every agreeing host fell back to the coarse audio t0 with the image having
    # RUN and REJECTED the alignment. Not fatal on its own (plenty of correct
    # hits are audio-only when no landmark survives), but it is the one case
    # where the picture actively failed to back the audio — reported so the
    # season pass and the API can rank it last.
    low_confidence: bool = False
    derived: bool = False           # built on a self-derived reference (F1)
    # Trouvé seulement par le balayage de dernier recours (hors fenêtre mappée).
    # L'accord entre hôtes ne suffit PAS à le valider : tous les hôtes passent la
    # même référence dans le même matcher sur la même région élargie, donc ils
    # reproduisent la même erreur éventuelle. Retenu jusqu'à revue manuelle.
    out_of_window: bool = False
    # Alignment provenance of the consensus (uniform across agreeing hosts, else
    # "mixed"): "credited" (all matched the with-credits rip — frame-accurate,
    # highest trust), "audio" (all audio-aligned, frame-accurate), "video" (all
    # NC-video-sourced, GOP-level), or "mixed". Consumers can trust "credited"/
    # "audio" for auto-skip and down-rank "video"/"mixed".
    source: str = "audio"

    @property
    def confident(self) -> bool:
        return self.n_hosts_agree >= MIN_AGREE_FOR_CONFIDENT

    @property
    def serve(self) -> bool:
        """Serve floor (user-confirmed policy — precision-first): ≥2 hosts agree,
        OR a single host whose video confirmed the audio. A purely video-sourced
        consensus counts toward the ≥2 floor (covers episodes where no host had
        usable audio — the picture still agreed across hosts). Everything else is
        stored-but-held.

        A ≥2-host "agreement" whose spread exceeds SERVE_MAX_SPREAD_S is held back:
        that wide a spread means the _consensus outlier fallback fabricated the
        agreement (hosts matched different theme occurrences). The hit stays stored
        for inspection but is not served. The guard is inert on the single-host
        video-confirm path (spread=0.0 there).

        An `inferred` hit (theme borrowed from another episode) is served only
        with image confirmation — see INFERRED_REQUIRES_VIDEO. Audio-only
        agreement across hosts is NOT enough for an inferred theme: the song can
        reprise over the credits without the ED sequence being present.

        A hit carrying a BLOCKING plausibility reason is never served, whatever
        the host agreement: cross-host agreement measures reproducibility, not
        correctness, and every host runs the SAME reference through the SAME
        matcher — they reproduce each other's mistakes. An implausible length, a
        clamped edge, a contested audio peak or an audio/image divergence are
        properties of the detection that no amount of agreement fixes.

        A `derived` hit is never served here at all — only the intra-season pass
        can promote it (DERIVED_REQUIRES_SEASON)."""
        if self.blocking:
            return False
        if DERIVED_REQUIRES_SEASON and self.derived:
            return False
        if self.out_of_window:
            return False
        if self.hosts_split:
            return False
        if self.n_hosts_agree >= 2 and self.spread_s > SERVE_MAX_SPREAD_S:
            return False
        if INFERRED_REQUIRES_VIDEO and self.inferred and self.n_video_confirm < 1:
            return False
        return self.n_hosts_agree >= MIN_AGREE_FOR_CONFIDENT or (
            self.n_hosts_agree >= 1 and self.n_video_confirm >= 1
        )

    @property
    def blocking(self) -> list[str]:
        """Plausibility reasons that forbid serving (oped/validate.BLOCKING)."""
        return validate.blocking(self.anomalies)

    @property
    def held_reason(self) -> str | None:
        """Why this hit is stored but not served — None when it is served."""
        if self.serve:
            return None
        if self.blocking:
            return ", ".join(self.blocking)
        if DERIVED_REQUIRES_SEASON and self.derived:
            return "self-derived reference, awaiting season confirmation"
        if self.hosts_split:
            return (f"hosts split into disagreeing groups "
                    f"(largest {self.n_hosts_agree}/{self.n_hosts_total}, "
                    f"{self.spread_s:.1f}s spread)")
        if self.n_hosts_agree >= 2 and self.spread_s > SERVE_MAX_SPREAD_S:
            return f"hosts disagree ({self.spread_s:.1f}s spread)"
        if INFERRED_REQUIRES_VIDEO and self.inferred and self.n_video_confirm < 1:
            return "inferred theme, no image confirmation"
        return "single host, no image confirmation"


def _anchor_value(hit: ThemeHit, duration: float, kind: str) -> float:
    """The duration-INDEPENDENT quantity to reconcile hosts on.

    OP → its absolute start (comparable when cold-opens match).
    ED → seconds-from-end (`duration - start`), immune to per-host length.
    """
    if kind == "ed":
        return max(0.0, duration - hit.start)
    return hit.start


def _duration_cohort(
    per_host: list[tuple[HostStream, list[ThemeHit]]],
) -> tuple[list[tuple[HostStream, list[ThemeHit]]], list[HostStream], bool]:
    """Keep only the hosts serving the SAME content; report the rest.

    Returns (kept, dropped_streams, ambiguous). `ambiguous` is True when the
    hosts split into cohorts of equal size — we then cannot tell which one is
    the requested episode, and the caller must not reconcile at all rather than
    average two different works together (see DURATION_COHORT_TOL_FRAC).
    """
    # Only MEASURED durations are evidence about what the host is serving. An
    # estimated one (F4 fallback, which lands on a nominal 24 min) is a guess,
    # and letting it vote would manufacture a rival cohort against a genuine
    # short — exactly the bungou-stray-dogs shape, but with no real
    # disagreement behind it. Estimated hosts ride along with whatever the
    # measured ones decide.
    known = [(s, h) for s, h in per_host
             if s.duration > 0 and not s.duration_estimated]
    if len(known) < 2:
        return per_host, [], False

    def cohort_of(ref: float) -> list[int]:
        tol = ref * DURATION_COHORT_TOL_FRAC
        return [i for i, (s, _) in enumerate(known) if abs(s.duration - ref) <= tol]

    cohorts = [cohort_of(s.duration) for s, _ in known]
    best = max(cohorts, key=len)
    if len(best) == len(known):
        return per_host, [], False

    # A strict majority identifies the episode; an even split does not.
    rivals = [c for c in cohorts if len(c) == len(best) and set(c) != set(best)]
    if rivals:
        return [], [s for s, _ in known], True

    keep_idx = set(best)
    kept = [known[i] for i in sorted(keep_idx)]
    dropped = [s for i, (s, _) in enumerate(known) if i not in keep_idx]
    # Hosts with no measured duration ride along: nothing says they disagree.
    kept += [(s, h) for s, h in per_host
             if s.duration <= 0 or s.duration_estimated]
    return kept, dropped, False


def _consensus(
    values: list[float],
    weights: list[float],
    *,
    tolerance: float = OUTLIER_TOLERANCE_S,
) -> tuple[list[int], float, float, bool]:
    """Cluster values around their median, drop outliers past `tolerance`.

    Returns (kept_indices, weighted_center, spread, split). The center is the
    weight-weighted mean of the kept values — weights are our per-host confidence
    (votes, scaled down for coarse video-sourced hits), so a strong match pulls
    the consensus more than a weak one.

    `split` is the honest flag for "the hosts did not form one cluster at all".
    It used to be silently absent: when nothing survived the median filter the
    function reintegrated EVERY value and the caller stored `n_hosts_agree =
    len(values)`, so hyouka ep3 reported `4/4 agreeing` and `22.0s spread` on the
    same line — both derived from the same call, and the first one false. Worse,
    the fabricated center was only held back by SERVE_MAX_SPREAD_S, so a split
    whose halves sit ~10 s apart (two pairs at ±5 around the median, each past
    the 4 s tolerance) got SERVED as a timecode that exists on no host. `split`
    now blocks that path explicitly, and `kept` reports the real largest cluster
    instead of pretending everyone agreed.
    """
    if not values:
        return [], 0.0, 0.0, False
    med = statistics.median(values)
    kept = [i for i, v in enumerate(values) if abs(v - med) <= tolerance]
    split = False
    if not kept:
        split = True
        # Report the LARGEST genuine cluster rather than "everyone". It is the
        # only honest count, and it keeps the stored center on a timecode some
        # host actually produced. `split` is what forbids serving it — a 2-vs-2
        # disagreement is a real ambiguity we must not resolve by picking a side.
        best: list[int] = []
        for v in values:
            near = [i for i, x in enumerate(values) if abs(x - v) <= tolerance]
            if len(near) > len(best):
                best = near
        kept = best or list(range(len(values)))
    kv = [values[i] for i in kept]
    kw = [max(1e-6, weights[i]) for i in kept]
    center = sum(v * w for v, w in zip(kv, kw)) / sum(kw)
    # The spread that matters is across ALL hosts when they split — the kept
    # cluster's own spread would be reassuringly small and would hide the very
    # disagreement being reported.
    span = values if split else kv
    spread = (max(span) - min(span)) if len(span) > 1 else 0.0
    return kept, center, spread, split


def reconcile_hits(
    per_host: list[tuple[HostStream, list[ThemeHit]]],
    *,
    canonical_duration: float | None = None,
    inferred_op: bool = False,
    inferred_ed: bool = False,
) -> list[ReconciledHit]:
    """Merge per-host detections of ONE episode into cross-host consensus hits.

    `per_host` is [(stream, hits), …] — one entry per host that was tried, each
    holding whatever `detect_op_ed` recovered against THAT host's stream.

    `canonical_duration` sets the timeline the returned absolute `start`/`end`
    are expressed in; defaults to the median host duration (the most
    representative encode). ED absolute times are recomputed from the
    consensus seconds-from-end against this canonical duration, so they're
    coherent regardless of which hosts contributed.

    `inferred_op`/`inferred_ed` mark the kind as borrowed from the cour-wide
    pool (no direct AnimeThemes mapping for this episode). detect_op_ed_v2 does
    NOT stamp `inferred` on its per-host ThemeHits — the caller owns that
    knowledge (it chose the pool refs) — so it's threaded in here and set on the
    ReconciledHit, where `serve` reads it (see INFERRED_REQUIRES_VIDEO)."""
    if not per_host:
        return []

    # Drop hosts that aren't serving this episode at all before ANY averaging —
    # otherwise both the canonical duration and the anchors are computed across
    # two different works (see DURATION_COHORT_TOL_FRAC).
    per_host, off_cohort, ambiguous = _duration_cohort(per_host)
    if ambiguous:
        return []

    durations = [s.duration for s, _ in per_host if s.duration > 0]
    canon = canonical_duration or (
        statistics.median(durations) if durations else 24 * 60.0
    )

    out: list[ReconciledHit] = []
    for kind in ("op", "ed"):
        # Gather this kind's hit from every host that found one.
        streams: list[HostStream] = []
        hits: list[ThemeHit] = []
        for stream, host_hits in per_host:
            h = next((x for x in host_hits if x.kind == kind), None)
            if h is None:
                continue
            # An ED anchors on seconds-FROM-END, so a host whose length is an
            # estimate (F4) would poison the consensus with a shifted anchor.
            # Its OP is unaffected and still counts.
            if kind == "ed" and stream.duration_estimated:
                continue
            streams.append(stream)
            hits.append(h)
        if not hits:
            continue

        anchors = [_anchor_value(h, s.duration, kind) for s, h in zip(streams, hits)]
        # Weight each host by its votes, but scale NC-video hits down so a coarse
        # (GOP-level) video alignment can't dominate a frame-accurate audio one
        # when both are present. A CREDITED hit is frame-accurate (same on-screen
        # credits as the episode), so it is full-trust like audio — never
        # down-weighted, never loosens the tolerance. Only NC source="video"
        # triggers the widened tolerance (audio↔NC-video jitters more).
        has_video = any(h.source == "video" for h in hits)
        weights = [
            h.votes * (VIDEO_WEIGHT_FACTOR if h.source == "video" else 1.0)
            for h in hits
        ]
        tol = OUTLIER_TOLERANCE_VIDEO_S if has_video else OUTLIER_TOLERANCE_S
        kept, center, spread, split = _consensus(anchors, weights, tolerance=tol)

        # Reconcile the interval LENGTH the same way (it's duration-independent
        # for both kinds), so a host that mis-bounded one edge can't stretch it.
        lengths = [hits[i].end - hits[i].start for i in kept]
        length = statistics.median(lengths) if lengths else (
            hits[0].end - hits[0].start
        )

        if kind == "ed":
            from_end_start = center            # seconds before the end
            start = max(0.0, canon - from_end_start)
            end = min(canon, start + length)
            from_end_end = max(0.0, canon - end)
        else:
            start = center
            end = start + length
            from_end_start = from_end_end = None

        # Provenance of the AGREEING hosts. "credited" is the highest-trust,
        # frame-accurate source and is reported as such when every agreeing host
        # used it; a uniform audio or NC-video set reports that source; anything
        # else is "mixed". (credited + audio, both frame-accurate, still reports
        # "mixed" so a reader can see the hosts disagreed on method.)
        kept_sources = {hits[i].source for i in kept} if kept else {"audio"}
        if len(kept_sources) == 1:
            src = next(iter(kept_sources))
        else:
            src = "mixed"

        out.append(
            ReconciledHit(
                kind=kind,
                slug=hits[kept[0]].slug if kept else hits[0].slug,
                start=round(start, 3),
                end=round(end, 3),
                canonical_duration=round(canon, 3),
                from_end_start=None if from_end_start is None else round(from_end_start, 3),
                from_end_end=None if from_end_end is None else round(from_end_end, 3),
                # Report the raw (unscaled) summed votes of the agreeing hosts.
                votes=sum(hits[i].votes for i in kept),
                n_hosts_agree=len(kept),
                n_hosts_total=len(hits),
                spread_s=round(spread, 3),
                hosts_split=split,
                hosts_wrong_duration=len(off_cohort),
                inferred=(inferred_op if kind == "op" else inferred_ed)
                or (all(hits[i].inferred for i in kept) if kept else False),
                # A host counts as image-confirmed when EITHER the legacy pipeline
                # set confirmed_by_video, OR (v2) its hit is image-sourced at all:
                # in v2 a "credited"/"video" hit's t0 IS the landmark-anchored one
                # (confirmed_by_video is never set on that path), so provenance is
                # the image-confirmation signal. An "audio"/"mixed" hit is not.
                n_video_confirm=sum(
                    1 for i in kept
                    if hits[i].confirmed_by_video or hits[i].source in ("credited", "video")
                ),
                video_disagreement=any(hits[i].video_disagreement for i in kept),
                source=src,
                # UNANIMOUS plausibility reasons only (see the field comment):
                # one host raising a reason is a host problem, every host raising
                # it is a detection problem. Order-stable for readable logs.
                anomalies=[
                    r for r in (hits[kept[0]].anomalies if kept else [])
                    if all(r in hits[i].anomalies for i in kept)
                ],
                low_confidence=bool(kept) and all(
                    hits[i].align_status == "rejected" for i in kept
                ),
                derived=bool(kept) and all(hits[i].derived for i in kept),
                # ANY, pas ALL : il suffit qu'un hôte l'ait trouvé hors fenêtre
                # pour que le consensus hérite du doute. `derived` peut se
                # permettre ALL (la référence est self-dérivée ou elle ne l'est
                # pas, uniformément) ; ici les hôtes peuvent diverger, et c'est
                # justement le cas douteux qu'on veut retenir.
                out_of_window=any(hits[i].out_of_window for i in kept),
            )
        )

    out.sort(key=lambda h: h.start)
    return out


def detect_per_host(
    streams: list[HostStream],
    resolve_window_for,
    op_refs: list[ThemeReference],
    ed_refs: list[ThemeReference],
    *,
    resolve_samples_for=None,
    resolve_video_for=None,
    resolve_video_dense_for=None,
    resolve_window_duration_for=None,
    resolve_audio_abs_for=None,
    resolve_video_abs_for=None,
    v2: bool = False,
    op_pool_refs: list[ThemeReference] | None = None,
    ed_pool_refs: list[ThemeReference] | None = None,
    mark_derived: bool = False,
    op_window=OP_WINDOW,
    ed_window=ED_WINDOW,
    min_votes: int = 40,
    min_score: float | None = None,
    full_fallback: bool = True,
    seed_from_peers: bool = True,
    full_episode_scan: bool = True,
) -> list[tuple[HostStream, list[ThemeHit]]]:
    """Run the full detector once PER HOST (in parallel), returning each host's
    OWN detected hits — WITHOUT reconciling them into a consensus.

    This is the raw material behind both `detect_op_ed_multi` (which reconciles
    it) and the per-host delivery path: each entry is (stream, hits) where the
    hits are in THAT host's own episode time, against THAT host's own duration.
    Because every host serves a differently-trimmed encode, these per-host
    timings are what a player actually needs at runtime — the consensus is only
    a cross-check on top.

    `v2=True` runs the Stage-4 image-credited pipeline (`detect_op_ed_v2`) per
    host instead of the cascade, using the ABSOLUTE resolvers
    `resolve_audio_abs_for(stream, start_abs, dur)` and
    `resolve_video_abs_for(stream, start_abs, dur, fps)`. Each host is still
    detected in its OWN absolute time; `reconcile_hits` then folds them the same
    way (it reads only source/votes/flags, which v2 populates), becoming a pure
    cross-host confidence check rather than a correction (per-host t0 is already
    frame-accurate on the shared absolute clock).
    """

    def _run_one(stream: HostStream) -> tuple[HostStream, list[ThemeHit]]:
        if v2:
            audio_abs_cb = (
                lambda start_abs, dur, _s=stream: resolve_audio_abs_for(_s, start_abs, dur)
            )
            video_abs_cb = (
                (lambda start_abs, dur, fps, _s=stream: resolve_video_abs_for(_s, start_abs, dur, fps))
                if resolve_video_abs_for is not None else None
            )
            kw = {} if min_score is None else {"min_score": min_score}
            try:
                hits = detect_op_ed_v2(
                    stream.duration,
                    op_refs,
                    ed_refs,
                    resolve_audio_abs=audio_abs_cb,
                    resolve_video_abs=video_abs_cb,
                    op_pool_refs=op_pool_refs,
                    ed_pool_refs=ed_pool_refs,
                    min_votes=min_votes,
                    **kw,
                )
            except ProcessKilled:
                raise   # cf. errors.ProcessKilled : ne pas maquiller
                        # une machine qui meurt en absence de generique
            except Exception as exc:
                # Resilient, but no longer silent — see HostStream.detect_error.
                stream.detect_error = f"{type(exc).__name__}: {exc}"
                print(f"  [detect-fail] {stream.host}: {stream.detect_error}")
                hits = []
            if mark_derived:
                # The refs came from self_ref (no AnimeThemes clip vouches for
                # them), so every hit inherits the flag the serve gate reads.
                for h in hits:
                    h.derived = True
            return stream, hits

        samples_cb = (
            (lambda win, _s=stream: resolve_samples_for(_s, win))
            if resolve_samples_for is not None else None
        )
        video_cb = (
            (lambda win, _s=stream: resolve_video_for(_s, win))
            if resolve_video_for is not None else None
        )
        video_dense_cb = (
            (lambda win, fps, _s=stream: resolve_video_dense_for(_s, win, fps))
            if resolve_video_dense_for is not None else None
        )
        win_dur_cb = (
            (lambda win, _s=stream: resolve_window_duration_for(_s, win))
            if resolve_window_duration_for is not None else None
        )
        kw = {} if min_score is None else {"min_score": min_score}
        try:
            hits = detect_op_ed(
                lambda win, _s=stream: resolve_window_for(_s, win),
                stream.duration,
                op_refs,
                ed_refs,
                resolve_samples=samples_cb,
                resolve_video=video_cb,
                resolve_video_dense=video_dense_cb,
                resolve_window_duration=win_dur_cb,
                op_window=op_window,
                ed_window=ed_window,
                min_votes=min_votes,
                full_fallback=full_fallback,
                **kw,
            )
        except ProcessKilled:
            raise   # cf. errors.ProcessKilled : ne pas maquiller
                    # une machine qui meurt en absence de generique
        except Exception as exc:
            # A single flaky host must not sink the episode — its peers carry it.
            # But record WHY: an empty list from a dead transport and an empty
            # list from a themeless episode must not be the same fact.
            stream.detect_error = f"{type(exc).__name__}: {exc}"
            print(f"  [detect-fail] {stream.host}: {stream.detect_error}")
            hits = []
        return stream, hits

    per_host: list[tuple[HostStream, list[ThemeHit]]] = []
    if streams:
        with ThreadPoolExecutor(max_workers=len(streams)) as pool:
            for stream, hits in pool.map(_run_one, streams):
                per_host.append((stream, hits))

    kw = {} if min_score is None else {"min_score": min_score}

    # BALAYAGE PLEIN-ÉPISODE : une seule fois, sur UN seul hôte.
    # Un thème mappé qu'AUCUN hôte n'a trouvé signale une fenêtre aveugle, pas
    # une absence (Erased ep1 : l'épisode finit sur la chanson d'OUVERTURE, à
    # 1281 s). Mais le balayage décode le fichier entier : ouvert par hôte, il
    # rend les lots impraticables. On le paie donc UNE fois, puis l'amorçage
    # ci-dessous porte le résultat aux autres hôtes pour 90 s de fenêtre chacun.
    if full_episode_scan and v2 and per_host:
        found_kinds = {h.kind for _s, hs in per_host for h in hs}
        want = [k for k, r in (("op", op_refs), ("ed", ed_refs))
                if r and k not in found_kinds]
        if want:
            scout = next((s for s, _h in per_host if not s.detect_error), None)
            if scout is not None:
                try:
                    extra = detect_op_ed_v2(
                        scout.duration,
                        op_refs if "op" in want else [],
                        ed_refs if "ed" in want else [],
                        resolve_audio_abs=(
                            lambda s_abs, d, _s=scout: resolve_audio_abs_for(_s, s_abs, d)
                        ),
                        min_votes=min_votes, full_episode_scan=True, **kw,
                    )
                except ProcessKilled:
                    raise   # cf. errors.ProcessKilled : ne pas maquiller
                            # une machine qui meurt en absence de generique
                except Exception as exc:
                    scout.detect_error = f"{type(exc).__name__}: {exc}"
                    print(f"  [detect-fail] {scout.host} (balayage): "
                          f"{scout.detect_error}")
                    extra = []
                if extra:
                    for _s, hs in per_host:
                        if _s is scout:
                            hs.extend(extra)
                            break
                    for h in extra:
                        print(f"  [scan] {scout.host}: {h.kind} hors fenetre a "
                              f"{h.start:.1f}")

    if seed_from_peers:

        def _search(stream: HostStream, kind: str, start: float, dur: float):
            """Rechercher UN seul kind, dans [start, start+dur], sur l'audio de
            CET hôte. Les deux branches exposent des résolveurs différents —
            v2 travaille en temps absolu, la cascade par fenêtres — d'où
            l'aiguillage ici plutôt qu'en double dans l'appelant."""
            ops = op_refs if kind == "op" else []
            eds = ed_refs if kind == "ed" else []
            if v2:
                return detect_op_ed_v2(
                    stream.duration, ops, eds,
                    resolve_audio_abs=(
                        lambda s_abs, d, _s=stream: resolve_audio_abs_for(_s, s_abs, d)
                    ),
                    resolve_video_abs=(
                        (lambda s_abs, d, fps, _s=stream:
                         resolve_video_abs_for(_s, s_abs, d, fps))
                        if resolve_video_abs_for is not None else None
                    ),
                    op_search=(start, dur),
                    # L'ED se cherche depuis la FIN : on convertit la fenêtre
                    # absolue en profondeur de queue, sinon on chercherait au
                    # mauvais endroit sans que rien ne le signale.
                    # ⚠️ ASYMÉTRIE ASSUMÉE : v2 reconstruit ensuite la fenêtre
                    # comme [durée − profondeur, FIN]. Côté ED, l'amorce couvre
                    # donc [start, fin d'épisode] et non [start, start+dur] —
                    # plus large que ce que `SEED_WINDOW_HALF_S` laisse croire.
                    # C'est sans effet pratique (une amorce d'ED est déjà près
                    # de la fin) et v2 n'expose pas de borne de fin, mais le
                    # dire évite de relire ce code en croyant à une symétrie.
                    ed_search_from_end=max(stream.duration - start, 0.0),
                    min_votes=min_votes, **kw,
                )
            return detect_op_ed(
                lambda win, _s=stream: resolve_window_for(_s, win),
                stream.duration, ops, eds,
                op_window=(start, start + dur),
                ed_window=(start, start + dur),
                min_votes=min_votes,
                full_fallback=False,       # ciblé : surtout pas de balayage ici
                **kw,
            )

        # Longueur du plus long générique de chaque kind : la fenêtre d'amorce
        # doit ENGLOBER le thème, pas seulement son début. Centrée sur le début
        # elle n'en couvrait que la moitié, `fill` tombait à ~0,5 et le hit
        # était rejeté au seuil — c'est ce qui a fait échouer la propagation
        # sur Erased ep1 au premier essai.
        _seed_from_peers(
            per_host, _search,
            has_refs={"op": bool(op_refs), "ed": bool(ed_refs)},
            ref_dur={
                "op": max((r.duration for r in (op_refs or [])), default=0.0),
                "ed": max((r.duration for r in (ed_refs or [])), default=0.0),
            },
        )
    return per_host


# Demi-largeur de la fenêtre ouverte autour du timing d'un pair. Assez large
# pour absorber un montage qui diffère (rappel d'épisode plus long, carton de
# sponsor), assez étroite pour rester une recherche ciblée et non un balayage.
SEED_WINDOW_HALF_S = 45.0


def _seed_from_peers(per_host, search, *, has_refs: dict[str, bool],
                     ref_dur: dict[str, float] | None = None) -> None:
    """Rattraper un hôte muet en cherchant LÀ OÙ un pair a trouvé (07/08).

    CE QUE CETTE FONCTION NE FAIT PAS : copier le timing du pair. C'est
    l'évidence qu'on croit tenir et elle est fausse — mesuré sur 690 cellules,
    deux hôtes de durée identique à **0,02 s près** placent quand même l'OP à
    plus d'une seconde d'écart dans **10,6 %** des cas, et resserrer la
    tolérance n'améliore rien (le plancher reste ~9 %). Une durée égale ne
    prouve pas un montage égal. Copier, ce serait se tromper une fois sur dix
    ET fabriquer un faux accord entre deux hôtes, précisément ce que la porte de
    service (`MIN_AGREE_FOR_CONFIDENT`) est là pour empêcher.

    Ce qu'elle fait : utiliser le timing du pair comme AMORCE, et rechercher le
    thème dans l'audio PROPRE de l'hôte muet, sur une fenêtre étroite autour de
    cette amorce. L'hôte confirme donc sur son propre signal — l'accord reste
    gagné, jamais recopié — et une recherche ciblée coûte une fraction du
    balayage complet.

    Gisement mesuré : 82 hôtes muets ont déjà leur audio en cache dans les
    cellules qui n'ont qu'UN SEUL hôte qui répond, c'est-à-dire à un hôte du
    seuil de service.
    """
    by_kind: dict[str, list[float]] = {}
    for _s, hits in per_host:
        for h in hits:
            by_kind.setdefault(h.kind, []).append(h.start)
    if not by_kind:
        return

    for stream, hits in per_host:
        if stream.detect_error:
            continue                      # transport mort : rien à interroger
        have = {h.kind for h in hits}
        for kind, starts in by_kind.items():
            if kind in have or not has_refs.get(kind):
                continue
            seed = statistics.median(starts)
            start = max(0.0, seed - SEED_WINDOW_HALF_S)
            # [amorce − marge, amorce + longueur du thème + marge] : la fenêtre
            # doit contenir le générique EN ENTIER, sinon `fill` s'effondre.
            span = 2 * SEED_WINDOW_HALF_S + (ref_dur or {}).get(kind, 0.0)
            dur = min(span, max(stream.duration - start, 0.0))
            if dur <= 0:
                continue
            try:
                found = search(stream, kind, start, dur)
            except ProcessKilled:
                raise   # cf. errors.ProcessKilled : ne pas maquiller
                        # une machine qui meurt en absence de generique
            except Exception as exc:
                stream.detect_error = f"{type(exc).__name__}: {exc}"
                print(f"  [detect-fail] {stream.host} (amorce {kind}): "
                      f"{stream.detect_error}")
                continue
            for h in found:
                if h.kind != kind:
                    continue
                h.seeded_by_peer = True
                hits.append(h)
                print(f"  [seed] {stream.host}: {kind} retrouve a "
                      f"{h.start:.1f} (amorce {seed:.1f})")


def detect_op_ed_multi(
    streams: list[HostStream],
    resolve_window_for,
    op_refs: list[ThemeReference],
    ed_refs: list[ThemeReference],
    *,
    resolve_samples_for=None,
    resolve_video_for=None,
    resolve_video_dense_for=None,
    resolve_window_duration_for=None,
    resolve_audio_abs_for=None,
    resolve_video_abs_for=None,
    v2: bool = False,
    op_window=OP_WINDOW,
    ed_window=ED_WINDOW,
    min_votes: int = 40,
    min_score: float | None = None,
    full_fallback: bool = True,
    canonical_duration: float | None = None,
) -> list[ReconciledHit]:
    """Detect OP/ED across MULTIPLE hosts of one episode, then reconcile.

    `resolve_window_for(stream, window)` returns the episode Fingerprint for a
    given host stream + decode window (the caller owns stream resolution and
    caching). Each host is matched against the SAME theme references with that
    host's OWN duration, so the ED end-of-file window maps correctly per host;
    reconciliation then folds the per-host results into consensus hits that are
    robust to the hosts' differing lengths.

    Hosts are processed IN PARALLEL — each `detect_op_ed` call decodes two
    short audio windows (OP + ED) over the network and fingerprints them, which
    is the most expensive step per host. Running them concurrently means the
    wall-clock cost of this call is close to the SLOWEST single host, not the
    sum of all of them.

    Thin wrapper over `detect_per_host` + `reconcile_hits`; use `detect_per_host`
    directly when you also need each host's individual timing.
    """
    per_host = detect_per_host(
        streams, resolve_window_for, op_refs, ed_refs,
        resolve_samples_for=resolve_samples_for,
        resolve_video_for=resolve_video_for,
        resolve_video_dense_for=resolve_video_dense_for,
        resolve_window_duration_for=resolve_window_duration_for,
        resolve_audio_abs_for=resolve_audio_abs_for,
        resolve_video_abs_for=resolve_video_abs_for,
        v2=v2,
        op_window=op_window, ed_window=ed_window,
        min_votes=min_votes, min_score=min_score, full_fallback=full_fallback,
    )
    return reconcile_hits(per_host, canonical_duration=canonical_duration)