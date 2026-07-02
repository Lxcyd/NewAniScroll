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

from oped.adapter_aniscroll import resolve_episodes
from oped.animethemes import Theme, fetch_themes, resolve_slug, themes_for_episode
from oped.audio import load_audio
from oped.fingerprint import fingerprint
from oped.manifest import Manifest, Record
from oped.theme_bank import (
    ED_WINDOW,
    OP_WINDOW,
    ThemeReference,
    build_references,
    detect_op_ed,
)
from oped.throttle import HostThrottler, is_throttle_error


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


def build_theme_index(at_slug: str) -> tuple[list[Theme], dict[str, list[ThemeReference]]]:
    """Fetch themes + fingerprint every version once (cached). Returns
    (themes, refs_by_theme_slug). Empty refs => nothing to detect against."""
    themes = fetch_themes(at_slug)
    refs_by_theme: dict[str, list[ThemeReference]] = {}
    for t in themes:
        rs = build_references(t, slug_prefix=f"animethemes/{at_slug}")
        if rs:
            refs_by_theme[t.slug] = rs
    return themes, refs_by_theme


def process_anime(
    anime: dict,
    throttler: HostThrottler,
    sink: ResultSink,
) -> Record:
    """Resolve + detect one anime across all its seasons. Raises on transient
    failure (so the caller can requeue); returns a Record on a clean outcome."""
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
        eps = resolve_episodes(
            anime["slug"], season["season_dir"], season["lang"],
            season["ep_start"], season["ep_end"],
        )
        for e in eps:
            ep = e["ep"]
            url = e["url"]
            base_key = f"{anime['slug']}/{season['season_dir']}/{season['lang']}/ep{ep}"

            picked = themes_for_episode(themes, ep)
            op_refs = refs_by_theme.get(picked["op"].slug, []) if picked["op"] else []
            ed_refs = refs_by_theme.get(picked["ed"].slug, []) if picked["ed"] else []
            inf_op = inf_ed = False
            if not op_refs and op_pool:
                op_refs, inf_op = op_pool, True      # cour fallback
            if not ed_refs and ed_pool:
                ed_refs, inf_ed = ed_pool, True

            # 4. ADAPTIVE CONCURRENCY: the network-heavy work (probe + windowed
            #    fetches) runs under the host's AIMD slot.
            with throttler.slot(url) as slot:
                ep_dur = _probe_duration(url)

                def resolve_window(win):
                    samples = load_audio(url, cache_key=base_key, window=win)
                    return fingerprint(samples)

                try:
                    hits = detect_op_ed(
                        resolve_window, ep_dur, op_refs, ed_refs,
                        op_window=OP_WINDOW, ed_window=ED_WINDOW,
                    )
                except Exception as exc:
                    if is_throttle_error(exc):
                        slot.throttled()
                    raise

            row = {"mal_id": mal_id, "episode": ep, "op": None, "ed": None}
            for h in hits:
                inferred = (h.kind == "op" and inf_op) or (h.kind == "ed" and inf_ed)
                row[h.kind] = {
                    "start": round(h.start, 2), "end": round(h.end, 2),
                    "theme": h.slug, "version": h.version,
                    "votes": h.votes, "inferred": inferred,
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
            rec = process_anime(a, throttler, sink)
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
    )


if __name__ == "__main__":
    main()
