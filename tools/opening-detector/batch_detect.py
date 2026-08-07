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
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.adapter_aniscroll import (
    MULTI_HOSTS,
    VF_INCOMPATIBLE_HOSTS,
    resolve_episodes,
    resolve_episodes_multi,
)
from oped.animethemes import Theme, fetch_themes, resolve_slug, themes_for_episode
from oped.host_registry import version_of
from oped.audio import decode_audio_abs, load_audio
from oped.fingerprint import Fingerprint, fingerprint
from oped.manifest import Manifest, Record
from oped.multi_host import HostStream, detect_per_host, reconcile_hits
from detect_anime import ProbeError, _hit_to_dict, _probe_duration
from oped.theme_bank import (
    ED_SEARCH_FROM_END,
    ED_WINDOW,
    OP_SEARCH,
    OP_WINDOW,
    ThemeReference,
    build_references,
    detect_op_ed,
)
from oped import multipart, self_ref, theme_bank
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


# Episodes of slack around the requested range when deciding which themes are
# worth fingerprinting. F3's whole job is to rescue an OFF-BY-ONE mapping from
# the cour-wide pool, so the pool must keep its immediate neighbours — but a
# theme mapped to episodes 13-24 can never rescue episode 3.
_THEME_RANGE_MARGIN = 3


def season_episodes(season: dict) -> list[int]:
    """The episodes a season panel asks for.

    Two forms are accepted. `ep_start`/`ep_end` is the original contiguous
    range and stays the default. `episodes: [1, 2, 3, 24]` is an explicit,
    possibly SPARSE list, added so a lot can sample the premiere AND the finale
    without paying for everything in between — the two episodes least like the
    rest of a season (a premiere may run double length or hold the OP until
    after a cold open; a finale often drops the ED, replaces it with the OP, or
    runs credits over the last scene).
    """
    explicit = season.get("episodes")
    if explicit:
        return sorted({int(e) for e in explicit if int(e) > 0})
    return list(range(int(season.get("ep_start") or 1),
                      int(season.get("ep_end") or 1) + 1))


def _kind_absent_by_design(themes, kind: str, ep: int):
    """Does AnimeThemes say this episode carries NO theme of this kind?

    True  — the source maps every theme of that kind away from this episode, so
            an empty result is correct and must not read as a failure.
    False — a theme covers it; an empty result IS a miss worth investigating.
    None  — no reference at all (no AnimeThemes entry, or none of that kind):
            undecidable, and deliberately not guessed either way.
    """
    if not themes:
        return None
    want = kind.upper()
    saw_kind = False
    for t in themes:
        if not str(getattr(t, "slug", "")).upper().startswith(want):
            continue
        saw_kind = True
        for e in t.entries:
            # An entry with no episode mapping applies to the whole season.
            if not getattr(e, "episodes_spec", None):
                return False
            if e.covers(ep):
                return False
    return True if saw_kind else None


def contiguous_runs(eps: list[int]) -> list[tuple[int, int]]:
    """[1,2,3,24] -> [(1,3), (24,24)] — the resolver speaks ranges only."""
    runs: list[tuple[int, int]] = []
    for ep in sorted(eps):
        if runs and ep == runs[-1][1] + 1:
            runs[-1] = (runs[-1][0], ep)
        else:
            runs.append((ep, ep))
    return runs


def build_theme_index(
    at_slug: str, *, with_video: bool = True, episodes: range | None = None
) -> tuple[list[Theme], dict[str, list[ThemeReference]]]:
    """Fetch themes + fingerprint every version once (cached). Returns
    (themes, refs_by_theme_slug). Empty refs => nothing to detect against.

    `with_video` (default on): also fingerprint each clean NC clip's keyframes,
    so detection can EXTEND cropped fade edges and fall back to a video-sourced
    alignment when audio is too weak — the image is a first-class signal now,
    not an optional extra.

    `episodes`: only fingerprint themes that could apply to THOSE episodes.
    Every theme used to be built regardless, so a 3-episode run still downloaded
    OP2/ED2 — the second-cour themes mapped to episodes 13-24 — plus every one
    of their versions. Toradora built ~8 references to use 2. That is the bulk
    of the reference cost, it hammers animethemes.moe for nothing, and it is why
    6 of the 7 references lost on the last run were themes the run never needed.
    A full-season backfill asks for every episode, so nothing is skipped there —
    this only stops partial runs from paying for the whole series.
    """
    themes = fetch_themes(at_slug)

    def relevant(t: Theme) -> bool:
        if episodes is None:
            return True
        # Widen each REQUESTED episode by the margin, instead of taking one
        # span from min to max. A sparse request — episodes 1, 2, 3 and the
        # finale, which is how the hard lot samples a season — has a min/max
        # span covering the entire series, so a span test would download every
        # theme of a 100-episode show to use four. Per-episode windows keep the
        # cost proportional to what was actually asked for.
        windows = [
            range(ep - _THEME_RANGE_MARGIN, ep + _THEME_RANGE_MARGIN + 1)
            for ep in episodes
        ]
        for e in t.entries:
            # An entry with no episode mapping applies everywhere — keep it.
            if not getattr(e, "episodes_spec", None):
                return True
            if any(e.covers(ep) for w in windows for ep in w):
                return True
        return False

    wanted = [t for t in themes if relevant(t)]
    skipped = len(themes) - len(wanted)
    if skipped:
        print(f"  [theme] {skipped} theme(s) hors plage episodes — non telecharges")

    refs_by_theme: dict[str, list[ThemeReference]] = {}
    for t in wanted:
        rs = build_references(t, slug_prefix=f"animethemes/{at_slug}", with_video=with_video)
        if rs:
            refs_by_theme[t.slug] = rs
    return themes, refs_by_theme


def needed_hosts(mal_id, lang: str, coverage: dict | None) -> list[str]:
    """The displayed hosts that still need (re)processing for (mal_id, lang):
    those absent from the DB coverage OR stored at a stale algo_version (a host
    we've since added or fixed — e.g. megaplay 1→2 after the de-PNG fix).

    `coverage` is the DB snapshot exported by scripts/export-oped-coverage.mjs:
    { "<mal>:<lang>": { host: processed_version } }. When it's None (no
    --coverage passed) every displayed host is "needed" — i.e. a full run.

    VF-incompatible hosts (megaplay) are dropped for non-vostfr langs so they
    aren't perpetually reported as "needed" for a language they never serve
    (resolve_episodes_multi would filter them anyway, but this keeps the
    per-season skip decision honest)."""
    hosts = [h for h in MULTI_HOSTS
             if not (lang != "vostfr" and h in VF_INCOMPATIBLE_HOSTS)]
    if coverage is None:
        return hosts
    cov = coverage.get(f"{mal_id}:{lang}", {})
    return [h for h in hosts if cov.get(h, 0) < version_of(h)]


def _row_from(ep: int, season: dict, mal_id, streams, per_host, hits,
              inf_op: bool, inf_ed: bool, themes=None) -> dict:
    """One JSONL row: the cross-host consensus plus the PER-HOST timings.

    `op`/`ed` are the averaged consensus and exist as a confidence CHECK — they
    land on no real host (each serves a differently-trimmed encode, e.g.
    cyberpunk OP consensus 1:13 while sibnet is 1:16 and vidmoly 1:10). What a
    player must use is `per_host[host]`.

    `inferred` is stamped HERE, not by detect_op_ed_v2: `refs_for()` owns the
    knowledge that a theme was borrowed from the series pool (same reason
    reconcile_hits takes it as an argument). Without it the per-host dicts carry
    inferred=false and INFERRED_REQUIRES_VIDEO never bites on the path a player
    actually consumes — a borrowed ED matching only the song's reprise would ship
    as a real timing.
    """
    row = {
        "mal_id": mal_id, "episode": ep, "lang": season["lang"],
        "op": None, "ed": None,
    }
    # WHY an empty kind is empty. AnimeThemes maps each theme to an episode span
    # (Erased's ED1 is "2-12" — episode 1 has no ending at all; Re:Zero's OP
    # skips the premiere). Finding nothing there is the CORRECT answer, but it
    # was reported as the same `null` as a genuine miss, so neither the audit
    # sheet nor we could tell a right answer from a failure. Measured on the
    # 2026-08-07 hard lot: 35% of all "absent" cells were absences the source
    # had already declared — and on FINALES it was the majority (71 of 117).
    # Read off the themes already fetched for this anime: no extra request.
    row["expected_absent"] = {
        kind: _kind_absent_by_design(themes, kind, ep)
        for kind in ("op", "ed")
    }
    for h in hits:
        inferred = (h.kind == "op" and inf_op) or (h.kind == "ed" and inf_ed)
        row[h.kind] = {
            "start": round(h.start, 2), "end": round(h.end, 2),
            "theme": h.slug,
            "votes": h.votes, "inferred": inferred or h.inferred,
            # Cross-host robustness metadata: the duration the times are
            # expressed against, the host-independent from-end anchor (for
            # re-projection onto the player's real duration), and the agreement.
            "canonical_duration": h.canonical_duration,
            "from_end_start": h.from_end_start,
            "from_end_end": h.from_end_end,
            "hosts_agree": h.n_hosts_agree,
            "hosts_total": h.n_hosts_total,
            "spread": h.spread_s,
            # True when the hosts formed no single cluster: `hosts_agree` then
            # counts only the largest group, not a consensus. Read the two
            # together — that pairing is what made hyouka ep3 report "4/4
            # agreeing, 22.0s spread".
            "hosts_split": h.hosts_split,
            # Hosts dropped for serving different content (wrong season/episode).
            "hosts_wrong_duration": h.hosts_wrong_duration,
            # Signal provenance + serve gate for the importer/API.
            "source": h.source,
            "n_video_confirm": h.n_video_confirm,
            "serve": h.serve,
            # Why a stored hit is not served, and the plausibility reasons
            # behind it (oped/validate.py). None/empty on a clean served hit.
            "held_reason": h.held_reason,
            "anomalies": list(h.anomalies),
            "low_confidence": h.low_confidence,
            "derived": h.derived,
            # Trouvé hors de sa fenêtre mappée : stocké, jamais servi sans revue.
            "out_of_window": h.out_of_window,
        }

    def _host_entry(stream, host_hits: list) -> dict:
        # algo_version stamps WHICH detector version produced this host's
        # result, so the importer/coverage can tell a fresh row from one
        # predating a host fix (megaplay de-PNG = v2). Present even when
        # host_hits is empty: the row still records that this host was PROCESSED
        # at this version, so the version-based resume won't re-run it until the
        # version moves again.
        out = {"duration": round(stream.duration, 2),
               "algo_version": version_of(stream.host)}
        if stream.duration_estimated:
            out["duration_estimated"] = True
        # Detection RAISED for this host: the empty result below is a transport
        # failure, not an absence of theme. Recorded so a re-run can target the
        # cells that were never actually looked at, and so the coverage figures
        # stop counting a dead stream as a negative answer.
        if stream.detect_error:
            out["detect_error"] = stream.detect_error
        for h in host_hits:
            inferred = inf_op if h.kind == "op" else inf_ed
            d = _hit_to_dict(h, stream.duration)
            d["inferred"] = d.get("inferred", False) or inferred
            # Same precision-first rule as ReconciledHit.serve, applied per
            # host: a borrowed theme is only real here if THIS host's image
            # backs it. Audio alone can't tell the ED sequence from the ED song
            # playing over ordinary end credits.
            if (d["inferred"]
                    and not h.confirmed_by_video
                    and h.source not in ("credited", "video")):
                d["serve"] = False
                d["held_reason"] = "inferred theme, no image confirmation"
            # Thème trouvé HORS de sa fenêtre (balayage de dernier recours,
            # theme_bank._detect_kind). Le cas est réel — Erased ep1 finit sur
            # la chanson d'OUVERTURE — mais élargir la recherche à l'épisode
            # entier élargit aussi la surface de faux positifs (chanson d'insert,
            # récapitulatif). On stocke le timing, on ne le sert pas : la revue
            # manuelle du point 5 est ce qui peut le promouvoir. Précision
            # d'abord, exactement comme pour un thème emprunté.
            # Région suggérée par un pair, mais confirmée sur l'audio de CET
            # hôte (vidmoly-va rend 1287,9 quand l'amorce disait 1281,1 : c'est
            # son propre décalage d'encodage, donc sa propre mesure). Servable,
            # mais tracé — un relecteur doit savoir que la région n'a pas été
            # choisie indépendamment.
            if h.seeded_by_peer:
                d["seeded_by_peer"] = True
            if h.out_of_window:
                d["out_of_window"] = True
                d["serve"] = False
                d["held_reason"] = "theme hors de sa fenetre, revue manuelle requise"
            # A self-derived reference is never served on detection alone —
            # season_pass.py is the only thing that can confirm it
            # (multi_host.DERIVED_REQUIRES_SEASON).
            if h.derived:
                d["serve"] = False
                d["held_reason"] = ("self-derived reference, awaiting season "
                                    "confirmation")
            # F4 — this host's length is borrowed from its peers, so everything
            # anchored on the END is unreliable here. The OP (start-anchored on
            # the absolute clock) ships normally.
            if stream.duration_estimated and h.kind == "ed":
                d["serve"] = False
                d["held_reason"] = "duration estimated, ED anchor unreliable"
            out[h.kind] = d
        return out

    row["per_host"] = {
        stream.host: _host_entry(stream, host_hits)
        for stream, host_hits in per_host
    }
    return row


# Below this share of episodes carrying a kind, the AnimeThemes reference is
# considered not to describe OUR encode (a replaced/absent theme, a wrong
# mapping) and the self-derived path is attempted for that kind. A real theme
# lands on nearly every episode, so a third is already a generous floor.
SELF_REF_MIN_HIT_RATE = 0.34


def _episode_duration(streams) -> float:
    """One representative length for an episode: the median MEASURED host length.

    Estimated durations (F4) are excluded — they land on a nominal 24 min, which
    is precisely the value that would make a double-length episode look normal.
    """
    known = [s.duration for s in (streams or [])
             if s.duration and s.duration > 0 and not s.duration_estimated]
    return float(statistics.median(known)) if known else 0.0


def _multipart_pass(season_rows, season_streams, season_detect, season_flags,
                    season_refs, build_row) -> None:
    """Search the LATER parts of an episode that holds several broadcasts.

    A double-length premiere (Re:Zero S1 ep1: 49:10 against ~23:40 for the rest)
    carries two openings and two endings, and the normal pass can only ever see
    one of each: OP_WINDOW is anchored on the file's start, ED_WINDOW on its end
    via -sseof. Everything in between is out of reach by construction, so the
    interior OP/ED are not "missed" — they were never searched.

    This re-runs the affected episode once per EXTRA part, with that part's own
    windows. Part 1 is skipped: the normal pass already covered it with the
    default windows, and re-running it would just spend the decode again.

    The extra hits go to `row["parts"]` and NOTHING in the existing row changes.
    A consumer that knows nothing about multi-part episodes keeps reading the
    same `op`/`ed` keys it always did and is unaffected; only a consumer that
    looks for `parts` gains the interior themes.
    """
    eps = sorted(season_rows)
    durations = {ep: _episode_duration(season_streams.get(ep)) for ep in eps}

    for ep in eps:
        dur = durations.get(ep) or 0.0
        # The norm is taken over the OTHER episodes: an episode must not help
        # decide it is normal. With a 12-episode season the difference is small,
        # but on a short season a double-length premiere is a big enough share
        # of the median to hide itself.
        siblings = [d for e, d in durations.items() if e != ep and d > 0]
        reference = multipart.reference_duration(siblings)
        n_parts = multipart.part_count(dur, reference)
        if n_parts <= 1 or ep not in season_detect or ep not in season_refs:
            continue

        print(f"  [multipart] ep{ep}: {multipart.describe(dur, n_parts)} "
              f"(season norm {reference:.0f}s)")

        op_r, ed_r = season_refs[ep]
        windows = multipart.part_windows(dur, n_parts, OP_WINDOW, ED_WINDOW)
        inf_op, inf_ed = season_flags.get(ep, (False, False))
        parts: list[dict] = []

        for idx, (op_win, ed_win) in enumerate(windows):
            if idx == 0:
                continue  # already covered by the normal pass
            try:
                per_host = season_detect[ep](
                    op_r, ed_r, with_pool=False,
                    op_window=op_win, ed_window=ed_win,
                )
            except Exception as exc:
                print(f"  [multipart] ep{ep} part{idx + 1} FAILED — "
                      f"{type(exc).__name__}: {exc}")
                continue
            part_row = build_row(ep, season_streams[ep], per_host, inf_op, inf_ed)
            parts.append({
                "part": idx + 1,
                "window_op": list(op_win),
                "window_ed": [ed_win[0], ed_win[1]],
                "op": part_row.get("op"),
                "ed": part_row.get("ed"),
            })
            got = [k for k in ("op", "ed") if part_row.get(k)]
            print(f"  [multipart] ep{ep} part{idx + 1}: "
                  f"{', '.join(got) if got else 'nothing found'}")

        if parts:
            season_rows[ep]["parts"] = parts
            season_rows[ep]["n_parts"] = n_parts


def _self_reference_pass(season_rows, season_streams, season_detect, season_flags,
                         base_prefix: str, season: dict, mal_id, build_row) -> None:
    """F1 — recover the OP/ED from the EPISODES when the reference didn't work.

    Runs after a season's normal pass and only for the kind(s) that came back
    mostly empty. It derives a reference from the repeated segment across
    episodes (oped/self_ref.py), then re-detects the episodes that are missing
    that kind, in place.

    The audio windows it self-matches on are the SAME absolute windows the normal
    pass decoded (`absa/…` cache keys), so on an anime that was just processed
    this costs no network at all; on an anime skipped for having no themes it is
    one window per sampled episode.

    Every hit produced here is stamped `derived` — never served until the
    intra-season pass confirms it (multi_host.DERIVED_REQUIRES_SEASON).
    """
    eps = sorted(season_rows)
    if len(eps) < self_ref.MIN_SUPPORT:
        return
    missing = {
        kind: [e for e in eps if season_rows[e].get(kind) is None]
        for kind in ("op", "ed")
    }
    kinds = tuple(
        k for k in ("op", "ed")
        if len(missing[k]) / len(eps) > (1.0 - SELF_REF_MIN_HIT_RATE)
    )
    if not kinds:
        return

    # Self-matching compares EPISODES, so it must compare them on the SAME host:
    # each host serves a differently-trimmed encode, and mixing them turns a
    # per-host trim difference into apparent position disagreement — exactly the
    # signal `find_segment` uses to reject a segment. Pick the host present on
    # the most episodes (the one that gives the largest coherent sample).
    host_coverage: dict[str, int] = {}
    for e in eps:
        for s in season_streams.get(e) or []:
            host_coverage[s.host] = host_coverage.get(s.host, 0) + 1
    if not host_coverage:
        return
    ref_host = max(host_coverage, key=lambda h: host_coverage[h])

    def _stream_for(ep: int):
        for s in season_streams.get(ep) or []:
            if s.host == ref_host:
                return s
        return None

    duration_by_ep = {
        e: (_stream_for(e).duration if _stream_for(e) else 0.0) for e in eps
    }

    def resolve_window_fp(ep: int, kind: str):
        """The episode's OP or ED search-window fingerprint, on the reference
        host. Same (start, dur) the detector uses, so this hits the cache
        whenever the normal pass already decoded that window."""
        s = _stream_for(ep)
        if s is None:
            return None
        if kind == "op":
            start, dur = OP_SEARCH[0], OP_SEARCH[1]
        else:
            start = max(0.0, s.duration - ED_SEARCH_FROM_END)
            dur = ED_SEARCH_FROM_END
        fp, abs_start = _cached_audio_abs(
            f"absa/{base_prefix}/ep{ep}/{s.host}", s.url, start, dur,
            referer=s.referer,
        )
        return (fp, abs_start)

    refs = self_ref.derive_references(
        eps, resolve_window_fp, duration_by_ep=duration_by_ep, kinds=kinds,
        log=print,
    )
    if not refs:
        return

    for ep in eps:
        need = [k for k in kinds if season_rows[ep].get(k) is None and k in refs]
        if not need or ep not in season_detect:
            continue
        op_r = [refs["op"]] if "op" in need else []
        ed_r = [refs["ed"]] if "ed" in need else []
        try:
            per_host = season_detect[ep](op_r, ed_r, with_pool=False, derived=True)
        except Exception as exc:
            print(f"  [self-ref] ep{ep}: detection failed — "
                  f"{type(exc).__name__}: {exc}")
            continue
        inf_op, inf_ed = season_flags.get(ep, (False, False))
        new_row = build_row(ep, season_streams[ep], per_host, inf_op, inf_ed)
        # Merge: keep everything the reference pass found, fill only the holes.
        # per_host is rebuilt from the derived detection, so merge it key by key
        # rather than overwriting a host's existing (reference-backed) timing.
        for kind in need:
            if new_row.get(kind) is not None:
                season_rows[ep][kind] = new_row[kind]
            for host, entry in new_row.get("per_host", {}).items():
                if kind in entry:
                    season_rows[ep].setdefault("per_host", {}).setdefault(
                        host, entry
                    )[kind] = entry[kind]


def process_anime(
    anime: dict,
    throttler: HostThrottler,
    sink: ResultSink,
    *,
    multi_host: bool = False,
    coverage: dict | None = None,
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
        at_slug = (
            resolve_slug(mal_id=mal_id) if mal_id else resolve_slug(slug=anime.get("at_slug"))
        )
        themes: list[Theme] = []
        refs_by_theme: dict[str, list[ThemeReference]] = {}
        if at_slug:
            # Union of every season's requested range, so a partial run only
            # pays for the themes it can actually use (see build_theme_index).
            wanted_eps: set[int] = set()
            for s in (anime.get("seasons") or []):
                wanted_eps.update(season_episodes(s))
            themes, refs_by_theme = build_theme_index(
                at_slug, episodes=sorted(wanted_eps) or None
            )
    if not refs_by_theme:
        # No usable reference. In multi-host mode that is no longer the end of
        # the road: the self-reference pass (F1) can still recover the OP/ED from
        # the repetition ACROSS episodes, which is where the signal lived all
        # along. Detection below simply produces nothing (no refs = no decode)
        # and `_self_reference_pass` does the work.
        if not multi_host:
            return Record(
                key, "skipped",
                reason="no AnimeThemes entry" if not at_slug
                else "no themes/videos on AnimeThemes",
            )

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
            # PER-SEASON first: voir-anime uses a different slug per LANGUAGE
            # (ashita-no-joe in VOSTFR, ashita-no-joe-2-vf in VF), so a single
            # anime-level slug would serve one language's URL for the other.
            # The anime-level key stays as a fallback for hand-written lists.
            va_slug = (season.get("va_slug") or anime.get("va_slug")
                       or anime.get("slug"))
            # Version-based resume: only (re)resolve the hosts that are missing or
            # stale in the DB coverage. A newly-added or newly-fixed host (bumped
            # in host_versions.json) is the ONLY thing that gets re-run on an anime
            # already in the DB — everything up to date is skipped for free.
            hosts_to_run = needed_hosts(mal_id, season["lang"], coverage)
            if not hosts_to_run:
                continue
            with tc.span("resolve"):
                by_ep = {}
                # A season may ask for a SPARSE set of episodes (1, 2, 3, last).
                # The resolver only speaks contiguous ranges, so walk the runs
                # and merge — resolving 1..last instead would pull every episode
                # of the series to keep four.
                for lo, hi in contiguous_runs(season_episodes(season)):
                    by_ep.update(resolve_episodes_multi(
                        anime["slug"], season["season_dir"], season["lang"],
                        lo, hi,
                        hosts=hosts_to_run,
                        mal_id=mal_id, va_slug=va_slug,
                    ))
            # Rows are buffered for the whole season instead of written per
            # episode: the self-reference pass (F1) below can only decide once it
            # has seen how many episodes the AnimeThemes refs actually covered,
            # and it may REPLACE a row's missing kind. Resume granularity is the
            # anime (the manifest), so nothing is lost by flushing per season.
            season_rows: dict[int, dict] = {}
            season_streams: dict[int, list] = {}
            season_detect: dict[int, object] = {}
            season_flags: dict[int, tuple[bool, bool]] = {}
            season_refs: dict[int, tuple] = {}

            def _build_row(ep: int, streams, per_host, inf_op: bool, inf_ed: bool) -> dict:
                hits = reconcile_hits(
                    per_host, inferred_op=inf_op, inferred_ed=inf_ed
                )
                return _row_from(ep, season, mal_id, streams, per_host, hits,
                                 inf_op, inf_ed, themes=themes)

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
                            # No duration = no clock. The host is not dropped
                            # outright any more (F4): its length is estimated
                            # from its peers below, which is enough for the OP
                            # (start-anchored) while its ED is held back. A
                            # silent drop is how megaplay quietly left 4 of 10
                            # cyberpunk episodes — so still say so.
                            print(f"  [probe-fail] ep{ep} {season['lang']}: {host} "
                                  f"— {type(exc).__name__}: {exc}")
                            return HostStream(host=host, url=e["url"], duration=0.0,
                                              referer=referer,
                                              duration_estimated=True)
                    return HostStream(host=host, url=e["url"], duration=dur,
                                      referer=referer)

                entries = by_ep[ep]
                probed: list[HostStream] = []
                with ThreadPoolExecutor(max_workers=max(1, len(entries))) as ppool:
                    for s in ppool.map(_probe_one, entries):
                        if s is not None:
                            probed.append(s)
                # F4 — lend the median peer duration to hosts whose probe failed.
                # Encodes differ by seconds, not minutes, so the median is a good
                # enough clock to FIND the theme; the `duration_estimated` flag is
                # what keeps its ED out of the consensus and out of serving.
                known = [s.duration for s in probed if not s.duration_estimated]
                fallback_dur = statistics.median(known) if known else 0.0
                streams = []
                for s in probed:
                    if s.duration_estimated:
                        if fallback_dur <= 0:
                            continue          # nothing to borrow — really drop it
                        s.duration = fallback_dur
                    streams.append(s)
                if not streams:
                    continue

                # Every resolver binds `ep` as a DEFAULT ARGUMENT rather than
                # reading it from the enclosing scope. They are stored in
                # `season_detect` and called again AFTER this loop by the
                # self-reference pass, at which point a late-bound `ep` would be
                # the LAST episode of the season — decoding (and cache-keying)
                # the wrong episode entirely.
                def resolve_window_for(stream: HostStream, win, _ep=ep):
                    samples = load_audio(
                        stream.url,
                        cache_key=f"{base_prefix}/ep{_ep}/{stream.host}",
                        window=win, referer=stream.referer,
                    )
                    return fingerprint(samples)

                def resolve_samples_for(stream: HostStream, win, _ep=ep):
                    # Same (key, window) as the fingerprint above → load_audio
                    # cache hit, no second decode. Feeds RMS edge-refinement.
                    return load_audio(
                        stream.url,
                        cache_key=f"{base_prefix}/ep{_ep}/{stream.host}",
                        window=win, referer=stream.referer,
                    )

                def resolve_video_for(stream: HostStream, win, _ep=ep):
                    return extract_keyframe_hashes(
                        stream.url,
                        cache_key=f"video/{base_prefix}/ep{_ep}/{stream.host}",
                        cache_dir="cache/video",
                        window=win, referer=stream.referer,
                    )

                def resolve_video_dense_for(stream: HostStream, win, fps, _ep=ep):
                    # Dense edge decode per host; fps in the cache key keeps it
                    # distinct from the 2fps windows for the same stream.
                    return extract_keyframe_hashes(
                        stream.url,
                        cache_key=f"video/{base_prefix}/ep{_ep}/{stream.host}",
                        cache_dir="cache/video",
                        window=win, fps=fps, referer=stream.referer,
                    )

                # v2 ABSOLUTE-timeline resolvers (shared clock) — the default now.
                # decode_audio_abs / keyframe_hashes_abs use -copyts + absolute -ss
                # so audio and native video carry the same absolute pts and the
                # image landmark anchor owns the boundary; no -sseof, no dense
                # cascade. Same absa/absv cache keys as detect_anime.py.
                def resolve_audio_abs_for(stream: HostStream, start_abs, dur, _ep=ep):
                    return _cached_audio_abs(
                        f"absa/{base_prefix}/ep{_ep}/{stream.host}",
                        stream.url, start_abs, dur,
                        referer=stream.referer,
                    )

                def resolve_video_abs_for(stream: HostStream, start_abs, dur, fps,
                                          _ep=ep):
                    return keyframe_hashes_abs(
                        stream.url, start_abs, dur, fps=fps,
                        referer=stream.referer,
                        cache_key=f"absv/{base_prefix}/ep{_ep}/{stream.host}",
                        cache_dir="cache/video",
                    )

                # Detect each host ON ITS OWN encode, then reconcile. The per-host
                # hits are what a player actually needs at runtime (each host
                # serves a differently-trimmed stream, so the averaged consensus
                # lands on NO real host — e.g. cyberpunk OP consensus 1:13 while
                # sibnet is 1:16, vidmoly 1:10). The consensus stays as the
                # cross-host confidence check only.
                #
                # Kept as a closure so the F1 self-reference pass can re-run this
                # episode against a DIFFERENT set of references without
                # re-resolving or re-probing anything.
                # Same late-binding hazard as the resolvers, one level up: the
                # resolver NAMES are rebound on every iteration, so this closure
                # must capture the objects belonging to ITS episode.
                def _detect(op_r, ed_r, *, with_pool=True, derived=False,
                            op_window=OP_WINDOW, ed_window=ED_WINDOW,
                            _streams=streams, _ep=ep,
                            _win=resolve_window_for, _samples=resolve_samples_for,
                            _video=resolve_video_for, _dense=resolve_video_dense_for,
                            _audio_abs=resolve_audio_abs_for,
                            _video_abs=resolve_video_abs_for):
                    try:
                        with tc.span("detect"):
                            return detect_per_host(
                                _streams, _win, op_r, ed_r,
                                resolve_samples_for=_samples,
                                resolve_video_for=_video,
                                resolve_video_dense_for=_dense,
                                resolve_audio_abs_for=_audio_abs,
                                resolve_video_abs_for=_video_abs,
                                v2=True,
                                # F3 — series-wide fallback when the episode's
                                # MAPPED theme matches nothing (AnimeThemes'
                                # `episodes` spec is regularly off by one around an
                                # OP1→OP2 switch). Only used after the mapped refs
                                # fail, and the resulting hit is stamped `inferred`.
                                op_pool_refs=(op_pool if with_pool else None),
                                ed_pool_refs=(ed_pool if with_pool else None),
                                mark_derived=derived,
                                # Defaults are the whole-file windows. The
                                # multi-part pass re-runs an episode with a
                                # LATER part's windows so the second broadcast's
                                # OP/ED are searched on their own clock.
                                op_window=op_window, ed_window=ed_window,
                            )
                    except Exception as exc:
                        if is_throttle_error(exc):
                            # Charge the slowest/first host with the throttle signal.
                            with throttler.slot(_streams[0].url) as slot:
                                slot.throttled()
                        raise

                per_host = _detect(op_refs, ed_refs)

                season_rows[ep] = _build_row(ep, streams, per_host, inf_op, inf_ed)
                season_streams[ep] = streams
                season_detect[ep] = _detect
                season_flags[ep] = (inf_op, inf_ed)
                season_refs[ep] = (op_refs, ed_refs)

            # ── F1: self-derived references ─────────────────────────────────
            # Everything above depends on AnimeThemes having the theme that is
            # actually in OUR encode. When it doesn't — no entry at all, a dub
            # with a replaced opening, a streaming cut, an empty mapping — the
            # season comes back mostly empty. The OP/ED is still there, as the
            # segment that REPEATS across episodes, so recover it from the
            # episodes themselves and re-run the affected ones.
            _self_reference_pass(
                season_rows, season_streams, season_detect, season_flags,
                base_prefix, season, mal_id, _build_row,
            )

            # ── Multi-part episodes ─────────────────────────────────────────
            # Runs LAST, after F1: it needs every episode's duration to know
            # what this season's normal length is, and it should search the
            # interior parts with whatever references ended up working —
            # including any F1 recovered above.
            _multipart_pass(
                season_rows, season_streams, season_detect, season_flags,
                season_refs, _build_row,
            )

            for ep in sorted(season_rows):
                sink.write(season_rows[ep])
                written += 1
            continue


        # ── single-host path (default) ──────────────────────────────────────
        with tc.span("resolve"):
            eps = []
            for lo, hi in contiguous_runs(season_episodes(season)):
                eps += resolve_episodes(
                    anime["slug"], season["season_dir"], season["lang"], lo, hi,
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
                try:
                    with tc.span("probe", host=host):
                        ep_dur = _probe_duration(url)
                except ProbeError as exc:
                    # No duration = no clock to express this episode's timings
                    # against. Skip the EPISODE (not the season) rather than
                    # detect against a fabricated one.
                    if is_throttle_error(exc):
                        slot.throttled()
                    print(f"  [skip] ep{ep} {season['lang']} {host}: {exc}")
                    continue

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
    coverage: dict | None = None,
    timings: bool = False,
) -> None:
    manifest = Manifest(manifest_path)
    sink = ResultSink(out_path)
    throttler = HostThrottler(start=start_conc, max_per_host=max_per_host)
    tc = TimingCollector(enabled=timings)
    t_run0 = time.monotonic()

    def key_of(a: dict) -> str:
        return f"mal:{a['mal_id']}" if a.get("mal_id") else f"slug:{a.get('slug')}"

    def _has_work(a: dict) -> bool:
        # An anime needs a run when ANY of its seasons still has a host missing or
        # stale in the coverage snapshot (version-based resume). Multi-host only —
        # the single-host path keeps the manifest-based skip below.
        return any(
            needed_hosts(a.get("mal_id"), s["lang"], coverage)
            for s in a.get("seasons", [])
        )

    todo = anime_list
    if coverage is not None and multi_host:
        # Coverage-driven resume: run only anime with a missing/stale host. This
        # is what makes "add or fix a host → re-run ONLY that host" work, even on
        # anime the manifest already marked done in a previous full run.
        before = len(todo)
        todo = [a for a in todo if _has_work(a)]
        print(f"coverage resume: {before - len(todo)} fully up-to-date, "
              f"{len(todo)} with a missing/stale host to do")
    elif resume:
        before = len(todo)
        todo = [a for a in todo if not manifest.is_done(key_of(a))]
        print(f"resume: {before - len(todo)} already done/skipped, {len(todo)} to do")

    def worker(a: dict) -> tuple[str, str]:
        key = key_of(a)
        try:
            rec = process_anime(a, throttler, sink, multi_host=multi_host,
                                coverage=coverage, timings=tc)
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

    # Reference losses are the one failure that does NOT show up as a failed
    # anime: the run "succeeds", quietly degraded to the F1 self-derived path.
    # That is how vinland-saga and dororo lost every OP/ED reference on the
    # 15-anime audit without a single line of output. Surface it loudly — on a
    # full backfill this is the difference between a real result and a silently
    # weaker one.
    if theme_bank.REFERENCE_FAILURES:
        print(f"\n!! REFERENCES PERDUES ({len(theme_bank.REFERENCE_FAILURES)}) — "
              f"ces themes ont bascule sur le repli F1 :")
        for key, url, err in theme_bank.REFERENCE_FAILURES[:40]:
            print(f"   {key}  {err}  ({url})")
        if len(theme_bank.REFERENCE_FAILURES) > 40:
            print(f"   … et {len(theme_bank.REFERENCE_FAILURES) - 40} autres")
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
        len(season_episodes(s))
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
    ap.add_argument(
        "--coverage", default=None,
        help="path to a coverage snapshot from scripts/export-oped-coverage.mjs "
             "({'<mal>:<lang>': {host: version}}). Enables version-based resume: "
             "only hosts absent or at a stale algo_version (host_versions.json) "
             "are (re)run — so adding a host or bumping one (e.g. megaplay 1->2) "
             "re-runs ONLY that host on anime already in the DB. Multi-host only.",
    )
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

    coverage = None
    if args.coverage:
        coverage = json.loads(Path(args.coverage).read_text("utf-8"))
        print(f"loaded coverage for {len(coverage)} (mal:lang) panels "
              f"from {args.coverage}")

    run(
        anime_list, args.out,
        manifest_path=args.manifest,
        workers=args.workers,
        start_conc=args.start_conc,
        max_per_host=args.max_per_host,
        resume=args.resume,
        multi_host=args.multi_host,
        coverage=coverage,
        timings=args.timings,
    )


if __name__ == "__main__":
    main()
