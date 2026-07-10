"""Per-(host, language) OP/ED probe — the FULL detection pipeline run once for
every (host x lang) cell, each reported separately.

This is the diagnostic you want when the question is not "what does the
reconciled skip time end up being" (that's detect_anime.py's multi-host path)
but "what does EACH player, in EACH language, individually deliver — and did
the image have to extend a cropped fade edge to get there?".

Difference from diag_multi_host.py:
  - diag_multi_host.py runs only the raw MATCHER (all_matches) for ONE lang and
    ONE kind, reporting votes/score and the measured seek window. It is a
    lower-level alignment diagnostic (is the abs-offset conversion right? does a
    host trim content?).
  - diag_per_host.py runs the SAME production pipeline as the app —
    theme_bank.detect_op_ed, including refine (RMS onset/cut snap) and the
    video fade-edge extension — so each cell shows the DELIVERED start/end plus
    where each edge came from: "audio" (raw projection kept), "video" (image
    extended a cropped fade), or "rms" (music onset/cut snap). That last column
    is the "image extension and source" — it tells you, per player and per
    language, whether the few seconds at an edge are audio-accurate or were
    recovered from the image because the audio fade was clipped.

Matrix: for each requested host, both vostfr AND vf are probed (unless --lang
pins one). VF_INCOMPATIBLE_HOSTS (megaplay) are dropped from the vf column with
a note — their embed carries no lang signal, so a "vf" pin would silently
re-serve the vostfr encode (see adapter_aniscroll.py).

Usage:
  python diag_per_host.py --anilist 16498 --slug shingeki-no-kyojin \
      --season saison1 --ep 3 --kind ed \
      --mal 16498 --va-slug shingeki-no-kyojin-vostfr

  # one language only, a subset of hosts, OP instead of ED:
  python diag_per_host.py --anilist 16498 --slug shingeki-no-kyojin \
      --ep 3 --kind op --lang vostfr --hosts sibnet,vidmoly,uqload

Note: the --va-slug is language-specific on voir-anime (…-vostfr vs …-vf). When
both languages are probed and only a vostfr va-slug is given, the vf vidmoly-va
cell is skipped with a note (pass --va-slug-vf to cover it).
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from detect_anime import (
    _probe_duration,
    load_theme_pools,
    ms,
    refs_for_episode,
)
from oped.adapter_aniscroll import (
    MULTI_HOSTS,
    VF_INCOMPATIBLE_HOSTS,
    resolve_episodes,
)
from oped.audio import load_audio
from oped.theme_bank import (
    ED_WINDOW,
    OP_WINDOW,
    ThemeHit,
    cached_fingerprint,
    detect_op_ed,
)
from oped.video_fingerprint import extract_keyframe_hashes


def _probe_cell(args, host: str, lang: str, refs_bundle) -> tuple[list[str], dict | None]:
    """Resolve ONE (host, lang) stream and run the full detect_op_ed pipeline on
    it. Returns (log_lines, row) so the caller can flush each cell's output as a
    contiguous block (concurrent cells would otherwise interleave their prints).

    Every step is I/O-bound (Node bridge subprocess, ffprobe/ffmpeg pulls, their
    network waits), so this runs safely under a thread pool despite the GIL.
    """
    tag = f"{host}/{lang}"
    log: list[str] = []
    op_refs, ed_refs, inferred_op, inferred_ed = refs_bundle

    if host == "megaplay" and not args.mal:
        return [f"  {tag}: skipped — needs --mal <malId>"], None
    if host == "vidmoly-va":
        # A single voir-anime page-slug frequently carries BOTH languages (e.g.
        # SnK S1 lives at .../anime/shingeki-no-kyojin/ with -N-vostfr AND -N-vf
        # episode URLs under it; the -vostfr-suffixed slug 404s). So fall back to
        # the OTHER language's slug when this one wasn't given, rather than
        # skipping — the bridge picks the right episode URL by language anyway.
        va = (args.va_slug if lang == "vostfr" else args.va_slug_vf) \
            or args.va_slug_vf or args.va_slug
        if not va:
            return [f"  {tag}: skipped — needs --va-slug / --va-slug-vf "
                    f"<voir-anime slug>"], None
    else:
        va = args.va_slug if lang == "vostfr" else args.va_slug_vf

    try:
        eps = resolve_episodes(
            args.slug, args.season, lang, args.ep, args.ep,
            host_pref=host, mal_id=args.mal, va_slug=va,
        )
    except Exception as exc:
        return [f"  {tag}: resolve failed — {exc}"], None
    if not eps:
        return [f"  {tag}: no stream resolved"], None

    e = eps[0]
    actual_host = e.get("host", host)
    url = e["url"]
    referer = e.get("referer")
    # Key includes lang so vostfr/vf never share a cache entry for the same host.
    base_key = f"{args.slug}/{args.season}/{lang}/{actual_host}/ep{args.ep}"

    # uqload's master-m3u8 token is single-use/IP-bound: the FIRST ffmpeg pull
    # consumes it, so every later pull on the same URL (and the vostfr/vf sibling
    # cell, whose embed is identical) 403s. For uqload we therefore re-resolve a
    # FRESH url on demand for each pull, bypassing the URL cache (cache_dir set to
    # a throwaway path so resolve_episodes always re-hits the bridge). Other hosts
    # keep the single stable url (their tokens survive repeated pulls).
    is_uqload = actual_host == "uqload"

    def fresh_url() -> str:
        if not is_uqload:
            return url
        fresh = resolve_episodes(
            args.slug, args.season, lang, args.ep, args.ep,
            host_pref=host, mal_id=args.mal, va_slug=va,
            cache_dir="cache/urls_nocache_uqload",
        )
        return fresh[0]["url"] if fresh else url

    def resolve_window(win):
        fp, _dur = cached_fingerprint(
            base_key, fresh_url(), "cache/audio", window=win, referer=referer
        )
        return fp

    def resolve_samples(win):
        return load_audio(
            fresh_url(), cache_key=base_key, cache_dir="cache/audio",
            window=win, referer=referer,
        )

    def resolve_video(win):
        return extract_keyframe_hashes(
            fresh_url(), cache_key=f"video/{base_key}", cache_dir="cache/video",
            window=win, referer=referer,
        )

    try:
        ep_dur = _probe_duration(fresh_url(), referer=referer)
        # Only compute the kind the user asked for: pass empty refs for the
        # other so detect_op_ed skips it (and its decode) entirely.
        hits = detect_op_ed(
            resolve_window, ep_dur,
            op_refs if args.kind == "op" else [],
            ed_refs if args.kind == "ed" else [],
            resolve_samples=resolve_samples,
            resolve_video=(resolve_video if args.video else None),
            op_window=OP_WINDOW, ed_window=ED_WINDOW,
            min_votes=args.min_votes, min_score=args.min_score,
            refine=not args.no_refine,
        )
    except Exception as exc:
        return [f"  {tag}: fetch/detect failed — {exc}"], None

    hit: ThemeHit | None = next((h for h in hits if h.kind == args.kind), None)
    row = {
        "host": actual_host, "lang": lang, "duration": ep_dur,
        "ext": args.video, "hit": hit,
        "inferred": inferred_op if args.kind == "op" else inferred_ed,
    }
    if hit is None:
        log.append(f"  {tag}: resolved ({ep_dur/60:.1f} min) — no {args.kind} hit")
    else:
        log.append(
            f"  {tag}: resolved ({ep_dur/60:.1f} min) — {args.kind} "
            f"{ms(hit.start)}-{ms(hit.end)} "
            f"[align={hit.source}, edges={hit.edge_start_source}/{hit.edge_end_source}]"
        )
    return log, row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--anilist", type=int, required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--season", default="saison1")
    ap.add_argument("--ep", type=int, required=True)
    ap.add_argument("--kind", choices=["op", "ed"], required=True)
    ap.add_argument("--lang", default=None,
                    help="pin ONE language (vostfr|vf); default probes BOTH")
    ap.add_argument("--hosts", default=None,
                    help="comma list (default: all of MULTI_HOSTS)")
    ap.add_argument("--mal", default=None,
                    help="MAL id — required for the 'megaplay' host")
    ap.add_argument("--va-slug", default=None,
                    help="voir-anime VOSTFR slug (e.g. shingeki-no-kyojin-vostfr) "
                         "— required to probe 'vidmoly-va' in vostfr")
    ap.add_argument("--va-slug-vf", default=None,
                    help="voir-anime VF slug — required to probe 'vidmoly-va' in vf")
    ap.add_argument("--video", action="store_true",
                    help="enable the video fade-edge extension pass (needed for "
                         "the edges=video column to ever appear); slower")
    ap.add_argument("--no-refine", action="store_true",
                    help="disable the RMS onset/cut snap (edges=rms)")
    ap.add_argument("--min-votes", type=int, default=40)
    ap.add_argument("--min-score", type=float, default=0.0)
    ap.add_argument("--workers", type=int, default=8,
                    help="parallel (host, lang) cells (default: 8)")
    args = ap.parse_args()

    hosts = args.hosts.split(",") if args.hosts else list(MULTI_HOSTS)
    langs = [args.lang] if args.lang else ["vostfr", "vf"]

    # Build the (host, lang) grid, dropping lang-incompatible hosts from vf with
    # a note rather than silently reporting a mislabeled stream.
    cells: list[tuple[str, str]] = []
    for lang in langs:
        for host in hosts:
            if lang != "vostfr" and host in VF_INCOMPATIBLE_HOSTS:
                print(f"[info] {host}/{lang}: dropped — no lang signal in its embed "
                      f"construction (adapter_aniscroll.py), would risk a mislabeled "
                      f"VOSTFR stream reported as {lang}")
                continue
            cells.append((host, lang))

    # Theme refs depend only on (anilist, ep), not host/lang — resolve once and
    # reuse across every cell.
    _, themes, refs_by_theme, op_pool, ed_pool = load_theme_pools(args.anilist)
    op_refs, ed_refs, inferred_op, inferred_ed = refs_for_episode(
        themes, refs_by_theme, op_pool, ed_pool, args.ep
    )
    refs_bundle = (op_refs, ed_refs, inferred_op, inferred_ed)
    if (args.kind == "op" and not op_refs) or (args.kind == "ed" and not ed_refs):
        raise SystemExit(f"No {args.kind} reference resolved for ep{args.ep}.")

    print(f"\nProbing {len(cells)} cell(s): {cells}")
    if not args.video:
        print("[note] --video off → the 'edges=video' image-extension pass is "
              "disabled; edges will only read audio/rms. Add --video to see "
              "whether the image extended a cropped fade.")
    print()

    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {
            pool.submit(_probe_cell, args, host, lang, refs_bundle): (host, lang)
            for host, lang in cells
        }
        # Flush in submission order for deterministic output despite parallelism.
        for host, lang in cells:
            fut = next(f for f, hl in futures.items() if hl == (host, lang))
            log, row = fut.result()
            for line in log:
                print(line)
            if row is not None:
                rows.append(row)

    print("\n" + "=" * 108)
    hdr = (f"{'host':>10}  {'lang':>6}  {'duration':>9}  {'kind':>4}  "
           f"{'delivered':>17}  {'align':>6}  {'edge start':>10}  {'edge end':>10}  "
           f"{'infer':>5}")
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        hit: ThemeHit | None = r["hit"]
        if hit is None:
            delivered = "no hit"
            align = start_src = end_src = "-"
        else:
            delivered = f"{ms(hit.start)}-{ms(hit.end)}"
            align = hit.source
            start_src = hit.edge_start_source
            end_src = hit.edge_end_source
        infer = "yes" if r["inferred"] else ""
        print(f"{r['host']:>10}  {r['lang']:>6}  {r['duration']:>8.1f}s  "
              f"{args.kind:>4}  {delivered:>17}  {align:>6}  {start_src:>10}  "
              f"{end_src:>10}  {infer:>5}")

    print("\nRead the two edge columns as the 'image extension' answer:")
    print("  audio = the boundary is the raw reference projection (frame-accurate)")
    print("  rms   = snapped to the music onset/cut (still audio-derived)")
    print("  video = the AUDIO fade was cropped here, so the IMAGE extended the")
    print("          edge out to the theme length — the extra seconds come from")
    print("          the picture, not the audio. Only possible with --video.")
    print("Compare 'delivered' across hosts/langs: same encode should agree; a "
          "host that trims/pads content will diverge, and a VF cell can differ "
          "from its VOSTFR sibling when the dub ducks the theme under dialogue.")


if __name__ == "__main__":
    main()
