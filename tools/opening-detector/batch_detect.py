"""Scalable offline OP/ED batch — designed for ~2000 anime.

Speedups that make 2000 anime feasible (see README):
  1. WINDOWED decode: only the OP (first ~4 min) + ED (last ~3 min) of each
     episode is fetched via ffmpeg seek — never the whole 24 min.
  2. PRE-FILTER: skip anime with no AnimeThemes theme/video BEFORE touching any
     stream (one cached API call). On 2000 anime this removes a big slice of
     the heavy network work for free.
  3. RESUME: a crash-safe manifest skips anime already done on a re-run — no
     re-download.
  4. ADAPTIVE CONCURRENCY: an AIMD limiter per stream host self-tunes to the
     largest parallelism Sibnet tolerates (grows on success, halves on 429/
     timeout), maximizing throughput without tripping bans.
  5. REQUEUE: transient failures are retried once at the end of the run.
  6. SHARED CACHES: reference-theme fingerprints, episode PCM windows, and
     resolved stream URLs are all cached and reused across the whole run.

This is an OFFLINE tool — it never touches the app's Redis/Turso. Output is a
JSONL of {mal_id, episode, op, ed, ...} that a separate importer loads into the
DB for the /skip API to serve.

INPUT (--anime-list points at a JSON file): a list of anime the app already
knows how to resolve (the app has the MAL id ↔ anime-sama slug ↔ season mapping
via its season resolver; this tool does not re-derive it):

    [
      {
        "mal_id": 16498,
        "slug": "shingeki-no-kyojin",
        "seasons": [
          {"season_dir": "saison1", "lang": "vostfr", "ep_start": 1, "ep_end": 25}
        ]
      },
      ...
    ]

Run:
    python batch_detect.py --anime-list anime.json --out results.jsonl
    python batch_detect.py --anime-list anime.json --out results.jsonl --resume
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.adapter_aniscroll import resolve_episodes, resolve_episodes_multi
from oped.animethemes import Theme, fetch_themes, resolve_slug, themes_for_episode
from oped.audio import decode_audio_abs, load_audio
from oped.fingerprint import Fingerprint, fingerprint
from oped.manifest import Manifest, Record
from oped.multi_host import HostStream, detect_per_host, reconcile_hits
from detect_anime import _hit_to_dict, _probe_duration
from oped.theme_bank import (
    ED_WINDOW,
    OP_WINDOW,
    ThemeReference,
    build_references,
    detect_op_ed,
)
from oped.throttle import HostThrottler, is_throttle_error
from oped.timings import TimingCollector
from oped.video_fingerprint import extract_keyframe_hashes, keyframe_hashes_abs


# ── result sink ──────────────────────────────────────────────────────────────


class ResultSink:
    """Thread-safe JSONL writer for per-episode results."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._fh = self.path.open("a", encoding="utf-8")

    def write(self, row: dict) -> None:
        with self._lock:
            self._fh.write(json.dumps(row) + "\n")
            self._fh.flush()

    def close(self) -> None:
        self._fh.close()


# ── per-anime work ─────────────────────────────────────────────────────────


def _cached_audio_abs(cache_key, url, start_abs, dur, *, referer=None,
                      cache_dir="cache/audio"):
    """Decode+fingerprint an ABSOLUTE audio window, cached on disk so a re-run's
    v2 LOCATE is skipped. Returns (Fingerprint, abs_start). Ported verbatim from
    detect_anime.py so the batch's v2 path caches identically (same absa/ keys),
    letting a resumed backfill reuse windows a single-anime debug run produced."""
    safe = cache_key.replace("/", "__").replace("\\", "__")
    s_tag = f"{round(start_abs, 1)}"
    d_tag = "" if dur is None else f"{round(dur, 1)}"
    stem = f"{safe}.abs{s_tag}_{d_tag}"
    fp_file = Path(cache_dir) / f"{stem}.fp.npz"
    off_file = Path(cache_dir) / f"{stem}.abs.txt"
    if fp_file.exists() and off_file.exists():
        return Fingerprint.load(fp_file), float(off_file.read_text())
    samples, abs_start = decode_audio_abs(url, start_abs, dur, referer=referer)
    fp = fingerprint(samples)
    if samples.size:
        Path(cache_dir).mkdir(parents=True, exist_ok=True)
        fp.save(fp_file)
        off_file.write_text(str(abs_start))
    return fp, abs_start


def build_theme_index(
    at_slug: str, *, with_video: bool = True
) -> tuple[list[Theme], dict[str, list[ThemeReference]]]:
    """Fetch themes + fingerprint every version once (cached). Returns
    (themes, refs_by_theme_slug). Empty refs => nothing to detect against.

    `with_video` (default on): also fingerprint each clean NC clip's keyframes,
    so detection can EXTEND cropped fade edges and fall back to a video-sourced
    alignment when audio is too weak — the image is a first-class signal now,
    not an optional extra."""
    themes = fetch_themes(at_slug)
    refs_by_theme: dict[str, list[ThemeReference]] = {}
    for t in themes:
        rs = build_references(t, slug_prefix=f"animethemes/{at_slug}", with_video=with_video)
        if rs:
            refs_by_theme[t.slug] = rs
    return themes, refs_by_theme


def process_anime(
    anime: dict,
    throttler: HostThrottler,
    sink: ResultSink,
    *,
    multi_host: bool = False,
    timings: TimingCollector | None = None,
) -> Record:
    """Resolve + detect one anime across all its seasons. Raises on transient
    failure (so the caller can requeue); returns a Record on a clean outcome.

    `multi_host`: resolve each episode from every audio-capable host and
    reconcile the OP/ED across them (see oped.multi_host). Robust to per-player
    duration differences — the emitted rows then also carry `from_end` anchors
    and a cross-host agreement count. Costs more network (N hosts per episode)
    so it's opt-in."""
    mal_id = anime.get("mal_id")
    key = f"mal:{mal_id}" if mal_id else f"slug:{anime.get('slug')}"
    tc = timings or TimingCollector.disabled()

    # 2. PRE-FILTER: resolve to AnimeThemes and check there is anything to do
    #    BEFORE touching any stream. Cached, so cheap on re-runs.
    with tc.span("themes"):
        at_slug = resolve_slug(mal_id=mal_id) if mal_id else resolve_slug(slug=anime.get("at_slug"))
        if not at_slug:
            return Record(key, "skipped", reason="no AnimeThemes entry")
        themes, refs_by_theme = build_theme_index(at_slug)
    if not refs_by_theme:
        return Record(key, "skipped", reason="no themes/videos on AnimeThemes")

    op_pool = [r for rs in refs_by_theme.values() for r in rs if r.kind == "op"]
    ed_pool = [r for rs in refs_by_theme.values() for r in rs if r.kind == "ed"]

    written = 0
    for season in anime.get("seasons", []):
        base_prefix = f"{anime['slug']}/{season['season_dir']}/{season['lang']}"

        # Which OP/ED refs apply to an episode (with cour fallback for holes).
        def refs_for(ep: int) -> tuple[list, list, bool, bool]:
            picked = themes_for_episode(themes, ep)
            op = refs_by_theme.get(picked["op"].slug, []) if picked["op"] else []
            ed = refs_by_theme.get(picked["ed"].slug, []) if picked["ed"] else []
            inf_op = inf_ed = False
            if not op and op_pool:
                op, inf_op = op_pool, True
            if not ed and ed_pool:
                ed, inf_ed = ed_pool, True
            return op, ed, inf_op, inf_ed

        if multi_host:
            # Resolve every episode from all hosts up front, grouped by episode.
            # Pass mal_id (megaplay needs it — resolved from a MAL id, not a slug)
            # and va_slug (vidmoly-va needs the voir-anime slug). Without them both
            # hosts are cleanly filtered out, so a run silently loses two encodes
            # from the cross-host consensus. va_slug comes from the anime entry
            # (the DB export owns the mapping); falls back to the anime-sama slug
            # when voir-anime happens to use the same one.
            va_slug = anime.get("va_slug") or anime.get("slug")
            with tc.span("resolve"):
                by_ep = resolve_episodes_multi(
                    anime["slug"], season["season_dir"], season["lang"],
                    season["ep_start"], season["ep_end"],
                    mal_id=mal_id, va_slug=va_slug,
                )
            for ep in sorted(by_ep):
                op_refs, ed_refs, inf_op, inf_ed = refs_for(ep)

                # Probe each host's duration under its own throttle slot, then
                # match. Different hosts = different encode lengths — exactly the
                # per-player duration variance the reconciler absorbs.
                #
                # Probes run IN PARALLEL across hosts: each is an independent
                # ffprobe round-trip against a DIFFERENT CDN under its OWN throttle
                # slot, so serialising them stalled every episode on ~5 sequential
                # header reads before detection could even start. One thread per
                # host (same pattern as detect_anime.py's `_probe_one`); the
                # per-host AIMD slot still bounds concurrency to what each CDN
                # tolerates, so this adds no extra load to any single host.
                def _probe_one(e: dict) -> "HostStream | None":
                    host = e.get("host", "?")
                    referer = e.get("referer")
                    with throttler.slot(e["url"]) as slot:
                        try:
                            with tc.span("probe", host=host):
                                dur = _probe_duration(e["url"], referer=referer)
                        except Exception as exc:
                            if is_throttle_error(exc):
                                slot.throttled()
                            return None
                    return HostStream(host=host, url=e["url"], duration=dur,
                                      referer=referer)

                entries = by_ep[ep]
                streams: list[HostStream] = []
                with ThreadPoolExecutor(max_workers=max(1, len(entries))) as ppool:
                    for s in ppool.map(_probe_one, entries):
                        if s is not None:
                            streams.append(s)
                if not streams:
                    continue

                def resolve_window_for(stream: HostStream, win):
                    samples = load_audio(
                        stream.url,
                        cache_key=f"{base_prefix}/ep{ep}/{stream.host}",
                        window=win, referer=stream.referer,
                    )
                    return fingerprint(samples)

                def resolve_samples_for(stream: HostStream, win):
                    # Same (key, window) as the fingerprint above → load_audio
                    # cache hit, no second decode. Feeds RMS edge-refinement.
                    return load_audio(
                        stream.url,
                        cache_key=f"{base_prefix}/ep{ep}/{stream.host}",
                        window=win, referer=stream.referer,
                    )

                def resolve_video_for(stream: HostStream, win):
                    return extract_keyframe_hashes(
                        stream.url,
                        cache_key=f"video/{base_prefix}/ep{ep}/{stream.host}",
                        cache_dir="cache/video",
                        window=win, referer=stream.referer,
                    )

                def resolve_video_dense_for(stream: HostStream, win, fps):
                    # Dense edge decode per host; fps in the cache key keeps it
                    # distinct from the 2fps windows for the same stream.
                    return extract_keyframe_hashes(
                        stream.url,
                        cache_key=f"video/{base_prefix}/ep{ep}/{stream.host}",
                        cache_dir="cache/video",
                        window=win, fps=fps, referer=stream.referer,
                    )

                # v2 ABSOLUTE-timeline resolvers (shared clock) — the default now.
                # decode_audio_abs / keyframe_hashes_abs use -copyts + absolute -ss
                # so audio and native video carry the same absolute pts and the
                # image landmark anchor owns the boundary; no -sseof, no dense
                # cascade. Same absa/absv cache keys as detect_anime.py.
                def resolve_audio_abs_for(stream: HostStream, start_abs, dur):
                    return _cached_audio_abs(
                        f"absa/{base_prefix}/ep{ep}/{stream.host}",
                        stream.url, start_abs, dur,
                        referer=stream.referer,
                    )

                def resolve_video_abs_for(stream: HostStream, start_abs, dur, fps):
                    return keyframe_hashes_abs(
                        stream.url, start_abs, dur, fps=fps,
                        referer=stream.referer,
                        cache_key=f"absv/{base_prefix}/ep{ep}/{stream.host}",
                        cache_dir="cache/video",
                    )

                try:
                    with tc.span("detect"):
                        # Detect each host ON ITS OWN encode, then reconcile. The
                        # per-host hits are what a player actually needs at runtime
                        # (each host serves a differently-trimmed stream, so the
                        # averaged consensus lands on NO real host — e.g. cyberpunk
                        # OP consensus 1:13 while sibnet is 1:16, vidmoly 1:10). The
                        # consensus stays as the cross-host confidence check only.
                        per_host = detect_per_host(
                            streams, resolve_window_for, op_refs, ed_refs,
                            resolve_samples_for=resolve_samples_for,
                            resolve_video_for=resolve_video_for,
                            resolve_video_dense_for=resolve_video_dense_for,
                            resolve_audio_abs_for=resolve_audio_abs_for,
                            resolve_video_abs_for=resolve_video_abs_for,
                            v2=True,
                            op_window=OP_WINDOW, ed_window=ED_WINDOW,
                        )
                        hits = reconcile_hits(
                            per_host, inferred_op=inf_op, inferred_ed=inf_ed
                        )
                except Exception as exc:
                    if is_throttle_error(exc):
                        # Charge the slowest/first host with the throttle signal.
                        with throttler.slot(streams[0].url) as slot:
                            slot.throttled()
                    raise

                row = {
                    "mal_id": mal_id, "episode": ep, "lang": season["lang"],
                    "op": None, "ed": None,
                }
                for h in hits:
                    inferred = (h.kind == "op" and inf_op) or (h.kind == "ed" and inf_ed)
                    row[h.kind] = {
                        "start": round(h.start, 2), "end": round(h.end, 2),
                        "theme": h.slug,
                        "votes": h.votes, "inferred": inferred or h.inferred,
                        # Cross-host robustness metadata: the duration the times
                        # are expressed against, the host-independent from-end
                        # anchor (for re-projection onto the player's real
                        # duration), and how many hosts agreed.
                        "canonical_duration": h.canonical_duration,
                        "from_end_start": h.from_end_start,
                        "from_end_end": h.from_end_end,
                        "hosts_agree": h.n_hosts_agree,
                        "hosts_total": h.n_hosts_total,
                        "spread": h.spread_s,
                        # Signal provenance + serve gate for the importer/API:
                        # "audio"|"video"|"mixed" alignment, how many hosts had
                        # video confirming, and whether it clears the precision-
                        # first serve floor (≥2 agree, or 1 + video confirm).
                        "source": h.source,
                        "n_video_confirm": h.n_video_confirm,
                        "serve": h.serve,
                    }
                # Per-host delivery: each host's OWN op/ed timing against its OWN
                # duration, keyed by host. This is the authoritative timing for a
                # player; `op`/`ed` above are the averaged consensus (cross-check).
                # Reuses detect_anime._hit_to_dict (handles ED from_end re-projection).
                #
                # `inferred` is stamped HERE, not by detect_op_ed_v2: refs_for()
                # owns the knowledge that a theme was borrowed from the cour pool
                # (same reason reconcile_hits takes it as an argument). Without it
                # the per-host dicts carry inferred=false and INFERRED_REQUIRES_VIDEO
                # never bites on the path a player actually consumes — a borrowed ED
                # matching only the song's reprise ships as a real timing.
                def _host_entry(stream, host_hits: list) -> dict:
                    out = {"duration": round(stream.duration, 2)}
                    for h in host_hits:
                        inferred = inf_op if h.kind == "op" else inf_ed
                        d = _hit_to_dict(h, stream.duration)
                        d["inferred"] = d.get("inferred", False) or inferred
                        # Same precision-first rule as ReconciledHit.serve, applied
                        # per host: a borrowed theme is only real here if THIS host's
                        # image backs it. Audio alone can't tell the ED sequence from
                        # the ED song playing over ordinary end credits.
                        if (d["inferred"]
                                and not h.confirmed_by_video
                                and h.source not in ("credited", "video")):
                            d["serve"] = False
                            d["held_reason"] = "inferred theme, no image confirmation"
                        out[h.kind] = d
                    return out

                row["per_host"] = {
                    stream.host: _host_entry(stream, host_hits)
                    for stream, host_hits in per_host
                }
                sink.write(row)
                written += 1
            continue

        # ── single-host path (default) ──────────────────────────────────────
        with tc.span("resolve"):
            eps = resolve_episodes(
                anime["slug"], season["season_dir"], season["lang"],
                season["ep_start"], season["ep_end"],
            )
        for e in eps:
            ep = e["ep"]
            url = e["url"]
            base_key = f"{base_prefix}/ep{ep}"

            op_refs, ed_refs, inf_op, inf_ed = refs_for(ep)

            # 4. ADAPTIVE CONCURRENCY: the network-heavy work (probe + windowed
            #    fetches) runs under the host's AIMD slot.
            host = e.get("host", "?")
            with throttler.slot(url) as slot:
                with tc.span("probe", host=host):
                    ep_dur = _probe_duration(url)

                def resolve_window(win):
                    samples = load_audio(url, cache_key=base_key, window=win)
                    return fingerprint(samples)

                def resolve_samples(win):
                    return load_audio(url, cache_key=base_key, window=win)

                def resolve_video(win):
                    return extract_keyframe_hashes(
                        url, cache_key=f"video/{base_key}",
                        cache_dir="cache/video", window=win,
                    )

                def resolve_video_dense(win, fps):
                    # Dense (high-fps) episode decode over a TIGHT edge window for
                    # sub-second refinement. fps is in the cache key (see
                    # extract_keyframe_hashes) so it never aliases the 2fps cache.
                    return extract_keyframe_hashes(
                        url, cache_key=f"video/{base_key}",
                        cache_dir="cache/video", window=win, fps=fps,
                    )

                try:
                    with tc.span("detect", host=host):
                        hits = detect_op_ed(
                            resolve_window, ep_dur, op_refs, ed_refs,
                            resolve_samples=resolve_samples,
                            resolve_video=resolve_video,
                            resolve_video_dense=resolve_video_dense,
                            op_window=OP_WINDOW, ed_window=ED_WINDOW,
                        )
                except Exception as exc:
                    if is_throttle_error(exc):
                        slot.throttled()
                    raise

            row = {
                "mal_id": mal_id, "episode": ep, "lang": season["lang"],
                "op": None, "ed": None,
            }
            for h in hits:
                inferred = (h.kind == "op" and inf_op) or (h.kind == "ed" and inf_ed)
                row[h.kind] = {
                    "start": round(h.start, 2), "end": round(h.end, 2),
                    "theme": h.slug, "version": h.version,
                    "votes": h.votes, "inferred": inferred,
                    # Single-host: no cross-host agreement, so serve is decided by
                    # the video confirmation flag alone (audio+video agreed).
                    "source": h.source,
                    "confirmed_by_video": h.confirmed_by_video,
                    "edge_start_source": h.edge_start_source,
                    "edge_end_source": h.edge_end_source,
                }
            sink.write(row)
            written += 1

    return Record(key, "done", episodes=written)


# ── orchestration ──────────────────────────────────────────────────────────


def run(
    anime_list: list[dict],
    out_path: str,
    *,
    manifest_path: str,
    workers: int,
    start_conc: int,
    max_per_host: int,
    resume: bool,
    multi_host: bool = False,
    timings: bool = False,
) -> None:
    manifest = Manifest(manifest_path)
    sink = ResultSink(out_path)
    throttler = HostThrottler(start=start_conc, max_per_host=max_per_host)
    tc = TimingCollector(enabled=timings)
    t_run0 = time.monotonic()

    def key_of(a: dict) -> str:
        return f"mal:{a['mal_id']}" if a.get("mal_id") else f"slug:{a.get('slug')}"

    todo = anime_list
    if resume:
        before = len(todo)
        todo = [a for a in todo if not manifest.is_done(key_of(a))]
        print(f"resume: {before - len(todo)} already done/skipped, {len(todo)} to do")

    def worker(a: dict) -> tuple[str, str]:
        key = key_of(a)
        try:
            rec = process_anime(a, throttler, sink, multi_host=multi_host, timings=tc)
        except Exception as exc:  # transient -> failed, requeued at end
            rec = Record(key, "failed", reason=f"{type(exc).__name__}: {exc}")
        manifest.record(rec)
        return key, rec.status

    def drain(items: list[dict], label: str) -> None:
        done = 0
        t0 = time.monotonic()
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(worker, a): key_of(a) for a in items}
            for fut in as_completed(futs):
                key, status = fut.result()
                done += 1
                if done % 10 == 0 or status == "failed":
                    rate = done / max(time.monotonic() - t0, 1e-6)
                    print(f"[{label}] {done}/{len(items)} "
                          f"({rate:.1f}/s) last={key}:{status} "
                          f"hosts={throttler.stats()}")

    drain(todo, "main")

    # 5. REQUEUE: one retry pass over transient failures.
    failed = [a for a in anime_list if key_of(a) in set(manifest.failed_keys())]
    if failed:
        print(f"\nrequeue: retrying {len(failed)} failed anime once…")
        drain(failed, "retry")

    sink.close()
    print("\nsummary:", manifest.summary())
    still = manifest.failed_keys()
    if still:
        print(f"still failed after retry ({len(still)}):",
              ", ".join(still[:20]), "…" if len(still) > 20 else "")

    if tc.enabled:
        print(tc.report())
        _print_eta(tc, anime_list, manifest, wall_s=time.monotonic() - t_run0)


# The full verified DB, measured 2026-07-15 from player_map (see
# export-oped-anime-list.mjs): 33 719 episode-lang panels to backfill. Used only
# to extrapolate a bench run's throughput to the whole backfill.
FULL_DB_EPISODE_LANGS = 33_719


def _print_eta(tc: TimingCollector, anime_list: list[dict], manifest: Manifest,
               *, wall_s: float) -> None:
    """Extrapolate this (bench) run's throughput to the full 33.7k-episode-lang
    backfill. Deliberately conservative: it measures REAL episode-langs actually
    detected this run (the `detect` phase count) and the observed skip rate, then
    scales wall time linearly. Prints a plain ETA plus the two levers that move
    it (skip rate, per-episode wall)."""
    detect = tc._phases.get("detect")
    n_detected = detect.n if detect else 0
    # Episode-langs represented by this run's input (what we TRIED to cover).
    sample_eps = sum(
        s["ep_end"] - s["ep_start"] + 1
        for a in anime_list for s in a.get("seasons", [])
    )
    summ = manifest.summary()
    n_skipped = summ.get("skipped", 0)
    n_anime = len(anime_list)

    print("\n=== BACKFILL ETA (extrapolated from this run) ===")
    print(f"  sample: {n_anime} anime, {sample_eps} episode-lang input, "
          f"{n_detected} actually detected, {n_skipped} anime skipped (no AnimeThemes)")
    if n_detected == 0 or wall_s <= 0:
        print("  (no episodes detected — cannot extrapolate)")
        return
    per_ep = wall_s / n_detected
    skip_frac = (n_skipped / n_anime) if n_anime else 0.0
    # The full DB has the same skip rate roughly, so effective episode-langs to
    # decode ≈ total * (1 - skip_frac). This is the number that actually costs.
    eff_full = FULL_DB_EPISODE_LANGS * (1 - skip_frac)
    eta_s = eff_full * per_ep
    print(f"  throughput: {per_ep:.1f} s / episode-lang (wall, incl. concurrency)")
    print(f"  skip rate: {skip_frac*100:.0f}% of anime have no AnimeThemes data")
    print(f"  → full backfill of ~{FULL_DB_EPISODE_LANGS} episode-langs "
          f"(~{eff_full:.0f} effective): {eta_s/3600:.1f} h "
          f"= {eta_s/3600/24:.1f} days of wall time")
    print("  NB: linear extrapolation. Real backfill is CDN-throughput-bound; a "
          "larger run lets the AIMD limiter settle, which usually IMPROVES per-ep.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Batch OP/ED detector (AnimeThemes-anchored)")
    ap.add_argument("--anime-list", required=True, help="JSON file: list of anime entries")
    ap.add_argument("--out", default="results.jsonl", help="JSONL output path")
    ap.add_argument("--manifest", default="cache/batch-manifest.jsonl")
    ap.add_argument("--workers", type=int, default=16, help="global worker threads")
    ap.add_argument("--start-conc", type=int, default=6, help="initial per-host concurrency")
    ap.add_argument("--max-per-host", type=int, default=24)
    ap.add_argument("--resume", action="store_true", help="skip anime already done")
    # Multi-host is the default now (precision-first): it's what lets a video
    # signal on one host confirm/rescue the audio on another and yields the
    # cross-host `serve` gate the API relies on. --no-multi-host opts back to the
    # cheaper single-host path (no reconciliation, no serve gate).
    ap.add_argument(
        "--multi-host", dest="multi_host", action="store_true", default=True,
        help="(default) resolve each episode from every audio-capable host and "
             "reconcile OP/ED across them — robust to per-player duration "
             "differences; emits from_end anchors + cross-host agreement + serve.",
    )
    ap.add_argument(
        "--no-multi-host", dest="multi_host", action="store_false",
        help="single-host path only (cheaper, but no cross-host serve gate).",
    )
    ap.add_argument(
        "--timings", action="store_true",
        help="measure wall-clock per phase (resolve/probe/detect) and per host, "
             "then print a table + a backfill ETA extrapolated to the full DB. "
             "Use on a small --anime-list to size the full backfill before "
             "committing to it. Negligible overhead; off by default.",
    )
    args = ap.parse_args()

    anime_list = json.loads(Path(args.anime_list).read_text("utf-8"))
    print(f"loaded {len(anime_list)} anime from {args.anime_list}")
    run(
        anime_list, args.out,
        manifest_path=args.manifest,
        workers=args.workers,
        start_conc=args.start_conc,
        max_per_host=args.max_per_host,
        resume=args.resume,
        multi_host=args.multi_host,
        timings=args.timings,
    )


if __name__ == "__main__":
    main()
