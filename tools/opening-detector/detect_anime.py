"""Run the AnimeThemes-anchored OP/ED detector on ONE anime, by AniList id,
over a defined number of episodes.

This is the single-anime counterpart of `batch_detect.py` (which loops over
2000 animes from an `anime.json` manifest): here you give one AniList id, one
anime-sama slug/season/lang, and how many episodes to scan, and you get a
report + a JSON file with the recovered (start, end) for the OP and ED of
each episode.

Why `--slug`/`--season`/`--lang` are still required even though you only give
an AniList id: this tool does NOT derive the AniList-id <-> anime-sama slug
<-> season mapping (see README §5 "CONTRAT D'ENTRÉE") — that's the app's job.
The AniList id is used ONLY to look up the anime on AnimeThemes.moe (the
themes / reference audio), completely independently of how the episodes
themselves are resolved.

Examples
--------
Single host, first 12 episodes of SnK S1:
  python detect_anime.py --anilist 16498 --slug shingeki-no-kyojin \
      --season saison1 --lang vostfr --episodes 12

Explicit episode range instead of a count:
  python detect_anime.py --anilist 16498 --slug shingeki-no-kyojin \
      --start 3 --end 5

Cross-host reconciliation (robust to per-host duration differences):
  python detect_anime.py --anilist 16498 --slug shingeki-no-kyojin \
      --episodes 12 --multi-host --out out/snk.json

Cross-host, both languages in one invocation (run concurrently):
  python detect_anime.py --anilist 16498 --slug shingeki-no-kyojin \
      --episodes 12 --multi-host --langs vostfr,vf --mal 16498 \
      --va-slug shingeki-no-kyojin-vostfr --out out/snk.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.adapter_aniscroll import (
    MULTI_HOSTS,
    resolve_episodes,
    resolve_episodes_multi,
)
from oped.animethemes import fetch_themes, resolve_slug, themes_for_episode
from oped.audio import _is_hls_url, load_audio
from oped.multi_host import (
    HostStream,
    ReconciledHit,
    detect_per_host,
    reconcile_hits,
)
from oped.video_fingerprint import extract_keyframe_hashes
from oped.theme_bank import (
    ED_WINDOW,
    OP_WINDOW,
    ThemeHit,
    ThemeReference,
    build_references,
    cached_fingerprint,
    detect_op_ed,
)


# ── small helpers ────────────────────────────────────────────────────────────


def _probe_duration(url: str, referer: str | None = None) -> float:
    """Episode duration in seconds via ffprobe (container header only, no
    full read — cheap even over the network).

    Needs the same treatment as `_ffmpeg_decode` in audio.py, or probing
    silently fails on some hosts and we fall back to a bogus hardcoded
    duration:
      - `-headers Referer: …` — some hosts (megaplay's mewstream/zapora CDN)
        403 the master m3u8 without the right Referer.
      - `-allowed_extensions ALL -allowed_segment_extensions ALL
        -extension_picky 0` — HLS-ONLY flags. Some HLS hosts serve real media
        segments under a disguised extension (megaplay's zapora CDN uses
        `.jpg` for actual HLS segments, an anti-scraping trick); ffprobe's
        default segment extension allowlist rejects those with "Invalid data
        found" unless relaxed. But these are private options of ffmpeg's HLS
        demuxer — passing them for a non-HLS source (e.g. sendvid's plain
        .mp4) makes ffprobe hard-error with "Option ... not found", so they
        must be gated on the URL actually being an .m3u8 (see `_is_hls_url`
        in audio.py, reused here so both call sites agree).
    Confirmed on megaplay/SnK ep3: without the Referer + HLS flags, ffprobe
    fails and we silently returned 24*60 = 1440.0s (vs a real duration of
    ~1466.5s) — that bogus duration corrupted the ED `-sseof` window AND the
    abs-offset conversion for that host specifically.
    """
    cmd = ["ffprobe", "-v", "error"]
    if referer:
        cmd += ["-headers", f"Referer: {referer}\r\n"]
    if _is_hls_url(url):
        cmd += ["-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0"]
    cmd += [
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", url,
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception as exc:
        print(f"  [warn] _probe_duration failed for {url!r}: {exc} "
              f"— using 1440s fallback (approximate ED offset only)")
        return 24 * 60.0  # sane default; only makes the ED offset approximate


def ms(s: float) -> str:
    return f"{int(s) // 60}:{int(s) % 60:02d}"


def clock(iv) -> str:
    return f"{ms(iv[0])}-{ms(iv[1])}" if iv else "—"


# ── theme references (built once, shared by every episode) ─────────────────


def load_theme_pools(anilist_id: int, *, with_video: bool = False):
    """AniList id -> AnimeThemes slug -> themes -> fingerprinted references.

    Returns (at_slug, themes, refs_by_theme, op_pool, ed_pool). The pools are
    every OP/ED reference across the anime, used as a cour-wide fallback when
    an episode has no direct mapping in AnimeThemes' `episodes` field.

    Each theme's reference set is built (downloaded + fingerprinted, or loaded
    from cache) CONCURRENTLY — themes are independent of each other, and an
    anime typically has several (OP1, OP2, ED1, ED2, …), so this is a
    straightforward wall-clock win with no change to what gets computed.
    """
    at_slug = resolve_slug(anilist_id=anilist_id)
    if not at_slug:
        raise SystemExit(
            f"AniList id {anilist_id}: no AnimeThemes match (no anime found "
            "via /resource — check the id, or this anime simply isn't on "
            "AnimeThemes.moe)."
        )
    print(f"AnimeThemes slug for AniList {anilist_id}: {at_slug}")

    themes = fetch_themes(at_slug)
    if not themes:
        raise SystemExit(f"AnimeThemes has no OP/ED themes listed for '{at_slug}'.")
    for t in themes:
        eps = " | ".join(f"v{e.version}:{e.episodes_spec}" for e in t.entries)
        print(f"  {t.slug:4} {t.kind}  {t.song!r} — {eps}")

    print("\nBuilding theme references (clean NC audio, fingerprinted in parallel, cached)…")
    refs_by_theme: dict[str, list[ThemeReference]] = {}

    def _build_theme(t):
        return t, build_references(
            t, slug_prefix=f"animethemes/{at_slug}", with_video=with_video
        )

    with ThreadPoolExecutor(max_workers=max(1, len(themes))) as pool:
        for t, rs in pool.map(_build_theme, themes):
            if rs:
                refs_by_theme[t.slug] = rs
                print(f"  {t.slug}: {len(rs)} version(s), "
                      f"{[f'{r.duration:.0f}s' for r in rs]}")

    op_pool = [r for rs in refs_by_theme.values() for r in rs if r.kind == "op"]
    ed_pool = [r for rs in refs_by_theme.values() for r in rs if r.kind == "ed"]
    if not op_pool and not ed_pool:
        raise SystemExit(f"'{at_slug}' has themes but no playable video for any of them.")
    return at_slug, themes, refs_by_theme, op_pool, ed_pool


def refs_for_episode(themes, refs_by_theme, op_pool, ed_pool, ep: int):
    """Direct AnimeThemes mapping for `ep`, falling back to the cour pools
    (flagged `inferred`) when the episode falls in a mapping hole."""
    picked = themes_for_episode(themes, ep)
    op_refs = refs_by_theme.get(picked["op"].slug, []) if picked["op"] else []
    ed_refs = refs_by_theme.get(picked["ed"].slug, []) if picked["ed"] else []

    inferred_op = inferred_ed = False
    if not op_refs and op_pool:
        op_refs, inferred_op = op_pool, True
    if not ed_refs and ed_pool:
        ed_refs, inferred_ed = ed_pool, True
    return op_refs, ed_refs, inferred_op, inferred_ed


def _flag_inferred(hits: list[ThemeHit], inferred_op: bool, inferred_ed: bool):
    for h in hits:
        if (h.kind == "op" and inferred_op) or (h.kind == "ed" and inferred_ed):
            h.inferred = True
    return hits


# ── single-host path ─────────────────────────────────────────────────────────


def run_single_host(args, themes, refs_by_theme, op_pool, ed_pool, eps):
    def process(e: dict):
        ep = e["ep"]
        url = e["url"]
        base_key = f"{args.slug}/{args.season}/{args.lang}/ep{ep}"
        ep_dur = _probe_duration(url, referer=e.get("referer"))

        def resolve_window(win):
            # cached_fingerprint caches the FINGERPRINT itself (not just the
            # PCM), keyed by (base_key, window) — a rerun over the same
            # episode/window skips both the ffmpeg decode and the
            # spectrogram/hash pass entirely.
            fp, _dur = cached_fingerprint(
                base_key, url, "cache/audio", window=win, referer=e.get("referer")
            )
            return fp

        def resolve_samples(win):
            # SAME (base_key, window) → load_audio cache hit, no second decode.
            return load_audio(
                url, cache_key=base_key, cache_dir="cache/audio",
                window=win, referer=e.get("referer"),
            )

        def resolve_video(win):
            return extract_keyframe_hashes(
                url, cache_key=f"video/{base_key}", cache_dir="cache/video",
                window=win, referer=e.get("referer"),
            )

        def resolve_video_dense(win, fps):
            return extract_keyframe_hashes(
                url, cache_key=f"video/{base_key}", cache_dir="cache/video",
                window=win, referer=e.get("referer"), fps=fps,
            )

        op_refs, ed_refs, inferred_op, inferred_ed = refs_for_episode(
            themes, refs_by_theme, op_pool, ed_pool, ep
        )
        hits = detect_op_ed(
            resolve_window, ep_dur, op_refs, ed_refs,
            resolve_samples=resolve_samples,
            resolve_video=(resolve_video if not args.no_video else None),
            resolve_video_dense=(resolve_video_dense if not args.no_video else None),
            op_window=OP_WINDOW, ed_window=ED_WINDOW,
            min_votes=args.min_votes, min_score=args.min_score,
            refine=not args.no_refine,
        )
        return ep, ep_dur, _flag_inferred(hits, inferred_op, inferred_ed)

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for ep, dur, hits in pool.map(process, eps):
            results.append((ep, dur, hits))
            print(f"  ep{ep}: {dur / 60:.1f} min, {len(hits)} hit(s)")
    return results


def report_single_host(results, log=print) -> dict:
    log("\nRecovered OP/ED (windowed, absolute episode time):\n")
    hdr = f"{'ep':>3}  {'kind':>4}  {'theme':>6}  {'recovered':>13}  {'votes':>6}"
    log(hdr)
    log("-" * len(hdr))
    out_eps: dict[str, dict] = {}
    for ep, _dur, hits in sorted(results):
        by_kind = {h.kind: h for h in hits}
        ep_out: dict = {}
        for kind in ("op", "ed"):
            h = by_kind.get(kind)
            if h is None:
                continue
            theme = f"{h.slug}{'*' if h.inferred else ''}"
            log(f"{ep:>3}  {kind:>4}  {theme:>6}  {clock((h.start, h.end)):>13}  "
                f"{h.votes:>6}")
            ep_out[kind] = {
                "slug": h.slug, "version": h.version,
                "start": round(h.start, 2), "end": round(h.end, 2),
                "votes": h.votes, "score": round(h.score, 4),
                "inferred": h.inferred,
            }
        out_eps[str(ep)] = ep_out
    log("\n(* = matched via cour fallback, no direct AnimeThemes mapping)")
    return out_eps


# ── multi-host path ──────────────────────────────────────────────────────────


def run_multi_host(args, themes, refs_by_theme, op_pool, ed_pool, lang: str, log=print):
    hosts = args.host.split(",") if args.host else MULTI_HOSTS
    log(f"Resolving {args.slug} {args.season}/{lang} "
        f"ep{args.start}-{args.end} across hosts: {hosts}…")
    by_ep = resolve_episodes_multi(
        args.slug, args.season, lang, args.start, args.end, hosts=hosts,
        mal_id=args.mal, va_slug=args.va_slug,
    )
    if not by_ep:
        log(f"  [warn] no host resolved any episode in that range for lang={lang!r} — skipping")
        return []

    def process(item):
        ep, entries = item

        def _probe_one(e: dict) -> tuple[str, HostStream, dict]:
            dur = _probe_duration(e["url"], referer=e.get("referer"))
            host = e.get("host", "?")
            return host, HostStream(host=host, url=e["url"], duration=dur), e

        streams: list[HostStream] = []
        stream_meta: dict[str, dict] = {}
        with ThreadPoolExecutor(max_workers=max(1, len(entries))) as pool:
            for host, stream, e in pool.map(_probe_one, entries):
                streams.append(stream)
                stream_meta[host] = e

        def resolve_window_for(stream: HostStream, win):
            e = stream_meta[stream.host]
            base_key = f"{args.slug}/{args.season}/{lang}/{stream.host}/ep{ep}"
            fp, _dur = cached_fingerprint(
                base_key, stream.url, "cache/audio", window=win, referer=e.get("referer")
            )
            return fp

        def resolve_samples_for(stream: HostStream, win):
            # SAME (base_key, window) as the fingerprint above → load_audio cache
            # hit, no second decode. Feeds edge-refinement's RMS snapping.
            e = stream_meta[stream.host]
            base_key = f"{args.slug}/{args.season}/{lang}/{stream.host}/ep{ep}"
            return load_audio(
                stream.url, cache_key=base_key, cache_dir="cache/audio",
                window=win, referer=e.get("referer"),
            )

        def resolve_video_for(stream: HostStream, win):
            e = stream_meta[stream.host]
            base_key = f"video/{args.slug}/{args.season}/{lang}/{stream.host}/ep{ep}"
            return extract_keyframe_hashes(
                stream.url, cache_key=base_key, cache_dir="cache/video",
                window=win, referer=e.get("referer"),
            )

        def resolve_video_dense_for(stream: HostStream, win, fps):
            e = stream_meta[stream.host]
            base_key = f"video/{args.slug}/{args.season}/{lang}/{stream.host}/ep{ep}"
            return extract_keyframe_hashes(
                stream.url, cache_key=base_key, cache_dir="cache/video",
                window=win, referer=e.get("referer"), fps=fps,
            )

        op_refs, ed_refs, inferred_op, inferred_ed = refs_for_episode(
            themes, refs_by_theme, op_pool, ed_pool, ep
        )
        # Detect once per host, keeping EACH host's own timing (its video has its
        # own length/offset, so the delivered skip differs per player). The
        # consensus is derived on top only as a cross-host confidence check.
        per_host = detect_per_host(
            streams, resolve_window_for, op_refs, ed_refs,
            resolve_samples_for=resolve_samples_for,
            resolve_video_for=(resolve_video_for if not args.no_video else None),
            resolve_video_dense_for=(resolve_video_dense_for if not args.no_video else None),
            op_window=OP_WINDOW, ed_window=ED_WINDOW,
            min_votes=args.min_votes, min_score=args.min_score,
        )
        for _stream, host_hits in per_host:
            for h in host_hits:
                if (h.kind == "op" and inferred_op) or (h.kind == "ed" and inferred_ed):
                    h.inferred = True
        reconciled = reconcile_hits(per_host)
        return ep, streams, per_host, reconciled

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for ep, streams, per_host, reconciled in pool.map(process, sorted(by_ep.items())):
            results.append((ep, streams, per_host, reconciled))
            hosts_used = [s.host for s in streams]
            n_hit = sum(1 for _s, hh in per_host if hh)
            log(f"  ep{ep}: {len(streams)} host(s) {hosts_used}, "
                f"{n_hit} with a hit")
    return results


def _hit_to_dict(h: ThemeHit, duration: float) -> dict:
    """Serialize ONE host's hit for JSON, self-describing about its own encode.

    `duration` is THIS host's total length. For an ED we also emit seconds-from-
    end (`from_end_start`/`from_end_end`) so a player on a differently-trimmed
    stream can re-project onto its own <video> duration; for an OP the absolute
    start is already the anchor. `start`/`end` are in THIS host's episode time.
    """
    out = {
        "kind": h.kind,
        "slug": h.slug,
        "version": h.version,
        "start": round(h.start, 2),
        "end": round(h.end, 2),
        "duration": round(duration, 2),
        "votes": h.votes,
        "score": round(h.score, 4),
        "source": h.source,
        "edge_start_source": h.edge_start_source,
        "edge_end_source": h.edge_end_source,
        "confirmed_by_video": h.confirmed_by_video,
        "video_disagreement": h.video_disagreement,
        "inferred": h.inferred,
    }
    if h.kind == "ed":
        out["from_end_start"] = round(max(0.0, duration - h.start), 2)
        out["from_end_end"] = round(max(0.0, duration - h.end), 2)
    return out


def report_multi_host(results, log=print) -> dict:
    """Per-host OP/ED delivery (each player keeps its OWN timing), with the
    cross-host consensus reported alongside as a confidence check only."""
    log("\nRecovered OP/ED — PER HOST (each player's own video/timing):\n")
    hdr = (f"{'ep':>3}  {'host':>10}  {'lang-dur':>9}  {'kind':>4}  "
           f"{'recovered':>13}  {'from-end':>9}  {'votes':>6}  {'align':>8}")
    log(hdr)
    log("-" * len(hdr))

    out_eps: dict[str, dict] = {}
    for ep, streams, per_host, reconciled in sorted(results, key=lambda r: r[0]):
        dur_by_host = {s.host: s.duration for s in streams}
        ph_out: dict = {}
        for stream, hits in sorted(per_host, key=lambda x: x[0].host):
            host = stream.host
            host_out: dict = {"duration": round(stream.duration, 2)}
            if not hits:
                log(f"{ep:>3}  {host:>10}  {stream.duration/60:>7.1f}m  "
                    f"{'—':>4}  {'no hit':>13}  {'—':>9}  {'—':>6}  {'—':>8}")
            for h in sorted(hits, key=lambda h: h.start):
                flag = "*" if h.inferred else ""
                fe = (f"-{ms(max(0.0, stream.duration - h.start))}"
                      if h.kind == "ed" else "—")
                log(f"{ep:>3}  {host:>10}  {stream.duration/60:>7.1f}m  "
                    f"{h.kind+flag:>4}  {clock((h.start, h.end)):>13}  "
                    f"{fe:>9}  {h.votes:>6}  {h.source:>8}")
                host_out[h.kind] = _hit_to_dict(h, stream.duration)
            ph_out[host] = host_out

        # Consensus is kept ONLY as a cross-check (which hosts agree, how tight),
        # not as the delivered timing — the per-host entries above are authoritative.
        consensus_out: dict = {}
        for h in sorted(reconciled, key=lambda h: h.start):
            consensus_out[h.kind] = {**asdict(h)}

        out_eps[str(ep)] = {"per_host": ph_out, "consensus": consensus_out}

    # Compact consensus recap so a quick read still shows agreement/spread.
    log("\nCross-host consensus (confidence check only — NOT the delivered per-host "
        "timing):\n")
    chdr = (f"{'ep':>3}  {'kind':>4}  {'consensus':>13}  {'votes':>6}  "
            f"{'agree':>7}  {'spread':>7}")
    log(chdr)
    log("-" * len(chdr))
    for ep, _streams, _per_host, reconciled in sorted(results, key=lambda r: r[0]):
        for h in sorted(reconciled, key=lambda h: h.start):
            flag = "*" if h.inferred else " "
            agree = f"{h.n_hosts_agree}/{h.n_hosts_total}"
            log(f"{ep:>3}  {h.kind:>4}{flag} {clock((h.start, h.end)):>12}  "
                f"{h.votes:>6}  {agree:>7}  {h.spread_s:>6.1f}s")

    log("\n(* = matched via cour fallback. PER-HOST times are in each host's own "
        "episode time; 'from-end' is the ED anchor for re-projection. Consensus "
        "'agree' = hosts within tolerance / hosts that produced a hit.)")
    return out_eps


def print_final_recap(out_eps: dict, log=print) -> None:
    """One consolidated table across EVERY (episode, lang, host) cell — the full
    per-player picture in a single place, with the language spelled out on each
    row. `out_eps` is the merged multi-host map: out_eps[ep][lang] = {per_host,
    consensus}. OP and ED are shown side by side per row so one line = one
    player's complete delivery for that episode/language."""
    log("\n" + "=" * 96)
    log("RÉCAPITULATIF COMPLET — chaque lecteur, chaque langue (OP + ED côte à côte)")
    log("=" * 96)
    hdr = (f"{'ep':>3}  {'lang':>6}  {'host':>10}  {'dur':>6}  "
           f"{'OP':>13}  {'ED':>13}  {'ED from-end':>12}  {'votes(op/ed)':>13}  {'align':>14}")
    log(hdr)
    log("-" * len(hdr))

    def _fmt(iv):
        return clock(iv) if iv else "—"

    n_rows = 0
    # ep keys are strings; sort numerically when possible.
    for ep in sorted(out_eps, key=lambda x: (int(x) if str(x).isdigit() else 1 << 30, str(x))):
        for lang in sorted(out_eps[ep]):
            cell = out_eps[ep][lang]
            per_host = cell.get("per_host", {}) if isinstance(cell, dict) else {}
            for host in sorted(per_host):
                hd = per_host[host]
                op = hd.get("op")
                ed = hd.get("ed")
                dur = hd.get("duration")
                op_iv = (op["start"], op["end"]) if op else None
                ed_iv = (ed["start"], ed["end"]) if ed else None
                ed_fe = (f"-{ms(ed['from_end_start'])}"
                         if ed and ed.get("from_end_start") is not None else "—")
                votes = (f"{op['votes'] if op else '—'}/"
                         f"{ed['votes'] if ed else '—'}")
                # Alignment provenance: prefer whichever hit exists; flag mixed.
                srcs = {x["source"] for x in (op, ed) if x}
                align = "/".join(sorted(srcs)) if srcs else "—"
                infer = "*" if (op and op.get("inferred")) or (ed and ed.get("inferred")) else ""
                log(f"{ep:>3}  {lang:>6}  {host:>10}  "
                    f"{(dur/60 if dur else 0):>5.1f}m  "
                    f"{_fmt(op_iv):>13}  {_fmt(ed_iv):>13}  {ed_fe:>12}  "
                    f"{votes:>13}  {align:>14}{infer}")
                n_rows += 1
    if n_rows == 0:
        log("  (aucun résultat)")
    log("\n(dur = durée de CE lecteur; ED from-end = ancre indépendante de la durée, "
        "pour re-projeter le skip sur la vraie durée du <video> joué; * = cour "
        "fallback. Chaque ligne = un lecteur pour un épisode/une langue donnés — "
        "AUCUNE moyenne.)")


# ── main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Detect OP/ED skip intervals for one anime (AniList id) "
                    "over a defined number of episodes.",
    )
    ap.add_argument("--anilist", type=int, required=True, help="AniList anime id")
    ap.add_argument("--slug", required=True, help="anime-sama slug (this project's extractor)")
    ap.add_argument("--season", default="saison1", help="anime-sama season dir (default: saison1)")
    ap.add_argument("--lang", default="vostfr", help="vostfr | vf (default: vostfr)")
    ap.add_argument("--start", type=int, default=1, help="first episode (default: 1)")

    ep_group = ap.add_mutually_exclusive_group()
    ep_group.add_argument("--episodes", type=int, help="number of episodes to scan from --start")
    ep_group.add_argument("--end", type=int, help="last episode (alternative to --episodes)")

    ap.add_argument("--host", default=None,
                     help="single-host mode: pin one host (e.g. 'sibnet'); "
                          "multi-host mode: comma list of hosts to try")
    ap.add_argument("--multi-host", action="store_true",
                     help="reconcile OP/ED across several hosts (robust to "
                          "per-host episode-duration differences)")
    ap.add_argument("--langs", default=None,
                     help="multi-host mode only: comma list of languages to run "
                          "in ONE invocation, e.g. 'vostfr,vf' (default: just "
                          "--lang). Each language is resolved and reconciled "
                          "independently — megaplay is auto-excluded for any "
                          "lang != vostfr (see VF_INCOMPATIBLE_HOSTS). Languages "
                          "run CONCURRENTLY (each is an independent set of "
                          "hosts/episodes); their console logs are buffered per "
                          "language and printed as one block once that language "
                          "finishes, so output stays readable despite running "
                          "in parallel. Output JSON nests each episode by lang: "
                          "episodes[ep][lang] = {op, ed}.")
    ap.add_argument("--mal", default=None,
                     help="MAL id — required to reach the 'megaplay' host "
                          "(its embed is built from mal_id+episode, not "
                          "scraped like the other hosts). Without it, "
                          "megaplay is silently skipped in --multi-host mode.")
    ap.add_argument("--va-slug", default=None,
                     help="voir-anime slug (e.g. shingeki-no-kyojin-vostfr) — "
                          "required to reach the 'vidmoly-va' host. Without "
                          "it, vidmoly-va is silently skipped in --multi-host mode.")
    ap.add_argument("--workers", type=int, default=4, help="parallel episodes (default: 4)")
    ap.add_argument("--min-votes", type=int, default=40)
    ap.add_argument("--min-score", type=float, default=0.15,
                     help="min votes/sec of the matched span — quality gate "
                          "(default: 0.15; 0 = off)")
    ap.add_argument("--no-video", action="store_true",
                     help="disable the credited-frame path (audio-only, fast). "
                          "By default the detector also fingerprints the theme "
                          "keyframes: a confident CREDITED (with-credits) frame "
                          "match becomes the frame-accurate alignment source and "
                          "overrides audio; a clean NC match only cross-confirms "
                          "the audio boundary and extends cropped fade edges. "
                          "Costs an extra keyframe decode per window.")
    ap.add_argument("--no-refine", action="store_true",
                     help="disable RMS edge-snapping — deliver the raw reference "
                          "projection without onset/cut refinement (debug).")
    ap.add_argument("--out", default=None, help="write results as JSON to this path")
    args = ap.parse_args()

    if args.episodes is not None:
        args.end = args.start + args.episodes - 1
    elif args.end is None:
        args.end = args.start  # default: just the one episode at --start
    if args.end < args.start:
        raise SystemExit("--end must be >= --start")

    at_slug, themes, refs_by_theme, op_pool, ed_pool = load_theme_pools(
        args.anilist, with_video=not args.no_video
    )

    if args.multi_host:
        langs = args.langs.split(",") if args.langs else [args.lang]

        def _run_lang(lang: str):
            # Buffer this language's logs instead of printing directly, so
            # concurrent languages don't interleave their output — the whole
            # block for one language is flushed together once it's done,
            # same pattern as diag_multi_host.py's per-host buffering.
            lines: list[str] = []
            log = lines.append
            results = run_multi_host(
                args, themes, refs_by_theme, op_pool, ed_pool, lang, log=log
            )
            lang_eps = report_multi_host(results, log=log) if results else {}
            return lang, lang_eps, lines

        out_eps: dict[str, dict] = {}
        with ThreadPoolExecutor(max_workers=max(1, len(langs))) as pool:
            # pool.map preserves submission order (not completion order), so
            # the printed blocks come out in the same order as --langs,
            # deterministically, even though the work itself ran concurrently.
            for lang, lang_eps, lines in pool.map(_run_lang, langs):
                print(f"\n=== lang={lang} ===")
                for line in lines:
                    print(line)
                for ep, kinds in lang_eps.items():
                    out_eps.setdefault(ep, {})[lang] = kinds

        # One consolidated table across every (ep, lang, host) once all
        # languages are in — the "tableau récapitulatif complet".
        print_final_recap(out_eps)
    else:
        langs = [args.lang]
        print(f"\nResolving {args.slug} {args.season}/{args.lang} "
              f"ep{args.start}-{args.end}…")
        eps = resolve_episodes(args.slug, args.season, args.lang,
                                args.start, args.end, host_pref=args.host)
        eps.sort(key=lambda e: e["ep"])
        if not eps:
            raise SystemExit("No episode resolved in that range.")
        print("Fetching audio (windowed) + fingerprinting (parallel, cached)…")
        results = run_single_host(args, themes, refs_by_theme, op_pool, ed_pool, eps)
        # single-host mode stays flat (episodes[ep] = {op, ed}) for backward
        # compatibility — it only ever runs one lang/one host at a time anyway.
        out_eps = report_single_host(results)

    if args.out:
        out_path = Path(args.out)
        existing: dict = {}
        if out_path.exists():
            try:
                existing = json.loads(out_path.read_text("utf-8"))
            except Exception as exc:
                print(f"  [warn] --out file exists but couldn't be parsed as JSON "
                      f"({exc}) — it will be REPLACED, not merged")
                existing = {}

        existing_eps = existing.get("episodes", {}) if isinstance(existing, dict) else {}
        merged_eps = dict(existing_eps)
        if args.multi_host:
            # Update per (episode, lang) — an episode/lang pair recomputed in
            # this run overwrites its old entry; every other episode/lang
            # combination already in the file (other episodes, or the other
            # lang for this same episode from a PREVIOUS run) is left intact.
            for ep, lang_data in out_eps.items():
                merged_eps.setdefault(ep, {})
                merged_eps[ep].update(lang_data)
        else:
            merged_eps.update(out_eps)

        # existing_langs lets you build up full lang coverage across several
        # invocations (e.g. one run with --langs vostfr,vf, then a later rerun
        # of just vf for a handful of episodes) without losing track of what
        # the file as a whole actually covers.
        existing_langs = existing.get("langs", []) if isinstance(existing, dict) else []
        all_langs = sorted(set(existing_langs) | set(langs))

        out = {
            "anilist_id": args.anilist,
            "animethemes_slug": at_slug,
            "slug": args.slug, "season": args.season,
            "langs": all_langs,
            "start": args.start, "end": args.end,
            "multi_host": args.multi_host,
            "episodes": merged_eps,
        }
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), "utf-8")
        n_new = sum(len(v) for v in out_eps.values()) if args.multi_host else len(out_eps)
        print(f"\n{n_new} episode/lang entr{'y' if n_new == 1 else 'ies'} updated "
              f"-> {out_path} ({len(merged_eps)} episode(s) total on file)")


if __name__ == "__main__":
    main()