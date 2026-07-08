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

from .theme_bank import ThemeHit, ThemeReference, detect_op_ed, ED_WINDOW, OP_WINDOW


# A host whose recovered timecode sits further than this from the consensus is
# treated as an outlier (different encode / a mis-detection) and dropped. Chosen
# generously: real cross-host jitter is sub-second to a couple of seconds, while
# a differently-trimmed encode or a false match is off by many seconds.
OUTLIER_TOLERANCE_S = 4.0
# Below this many agreeing hosts we still emit a hit but flag it low-confidence
# (a single host can be right, but we can't cross-check it).
MIN_AGREE_FOR_CONFIDENT = 2


@dataclass
class HostStream:
    """One resolved stream of an episode, with its own measured duration."""

    host: str
    url: str
    duration: float  # seconds — THIS host's encode length (differs across hosts)


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

    @property
    def confident(self) -> bool:
        return self.n_hosts_agree >= MIN_AGREE_FOR_CONFIDENT

    @property
    def serve(self) -> bool:
        """Serve floor (user-confirmed policy): ≥2 hosts agree, OR a single host
        whose video confirmed the audio. Everything else is stored-but-held."""
        return self.n_hosts_agree >= MIN_AGREE_FOR_CONFIDENT or (
            self.n_hosts_agree >= 1 and self.n_video_confirm >= 1
        )


def _anchor_value(hit: ThemeHit, duration: float, kind: str) -> float:
    """The duration-INDEPENDENT quantity to reconcile hosts on.

    OP → its absolute start (comparable when cold-opens match).
    ED → seconds-from-end (`duration - start`), immune to per-host length.
    """
    if kind == "ed":
        return max(0.0, duration - hit.start)
    return hit.start


def _consensus(values: list[float], weights: list[int]) -> tuple[list[int], float, float]:
    """Cluster values around their median, drop outliers past the tolerance.

    Returns (kept_indices, weighted_center, spread). The center is the
    vote-weighted mean of the kept values — votes are our per-host confidence,
    so a strong match pulls the consensus more than a weak one.
    """
    if not values:
        return [], 0.0, 0.0
    med = statistics.median(values)
    kept = [i for i, v in enumerate(values) if abs(v - med) <= OUTLIER_TOLERANCE_S]
    if not kept:
        kept = list(range(len(values)))
    kv = [values[i] for i in kept]
    kw = [max(1, weights[i]) for i in kept]
    center = sum(v * w for v, w in zip(kv, kw)) / sum(kw)
    spread = (max(kv) - min(kv)) if len(kv) > 1 else 0.0
    return kept, center, spread


def reconcile_hits(
    per_host: list[tuple[HostStream, list[ThemeHit]]],
    *,
    canonical_duration: float | None = None,
) -> list[ReconciledHit]:
    """Merge per-host detections of ONE episode into cross-host consensus hits.

    `per_host` is [(stream, hits), …] — one entry per host that was tried, each
    holding whatever `detect_op_ed` recovered against THAT host's stream.

    `canonical_duration` sets the timeline the returned absolute `start`/`end`
    are expressed in; defaults to the median host duration (the most
    representative encode). ED absolute times are recomputed from the
    consensus seconds-from-end against this canonical duration, so they're
    coherent regardless of which hosts contributed.
    """
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
            if h is not None:
                streams.append(stream)
                hits.append(h)
        if not hits:
            continue

        anchors = [_anchor_value(h, s.duration, kind) for s, h in zip(streams, hits)]
        weights = [h.votes for h in hits]
        kept, center, spread = _consensus(anchors, weights)

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

        out.append(
            ReconciledHit(
                kind=kind,
                slug=hits[kept[0]].slug if kept else hits[0].slug,
                start=round(start, 3),
                end=round(end, 3),
                canonical_duration=round(canon, 3),
                from_end_start=None if from_end_start is None else round(from_end_start, 3),
                from_end_end=None if from_end_end is None else round(from_end_end, 3),
                votes=sum(weights[i] for i in kept),
                n_hosts_agree=len(kept),
                n_hosts_total=len(hits),
                spread_s=round(spread, 3),
                inferred=all(hits[i].inferred for i in kept) if kept else False,
                n_video_confirm=sum(1 for i in kept if hits[i].confirmed_by_video),
                video_disagreement=any(hits[i].video_disagreement for i in kept),
            )
        )

    out.sort(key=lambda h: h.start)
    return out


def detect_op_ed_multi(
    streams: list[HostStream],
    resolve_window_for,
    op_refs: list[ThemeReference],
    ed_refs: list[ThemeReference],
    *,
    resolve_samples_for=None,
    resolve_video_for=None,
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
    """

    def _run_one(stream: HostStream) -> tuple[HostStream, list[ThemeHit]]:
        samples_cb = (
            (lambda win, _s=stream: resolve_samples_for(_s, win))
            if resolve_samples_for is not None else None
        )
        video_cb = (
            (lambda win, _s=stream: resolve_video_for(_s, win))
            if resolve_video_for is not None else None
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

    return reconcile_hits(per_host, canonical_duration=canonical_duration)