"""Run OP/ED detection on ONE episode across EVERY resolvable host (not just
Sibnet), each reported separately — no reconciliation, so you can see exactly
what each player individually produces.

This is the multi-host counterpart of diag_match.py: instead of trusting
detect_op_ed_multi's consensus, it shows the raw per-host result (best match
+ the measured actual seek position) side by side, which is what you need to
tell apart:
  - a bug that's the SAME on every host (a code bug, e.g. the abs-offset
    conversion) from
  - a bug that's specific to ONE host (e.g. Sibnet inserting/trimming a few
    seconds of content that other hosts don't have).

Hosts covered (MULTI_HOSTS): sibnet, sendvid, megaplay, vidmoly (anime-sama
source) and vidmoly-va (voir-anime source). vidmoly's IP-bound token is kept
valid by routing the ffmpeg pull through the CF Worker (see wrapWorkerM3U8 in
bridge/resolve.mjs). megaplay needs --mal <malId>; vidmoly-va needs
--va-slug <voir-anime-slug>; hosts missing their prerequisite are skipped.

Note: megaplay's embed URL is built directly from a MAL id + episode number
(see adapter_aniscroll.resolve_episodes docstring) — there is no `lang`
signal in that construction, so pinning megaplay in a `--lang vf` run is NOT
guaranteed to actually return a French track. Treat a megaplay result as
VOSTFR-only until bridge/resolve.mjs is confirmed to branch on language for
that host.

Usage:
  python diag_multi_host.py --anilist 16498 --slug shingeki-no-kyojin \
      --season saison1 --lang vostfr --ep 3 --kind ed \
      --mal 16498 --va-slug shingeki-no-kyojin-vostfr
  python diag_multi_host.py --anilist 16498 --slug shingeki-no-kyojin \
      --ep 3 --kind ed --hosts sibnet,vidmoly
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from detect_anime import _probe_duration, load_theme_pools, refs_for_episode
from diag_match import _measure_actual_window_start, _window_offset, ms
from oped.adapter_aniscroll import MULTI_HOSTS, VF_INCOMPATIBLE_HOSTS, resolve_episodes
from oped.audio import load_audio
from oped.fingerprint import fingerprint
from oped.matcher import all_matches
from oped.theme_bank import ED_WINDOW, OP_WINDOW


def _process_host(args, host: str, refs, win, start_s) -> tuple[list[str], dict | None]:
    """Resolve + probe + decode + match ONE host. Runs in a worker thread —
    every step here is I/O-bound (subprocess for the Node bridge and for
    ffprobe/ffmpeg, plus their own network waits), so threads give real
    wall-clock speedup here despite the GIL: it's released during
    subprocess.run() and socket I/O.

    Returns (log_lines, row) instead of printing directly, so the caller can
    flush one host's output as a contiguous block once it finishes — avoids
    interleaved/garbled prints from concurrent hosts.
    """
    log: list[str] = []
    if host == "megaplay" and not args.mal:
        log.append(f"  {host}: skipped — needs --mal <malId>")
        return log, None
    if host == "vidmoly-va" and not args.va_slug:
        log.append(f"  {host}: skipped — needs --va-slug <voir-anime-slug>")
        return log, None
    try:
        eps = resolve_episodes(args.slug, args.season, args.lang,
                                args.ep, args.ep, host_pref=host,
                                mal_id=args.mal, va_slug=args.va_slug)
    except Exception as exc:
        log.append(f"  {host}: resolve failed — {exc}")
        return log, None
    if not eps:
        log.append(f"  {host}: no stream resolved")
        return log, None
    e = eps[0]
    actual_host = e.get("host", host)
    try:
        # NOTE: referer MUST be forwarded here, same as in the two
        # call-sites inside detect_anime.py. Without it, hosts that need
        # a Referer header (megaplay's mewstream/zapora CDN) fail probing
        # and silently fall back to the bogus 24*60 = 1440.0s duration —
        # this was the actual bug behind megaplay's wrong ED timing.
        ep_dur = _probe_duration(e["url"], referer=e.get("referer"))
        measured = _measure_actual_window_start(e["url"], win, e.get("referer"))
        base_key = f"{args.slug}/{args.season}/{args.lang}/{actual_host}/ep{args.ep}"
        samples = load_audio(e["url"], cache_key=base_key, window=win,
                              referer=e.get("referer"))
        win_offset = _window_offset(win, ep_dur, len(samples) / 11025)
        ep_fp = fingerprint(samples)
    except Exception as exc:
        log.append(f"  {actual_host}: fetch/decode failed — {exc}")
        return log, None

    best = None
    for ref in refs:
        for m in all_matches(ep_fp, ref.fp, min_votes=args.min_votes):
            if best is None or m.n_votes > best[1].n_votes:
                best = (ref, m)

    row = {
        "host": actual_host, "duration": ep_dur,
        "win_offset": win_offset, "measured": measured,
    }
    if best is not None:
        ref, m = best
        row.update({
            "slug": ref.slug, "votes": m.n_votes, "score": m.score,
            "abs_start": m.q_start + win_offset, "abs_end": m.q_end + win_offset,
        })
    log.append(f"  {actual_host}: resolved, duration {ep_dur:.1f}s ({ms(ep_dur)})")
    return log, row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--anilist", type=int, required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--season", default="saison1")
    ap.add_argument("--lang", default="vostfr")
    ap.add_argument("--ep", type=int, required=True)
    ap.add_argument("--kind", choices=["op", "ed"], required=True)
    ap.add_argument("--hosts", default=None,
                     help="comma list (default: all of MULTI_HOSTS)")
    ap.add_argument("--mal", default=None,
                     help="MAL id — required for the 'megaplay' host")
    ap.add_argument("--va-slug", default=None,
                     help="voir-anime slug (e.g. shingeki-no-kyojin-vostfr) — "
                          "required for the 'vidmoly-va' host")
    ap.add_argument("--min-votes", type=int, default=15)
    ap.add_argument("--workers", type=int, default=5,
                     help="parallel hosts (default: 5, i.e. all hosts at once — "
                          "this is I/O-bound so there's little reason to cap it "
                          "below len(hosts) unless you're hitting rate limits)")
    args = ap.parse_args()

    hosts = args.hosts.split(",") if args.hosts else MULTI_HOSTS
    if args.lang != "vostfr":
        dropped = [h for h in hosts if h in VF_INCOMPATIBLE_HOSTS]
        if dropped:
            print(f"[info] lang={args.lang!r}: skipping {dropped} — no lang signal "
                  f"in their embed construction (see adapter_aniscroll.py), would "
                  f"risk reporting a mislabeled VOSTFR stream as VF\n")
        hosts = [h for h in hosts if h not in VF_INCOMPATIBLE_HOSTS]

    _, themes, refs_by_theme, op_pool, ed_pool = load_theme_pools(args.anilist)
    op_refs, ed_refs, inferred_op, inferred_ed = refs_for_episode(
        themes, refs_by_theme, op_pool, ed_pool, args.ep
    )
    refs = op_refs if args.kind == "op" else ed_refs
    if not refs:
        raise SystemExit(f"No {args.kind} reference resolved for ep{args.ep}.")

    win = OP_WINDOW if args.kind == "op" else ED_WINDOW
    start_s, _dur = win

    print(f"Trying hosts: {hosts}\n")
    rows = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {
            pool.submit(_process_host, args, host, refs, win, start_s): host
            for host in hosts
        }
        # Print in submission order (not completion order) so the output is
        # deterministic across runs, even though the work itself is parallel.
        for host in hosts:
            fut = next(f for f, h in futures.items() if h == host)
            log, row = fut.result()
            for line in log:
                print(line)
            if row is not None:
                rows.append(row)

    print("\n" + "=" * 100)
    hdr = (f"{'host':>9}  {'duration':>9}  {'assumed win':>11}  {'measured win':>12}  "
           f"{'delta':>7}  {'match(abs)':>13}  {'votes':>6}  {'score':>6}")
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        delta = "" if r["measured"] is None else f"{r['measured'] - r['win_offset']:+.1f}s"
        if "abs_start" in r:
            match_str = f"{ms(r['abs_start'])}-{ms(r['abs_end'])}"
            votes, score = r["votes"], f"{r['score']:.2f}"
        else:
            match_str, votes, score = "no match", "-", "-"
        measured_str = "n/a" if r["measured"] is None else ms(r["measured"])
        print(f"{r['host']:>9}  {r['duration']:>8.1f}s  {ms(r['win_offset']):>11}  "
              f"{measured_str:>12}  {delta:>7}  {match_str:>13}  {votes!s:>6}  {score!s:>6}")

    print("\nCompare 'match(abs)' start across hosts against what you observe on "
          "vidmoly (22:42, duration 24:14). If EVERY host shows the same "
          "assumed-vs-measured 'delta', the bug is systemic (fix the abs-offset "
          "conversion once). If only some hosts show a delta or a different "
          "match(abs), that host's encode itself differs (trimmed/padded content).")


if __name__ == "__main__":
    main()