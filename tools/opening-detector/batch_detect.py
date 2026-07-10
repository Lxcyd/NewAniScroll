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
from oped.audio import load_audio
from oped.fingerprint import fingerprint
from oped.manifest import Manifest, Record
from oped.multi_host import HostStream, detect_op_ed_multi
from oped.theme_bank import (
    ED_WINDOW,
    OP_WINDOW,
    ThemeReference,
    build_references,
    detect_op_ed,
)
from oped.throttle import HostThrottler, is_throttle_error
from oped.video_fingerprint import extract_keyframe_hashes


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


def _probe_duration(url: str) -> float:
    import subprocess
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", url,
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception:
        return 24 * 60.0


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

    # 2. PRE-FILTER: resolve to AnimeThemes and check there is anything to do
    #    BEFORE touching any stream. Cached, so cheap on re-runs.
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
            by_ep = resolve_episodes_multi(
                anime["slug"], season["season_dir"], season["lang"],
                season["ep_start"], season["ep_end"],
            )
            for ep in sorted(by_ep):
                op_refs, ed_refs, inf_op, inf_ed = refs_for(ep)

                # Probe each host's duration under its own throttle slot, then
                # match. Different hosts = different encode lengths — exactly the
                # per-player duration variance the reconciler absorbs.
                streams: list[HostStream] = []
                for e in by_ep[ep]:
                    with throttler.slot(e["url"]) as slot:
                        try:
                            dur = _probe_duration(e["url"])
                        except Exception as exc:
                            if is_throttle_error(exc):
                                slot.throttled()
                            continue
                    streams.append(
                        HostStream(host=e.get("host", "?"), url=e["url"], duration=dur)
                    )
                if not streams:
                    continue

                def resolve_window_for(stream: HostStream, win):
                    samples = load_audio(
                        stream.url,
                        cache_key=f"{base_prefix}/ep{ep}/{stream.host}",
                        window=win,
                    )
                    return fingerprint(samples)

                def resolve_samples_for(stream: HostStream, win):
                    # Same (key, window) as the fingerprint above → load_audio
                    # cache hit, no second decode. Feeds RMS edge-refinement.
                    return load_audio(
                        stream.url,
                        cache_key=f"{base_prefix}/ep{ep}/{stream.host}",
                        window=win,
                    )

                def resolve_video_for(stream: HostStream, win):
                    return extract_keyframe_hashes(
                        stream.url,
                        cache_key=f"video/{base_prefix}/ep{ep}/{stream.host}",
                        cache_dir="cache/video",
                        window=win,
                    )

                def resolve_video_dense_for(stream: HostStream, win, fps):
                    # Dense edge decode per host; fps in the cache key keeps it
                    # distinct from the 2fps windows for the same stream.
                    return extract_keyframe_hashes(
                        stream.url,
                        cache_key=f"video/{base_prefix}/ep{ep}/{stream.host}",
                        cache_dir="cache/video",
                        window=win, fps=fps,
                    )

                try:
                    hits = detect_op_ed_multi(
                        streams, resolve_window_for, op_refs, ed_refs,
                        resolve_samples_for=resolve_samples_for,
                        resolve_video_for=resolve_video_for,
                        resolve_video_dense_for=resolve_video_dense_for,
                        op_window=OP_WINDOW, ed_window=ED_WINDOW,
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
                sink.write(row)
                written += 1
            continue

        # ── single-host path (default) ──────────────────────────────────────
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
            with throttler.slot(url) as slot:
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
) -> None:
    manifest = Manifest(manifest_path)
    sink = ResultSink(out_path)
    throttler = HostThrottler(start=start_conc, max_per_host=max_per_host)

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
            rec = process_anime(a, throttler, sink, multi_host=multi_host)
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
    )


if __name__ == "__main__":
    main()
