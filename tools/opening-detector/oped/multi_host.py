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


def _consensus(
    values: list[float],
    weights: list[float],
    *,
    tolerance: float = OUTLIER_TOLERANCE_S,
) -> tuple[list[int], float, float]:
    """Cluster values around their median, drop outliers past `tolerance`.

    Returns (kept_indices, weighted_center, spread). The center is the
    weight-weighted mean of the kept values — weights are our per-host confidence
    (votes, scaled down for coarse video-sourced hits), so a strong match pulls
    the consensus more than a weak one.
    """
    if not values:
        return [], 0.0, 0.0
    med = statistics.median(values)
    kept = [i for i, v in enumerate(values) if abs(v - med) <= tolerance]
    if not kept:
        # Everything fell outside tolerance (e.g. 2 hosts far apart → their median
        # is the midpoint, so BOTH are half-the-gap away). We reintegrate all so a
        # legitimate tight cluster near the tolerance edge isn't lost — but here
        # `len(kept)` is NOT a measure of agreement. The returned `spread` carries
        # the truth, and ReconciledHit.serve (SERVE_MAX_SPREAD_S) is what holds
        # back a fabricated ≥2 "agreement". Do not read n_hosts_agree as consensus
        # without also checking spread.
        kept = list(range(len(values)))
    kv = [values[i] for i in kept]
    kw = [max(1e-6, weights[i]) for i in kept]
    center = sum(v * w for v, w in zip(kv, kw)) / sum(kw)
    spread = (max(kv) - min(kv)) if len(kv) > 1 else 0.0
    return kept, center, spread


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
        kept, center, spread = _consensus(anchors, weights, tolerance=tol)

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
            except Exception:
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
        except Exception:
            # A single flaky host must not sink the episode — its peers carry it.
            hits = []
        return stream, hits

    per_host: list[tuple[HostStream, list[ThemeHit]]] = []
    if streams:
        with ThreadPoolExecutor(max_workers=len(streams)) as pool:
            for stream, hits in pool.map(_run_one, streams):
                per_host.append((stream, hits))
    return per_host


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