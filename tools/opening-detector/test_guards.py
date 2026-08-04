"""Offline tests for the fallback + false-positive layer (no network, no ffmpeg).

Runs against synthetic data only, so it is safe on any machine and fast enough
to run before every commit:

    python test_guards.py

Covers: the plausibility reasons (validate), the rival-peak metric (matcher),
fingerprint slicing (self_ref's zero-decode reference), the self-match segment
finder and its anti-recap guard, the serve gate (multi_host), and the season
pass — including the case the whole design has to get right: an episode 1 whose
OP sits minutes into the episode must NOT be flagged as an outlier.
"""

from __future__ import annotations

import sys

import numpy as np

from oped import validate, self_ref
from oped.fingerprint import Fingerprint, slice_fingerprint
from oped.matcher import best_match_ranked
from oped.multi_host import HostStream, ReconciledHit, reconcile_hits
from oped.theme_bank import ThemeHit, ThemeReference, detect_op_ed_v2
from oped import HOP_SECONDS
import season_pass

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name} — {detail}")
        print(f"  FAIL {name} {detail}")


def hit(**kw) -> ThemeHit:
    base = dict(kind="op", slug="OP1", version=1, start=90.0, end=180.0,
                votes=500, score=5.0, vote_start=92.0, vote_end=175.0,
                ref_duration=90.0, source="credited")
    base.update(kw)
    return ThemeHit(**base)


# ── validate ─────────────────────────────────────────────────────────────────

def test_validate():
    print("validate")
    check("clean hit has no anomaly", hit_anomalies_of(hit()) == [])

    check("full-version rip rejected",
          "implausible_length" in hit_anomalies_of(
              hit(end=90.0 + 260.0, ref_duration=260.0)))

    check("5s scrap rejected",
          "implausible_length" in hit_anomalies_of(hit(end=95.0, ref_duration=5.0)))

    # Reference overflowing the episode end → the delivered edge was cut.
    check("clamped end reported",
          "end_clamped" in validate.hit_anomalies(
              hit(start=1350.0, end=1400.0, ref_duration=90.0), 1400.0))

    check("votes over a sliver of the interval rejected",
          "vote_span_too_short" in hit_anomalies_of(
              hit(vote_start=90.0, vote_end=100.0)))

    check("audio/image divergence rejected",
          "av_divergence" in hit_anomalies_of(hit(av_delta=9.0)))
    check("small audio/image gap accepted",
          "av_divergence" not in hit_anomalies_of(hit(av_delta=1.2)))

    check("contested audio peak rejected on an audio hit",
          "ambiguous_audio_peak" in hit_anomalies_of(
              hit(source="audio", peak_margin=0.8)))
    check("contested audio peak tolerated when the image anchored it",
          "ambiguous_audio_peak" not in hit_anomalies_of(
              hit(source="credited", peak_margin=0.8)))

    check("two themes tied → ambiguous_theme",
          "ambiguous_theme" in hit_anomalies_of(hit(theme_margin=0.02)))

    op = hit(kind="op", start=60.0, end=150.0)
    ed = hit(kind="ed", start=140.0, end=230.0)
    check("overlapping OP/ED both flagged",
          validate.pair_anomalies([op, ed]) == {"op": ["op_ed_overlap"],
                                                "ed": ["op_ed_overlap"]})
    check("non-overlapping OP/ED clean",
          validate.pair_anomalies([hit(start=60.0, end=150.0),
                                   hit(kind="ed", start=1300.0, end=1390.0)]) == {})

    check("blocking() filters to actionable reasons",
          validate.blocking(["relaxed_fill", "av_divergence"]) == ["av_divergence"])


def hit_anomalies_of(h: ThemeHit) -> list[str]:
    return validate.hit_anomalies(h, episode_duration=1440.0)


# ── matcher: rival peak ──────────────────────────────────────────────────────

def _fp(pairs: list[tuple[int, float]]) -> Fingerprint:
    """Fingerprint from (hash, time_seconds) pairs, sorted by hash as required."""
    pairs = sorted(pairs)
    h = np.array([p[0] for p in pairs], dtype=np.uint64)
    t = np.array([round(p[1] / HOP_SECONDS) for p in pairs], dtype=np.int32)
    return Fingerprint(h, t, n_frames=int(t.max()) + 1 if len(t) else 0)


def test_rival_peak():
    print("matcher.best_match_ranked")
    ref = _fp([(1000 + i, i * 0.5) for i in range(200)])

    # Query holding the reference ONCE, at +60s.
    once = _fp([(1000 + i, 60.0 + i * 0.5) for i in range(200)])
    m, rival = best_match_ranked(once, ref, min_votes=40)
    check("single occurrence found", m is not None and abs(m.q_start - 60.0) < 0.5,
          f"{m}")
    check("single occurrence has no rival", rival == 0.0, f"rival={rival}")

    # Query holding it TWICE (a reprise) — the second copy is nearly as strong.
    twice = _fp([(1000 + i, 60.0 + i * 0.5) for i in range(200)]
                + [(1000 + i, 600.0 + i * 0.5) for i in range(190)])
    m2, rival2 = best_match_ranked(twice, ref, min_votes=40)
    check("reprise flagged as contested",
          rival2 >= validate.AMBIGUOUS_PEAK_RATIO, f"rival={rival2}")


# ── fingerprint slicing (self-derived reference) ─────────────────────────────

def test_slice():
    print("fingerprint.slice_fingerprint")
    fp = _fp([(500 + i, i * 1.0) for i in range(120)])   # 0..119 s
    sub = slice_fingerprint(fp, 30.0, 60.0)
    times = sorted(sub.times * HOP_SECONDS)
    check("only the segment survives", len(times) == 31, f"n={len(times)}")
    check("times re-based to zero", abs(times[0]) < 0.05, f"t0={times[0]}")
    check("segment length preserved", abs(times[-1] - 30.0) < 0.1, f"t1={times[-1]}")
    check("hash order preserved (matcher relies on it)",
          bool(np.all(np.diff(sub.hashes.astype(np.int64)) >= 0)))
    check("empty slice is empty, not a crash",
          slice_fingerprint(fp, 200.0, 210.0).hashes.size == 0)


# ── self_ref: segment discovery ──────────────────────────────────────────────

def _episode_fp(op_at: float, seed: int, *, op_len: float = 90.0) -> Fingerprint:
    """An episode window: unique 'content' hashes + a shared 90 s 'theme'."""
    rng = np.random.default_rng(seed)
    content = [(int(h), float(t)) for h, t in
               zip(rng.integers(10_000, 90_000, 300), rng.uniform(0, 300, 300))]
    theme = [(2000 + i, op_at + i * (op_len / 180.0)) for i in range(180)]
    return _fp(content + theme)


def test_self_ref():
    print("self_ref")
    fps = {ep: (_episode_fp(90.0, seed=ep), 0.0) for ep in (2, 5, 8, 11)}
    seg = self_ref.find_segment("op", fps)
    check("repeated segment found", seg is not None)
    if seg:
        check("segment length plausible", 85.0 <= seg.length <= 95.0, f"{seg.length}")
        check("supported by the whole sample", seg.support >= self_ref.MIN_SUPPORT,
              f"support={seg.support}")
        ref = self_ref.build_reference(seg, fps)
        check("reference built without decoding", ref is not None
              and ref.fp.hashes.size > 0 and ref.slug == "SELF-OP")

    # Nothing shared → nothing found (episodes that share no theme).
    lone = {ep: (_fp([(int(h), float(t)) for h, t in
                      zip(np.random.default_rng(ep).integers(10_000, 90_000, 300),
                          np.random.default_rng(ep + 99).uniform(0, 300, 300))]), 0.0)
            for ep in (2, 5, 8, 11)}
    check("no repeat → no segment", self_ref.find_segment("op", lone) is None)

    # A segment that is too short (an eyecatch jingle) is rejected on length.
    short = {ep: (_episode_fp(90.0, seed=ep, op_len=8.0), 0.0) for ep in (2, 5, 8, 11)}
    seg_short = self_ref.find_segment("op", short)
    check("eyecatch-length repeat rejected", seg_short is None,
          f"{seg_short}")

    # The anti-recap guard: sampling is strided, so adjacent episodes (which is
    # where a recap repeats) are never compared.
    picked = self_ref.sample_episodes(list(range(1, 13)))
    check("sample is strided (anti-recap)",
          all(b - a >= self_ref.SAMPLE_STRIDE for a, b in zip(picked, picked[1:])),
          f"{picked}")
    check("sample skips episode 1 when it can", 1 not in picked, f"{picked}")


# ── serve gate ───────────────────────────────────────────────────────────────

def _reconciled(**kw) -> ReconciledHit:
    base = dict(kind="op", slug="OP1", start=90.0, end=180.0,
                canonical_duration=1440.0, from_end_start=None, from_end_end=None,
                votes=1000, n_hosts_agree=2, n_hosts_total=2, spread_s=0.3)
    base.update(kw)
    return ReconciledHit(**base)


def test_serve_gate():
    print("multi_host serve gate")
    check("two agreeing hosts serve", _reconciled().serve)
    check("blocking anomaly overrides host agreement",
          not _reconciled(anomalies=["implausible_length"]).serve)
    check("advisory anomaly does not block",
          _reconciled(anomalies=["relaxed_fill"]).serve)
    check("derived hit held until the season confirms",
          not _reconciled(derived=True).serve)
    check("inferred without image held",
          not _reconciled(inferred=True, n_video_confirm=0).serve)
    check("inferred with image served",
          _reconciled(inferred=True, n_video_confirm=1).serve)
    check("fabricated agreement (huge spread) held",
          not _reconciled(spread_s=87.0).serve)
    check("held_reason explains the hold",
          _reconciled(anomalies=["av_divergence"]).held_reason == "av_divergence")
    check("served hit has no held_reason", _reconciled().held_reason is None)

    # An estimated duration keeps the OP but must not poison the ED consensus.
    good = HostStream("sibnet", "u", 1440.0)
    est = HostStream("megaplay", "u2", 1440.0, duration_estimated=True)
    per_host = [
        (good, [hit(kind="ed", start=1300.0, end=1390.0)]),
        (est, [hit(kind="ed", start=1300.0, end=1390.0)]),
    ]
    out = reconcile_hits(per_host)
    check("estimated-duration host excluded from the ED consensus",
          out and out[0].n_hosts_total == 1, f"{out}")

    # Unanimous anomalies propagate; a lone host's do not.
    both = [
        (good, [hit(anomalies=["implausible_length"])]),
        (HostStream("sendvid", "u3", 1440.0), [hit(anomalies=["implausible_length"])]),
    ]
    check("unanimous anomaly reaches the consensus",
          "implausible_length" in reconcile_hits(both)[0].anomalies)
    one = [
        (good, [hit(anomalies=["implausible_length"])]),
        (HostStream("sendvid", "u3", 1440.0), [hit()]),
    ]
    check("single-host anomaly stays local",
          reconcile_hits(one)[0].anomalies == [])


# ── season pass ──────────────────────────────────────────────────────────────

def _entry(start: float, length: float = 90.0, **kw) -> dict:
    d = {"start": start, "end": start + length, "duration": 1440.0}
    d.update(kw)
    return d


def test_season_pass():
    print("season_pass")
    # A regular season: OP at ~90 s everywhere, one episode wildly off.
    rows = {ep: _entry(90.0 + (ep % 3) * 0.4) for ep in range(1, 13)}
    rows[7] = _entry(640.0)
    outliers, predicted, model = season_pass.analyse_group(rows, "op")
    check("mid-season outlier flagged", outliers == {7}, f"{outliers}")
    check("model recovered", model is not None and abs(model[0] - 90.0) < 2.0)

    # THE case that must not regress: ep1's OP is minutes in (long cold open),
    # every other episode has it near the start. ep1 must be left alone.
    late_first = {ep: _entry(65.0) for ep in range(1, 13)}
    late_first[1] = _entry(430.0)
    outliers, _pred, _m = season_pass.analyse_group(late_first, "op")
    check("late OP on episode 1 is NOT an outlier", outliers == set(), f"{outliers}")
    check("--strict-first can still surface it",
          season_pass.analyse_group(late_first, "op", strict_first=True)[0] == {1})

    # Same for the finale.
    odd_last = {ep: _entry(65.0) for ep in range(1, 13)}
    odd_last[12] = _entry(700.0)
    check("odd finale is not an outlier",
          season_pass.analyse_group(odd_last, "op")[0] == set())

    # Bimodal season (some episodes open cold, others start on the OP): BOTH
    # modes are legitimate, nothing should be flagged.
    bimodal = {}
    for ep in range(1, 13):
        bimodal[ep] = _entry(0.5 if ep % 2 else 92.0)
    check("bimodal OP placement flags nothing",
          season_pass.analyse_group(bimodal, "op")[0] == set(),
          f"{season_pass.analyse_group(bimodal, 'op')[0]}")

    # Length outlier: right position, wrong bounds.
    bad_len = {ep: _entry(90.0) for ep in range(1, 13)}
    bad_len[5] = _entry(90.0, length=140.0)
    check("length outlier flagged", season_pass.analyse_group(bad_len, "op")[0] == {5})

    # Prediction fills a hole in a tight season, but never episode 1 or the last.
    holes = {ep: _entry(90.0) for ep in range(1, 13)}
    holes[6] = None
    holes[1] = None
    holes[12] = None
    _o, predictable, _m = season_pass.analyse_group(holes, "op")
    check("hole in the middle is predictable", 6 in predictable, f"{predictable}")
    check("episode 1 is never predicted", 1 not in predictable)
    check("last episode is never predicted", 12 not in predictable)

    # A scattered season yields no verdict at all rather than a wrong one.
    scattered = {ep: _entry(50.0 * ep) for ep in range(1, 13)}
    o, p, m = season_pass.analyse_group(scattered, "op")
    check("scattered season stays silent", o == set() and p == {} and m is None)

    # End-to-end on rows, including the derived-hit promotion.
    jsonl = [
        {"mal_id": 1, "lang": "vostfr", "episode": ep,
         "per_host": {"sibnet": {"duration": 1440.0,
                                 "op": _entry(90.0, derived=True, serve=False)}}}
        for ep in range(1, 13)
    ]
    jsonl[6]["per_host"]["sibnet"]["op"] = _entry(700.0, derived=True, serve=False)
    out, stats = run_quiet(jsonl)
    check("derived hits promoted by a consistent season",
          out[0]["per_host"]["sibnet"]["op"]["serve"] is True)
    check("derived outlier stays held",
          out[6]["per_host"]["sibnet"]["op"]["serve"] is False
          and "season_outlier" in out[6]["per_host"]["sibnet"]["op"]["anomalies"])
    check("stats counted", stats["outliers"] == 1, f"{stats}")


def run_quiet(rows):
    return season_pass.run(rows, log=lambda *a, **k: None)


# ── detect_op_ed_v2 cascade (audio only, synthetic) ──────────────────────────

def _ref(kind: str, slug: str, seed: int, dur: float = 90.0) -> ThemeReference:
    """A synthetic theme reference: `dur` seconds of unique hashes."""
    rng = np.random.default_rng(seed)
    n = int(dur * 4)
    fp = _fp([(int(h), float(t)) for h, t in
              zip(rng.integers(100_000 + seed * 10_000, 100_000 + seed * 10_000 + 9_000, n),
                  np.linspace(0.0, dur, n))])
    return ThemeReference(kind=kind, slug=slug, version=1, song=None,
                          video_url="", fp=fp, duration=dur)


def _window_resolver(placements: dict[float, ThemeReference], noise_seed: int = 7):
    """resolve_audio_abs that returns a window containing themes at given times.

    `placements` = {absolute start of the theme: reference}. Only the part of a
    theme that falls inside the requested window is returned, which is what makes
    the widened-window fallbacks testable.
    """
    def resolve(start_abs: float, dur: float):
        pairs: list[tuple[int, float]] = []
        rng = np.random.default_rng(noise_seed)
        pairs += [(int(h), float(start_abs + t)) for h, t in
                  zip(rng.integers(1_000, 9_000, 400),
                      rng.uniform(0, max(dur, 1.0), 400))]
        for at, ref in placements.items():
            times = ref.fp.times * HOP_SECONDS + at
            for h, t in zip(ref.fp.hashes.tolist(), times.tolist()):
                if start_abs <= t <= start_abs + dur:
                    pairs.append((int(h), float(t)))
        # Times are absolute here; the detector adds abs_start itself, so hand
        # back window-relative times plus the realized abs_start.
        rel = [(h, t - start_abs) for h, t in pairs]
        return _fp(rel), start_abs
    return resolve


def test_v2_cascade():
    print("detect_op_ed_v2 cascade")
    op = _ref("op", "OP1", seed=1)
    ed = _ref("ed", "ED1", seed=2)
    dur = 1440.0

    hits = detect_op_ed_v2(dur, [op], [ed],
                           resolve_audio_abs=_window_resolver({120.0: op, 1300.0: ed}))
    got = {h.kind: h for h in hits}
    check("OP located in the fast window",
          "op" in got and abs(got["op"].start - 120.0) < 1.0,
          f"{[(h.kind, round(h.start, 1)) for h in hits]}")
    check("ED located in the tail",
          "ed" in got and abs(got["ed"].start - 1300.0) < 1.0)
    check("audio-only hit is flagged low-confidence",
          got["op"].source == "audio" and got["op"].low_confidence)
    check("no image resolver → align_status absent",
          got["op"].align_status == "absent")

    # F2 — an ED pushed out of the 4-minute tail by a long epilogue is only
    # reachable through the widened tail.
    late = detect_op_ed_v2(dur, [], [ed],
                           resolve_audio_abs=_window_resolver({1080.0: ed}))
    check("F2: ED beyond the 4-min tail recovered by the wide window",
          any(h.kind == "ed" and abs(h.start - 1080.0) < 1.0 for h in late),
          f"{[(h.kind, round(h.start, 1)) for h in late]}")

    # OP after a long cold open (past the 5-min fast window).
    late_op = detect_op_ed_v2(dur, [op], [],
                              resolve_audio_abs=_window_resolver({420.0: op}))
    check("OP past the fast window recovered by the wide window",
          any(h.kind == "op" and abs(h.start - 420.0) < 1.0 for h in late_op))

    # F3 — the mapped theme is absent; the series pool holds the real one.
    other = _ref("op", "OP2", seed=3)
    pooled = detect_op_ed_v2(dur, [op], [],
                             resolve_audio_abs=_window_resolver({100.0: other}),
                             op_pool_refs=[op, other])
    check("F3: pool recovers an off-by-one mapping",
          any(h.kind == "op" and h.slug == "OP2" for h in pooled),
          f"{[(h.kind, h.slug) for h in pooled]}")
    check("F3: pool hit is stamped inferred",
          all(h.inferred for h in pooled if h.slug == "OP2"))

    # Nothing there → nothing invented.
    empty = detect_op_ed_v2(dur, [op], [ed], resolve_audio_abs=_window_resolver({}))
    check("absent theme yields no hit", empty == [], f"{empty}")

    # Anomalies are attached by the detector itself.
    long_ref = _ref("op", "OP1", seed=4, dur=260.0)
    weird = detect_op_ed_v2(dur, [long_ref], [],
                            resolve_audio_abs=_window_resolver({100.0: long_ref}))
    check("full-version reference flagged at detection time",
          weird and "implausible_length" in weird[0].anomalies,
          f"{weird[0].anomalies if weird else None}")


if __name__ == "__main__":
    test_validate()
    test_rival_peak()
    test_slice()
    test_self_ref()
    test_serve_gate()
    test_season_pass()
    test_v2_cascade()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("all guard tests passed")
