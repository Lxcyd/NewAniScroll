"""Diagnostic: dump EVERY offset-histogram peak (all_matches, not just the
top one best_match/detect_op_ed would keep) between one episode's OP/ED
window and its AnimeThemes reference(s).

Use this when detect_anime.py's result looks wrong: it shows whether the
correct segment is present as a WEAKER secondary peak that best_match ignored
(a real bug to fix in scoring/selection), or whether the top peak itself is
simply misaligned (a different kind of bug, in the fingerprint/offset math).

Usage:
  python diag_match.py --anilist 16498 --slug shingeki-no-kyojin \
      --season saison1 --lang vostfr --ep 3 --kind ed
"""

from __future__ import annotations

import argparse
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from detect_anime import _probe_duration, load_theme_pools, refs_for_episode
from oped.adapter_aniscroll import resolve_episodes
from oped.audio import load_audio
from oped.fingerprint import fingerprint
from oped.matcher import all_matches
from oped.theme_bank import ED_WINDOW, OP_WINDOW


def ms(s: float) -> str:
    # Round to the NEAREST second (not floor): flooring biases every timecode
    # up to ~1s early. Round total seconds first, then divmod, so x:59.7 rolls
    # over to (x+1):00 instead of x:60.
    sign = "-" if s < 0 else ""
    s = round(abs(s))
    return f"{sign}{s // 60}:{s % 60:02d}"


def _measure_actual_window_start(url: str, window, referer: str | None) -> float | None:
    """Directly measure where ffmpeg's seek ACTUALLY landed, in the source's
    own absolute timeline — instead of trusting `ep_dur + start_s`.

    `-copyts` keeps original timestamps (rather than rebasing to 0), so the
    first decoded audio frame's `pts_time` after seeking IS the true absolute
    position ffmpeg used. If this disagrees with the nominal window offset we
    assumed (ep_dur - 180 etc.), that mismatch is a real, measurable bug in
    the abs-time conversion — not a matching problem.
    """
    if window is None:
        return None
    start_s, _dur = window
    if start_s is None:
        return None
    import subprocess

    cmd = ["ffprobe", "-v", "error", "-copyts"]
    if referer:
        cmd += ["-headers", f"Referer: {referer}\r\n"]
    cmd += (["-sseof", str(start_s)] if start_s < 0 else ["-ss", str(start_s)])
    cmd += [
        "-i", url,
        "-select_streams", "a:0",
        "-read_intervals", "%+#1",
        "-show_entries", "frame=pts_time",
        "-of", "default=nk=1:nw=1",
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        line = out.stdout.strip().splitlines()[0] if out.stdout.strip() else None
        return float(line) if line else None
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--anilist", type=int, required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--season", default="saison1")
    ap.add_argument("--lang", default="vostfr")
    ap.add_argument("--ep", type=int, required=True)
    ap.add_argument("--kind", choices=["op", "ed"], required=True)
    ap.add_argument("--host", default=None)
    ap.add_argument("--min-votes", type=int, default=15,
                     help="lower than detect_anime's default so weak/secondary "
                          "peaks are visible too (default: 15)")
    ap.add_argument("--full-episode", action="store_true",
                     help="decode the WHOLE episode instead of the short "
                          "OP/ED window (slower, but rules out a window that "
                          "simply doesn't cover the real segment)")
    args = ap.parse_args()

    _, themes, refs_by_theme, op_pool, ed_pool = load_theme_pools(args.anilist)

    op_refs, ed_refs, inferred_op, inferred_ed = refs_for_episode(
        themes, refs_by_theme, op_pool, ed_pool, args.ep
    )
    refs = op_refs if args.kind == "op" else ed_refs
    if not refs:
        raise SystemExit(f"No {args.kind} reference resolved for ep{args.ep}.")
    print(f"{args.kind} references for ep{args.ep}: "
          f"{[(r.slug, r.version, f'{r.duration:.1f}s') for r in refs]}"
          f"{'  (inferred/cour-fallback)' if (inferred_op if args.kind=='op' else inferred_ed) else ''}")

    print(f"\nResolving ep{args.ep}…")
    eps = resolve_episodes(args.slug, args.season, args.lang, args.ep, args.ep,
                            host_pref=args.host)
    if not eps:
        raise SystemExit("Episode did not resolve.")
    e = eps[0]
    ep_dur = _probe_duration(e["url"])
    print(f"  host={e.get('host')}  duration={ep_dur:.1f}s ({ms(ep_dur)})")

    if args.full_episode:
        win = None
        win_offset = 0.0
    else:
        win = OP_WINDOW if args.kind == "op" else ED_WINDOW
        start_s, _dur = win
        win_offset = 0.0 if start_s is None else (
            ep_dur + start_s if start_s < 0 else start_s
        )
    print(f"  window={win}  (nominal window-start in absolute episode time: "
          f"{ms(win_offset)})")

    measured = _measure_actual_window_start(e["url"], win, e.get("referer"))
    if measured is not None:
        delta = measured - win_offset
        print(f"  MEASURED actual seek landing (ffprobe -copyts): "
              f"{ms(measured)}  (assumed {ms(win_offset)}, delta {delta:+.1f}s)")
        if abs(delta) > 2.0:
            print("  ⚠ mismatch >2s between assumed and measured window start — "
                  "this alone would shift every reported abs timestamp by "
                  f"{delta:+.1f}s")

    base_key = f"{args.slug}/{args.season}/{args.lang}/ep{args.ep}"
    samples = load_audio(e["url"], cache_key=base_key, window=win,
                          referer=e.get("referer"))
    print(f"  decoded {len(samples) / 11025:.1f}s of audio")
    ep_fp = fingerprint(samples)

    print(f"\nAll offset-histogram peaks (min_votes={args.min_votes}), "
          f"query positions shown BOTH window-relative and absolute episode time:\n")
    hdr = (f"{'ref':>6}  {'votes':>6}  {'score':>7}  "
           f"{'q_start(win)':>13}  {'q_end(win)':>11}  "
           f"{'q_start(abs)':>13}  {'q_end(abs)':>13}  "
           f"{'r_start':>8}  {'r_end':>8}")
    print(hdr)
    print("-" * len(hdr))
    any_match = False
    for ref in refs:
        matches = all_matches(ep_fp, ref.fp, min_votes=args.min_votes)
        for m in matches:
            any_match = True
            abs_start = m.q_start + win_offset
            abs_end = m.q_end + win_offset
            print(f"{ref.slug:>6}  {m.n_votes:>6}  {m.score:>7.2f}  "
                  f"{ms(m.q_start):>13}  {ms(m.q_end):>11}  "
                  f"{ms(abs_start):>13}  {ms(abs_end):>13}  "
                  f"{m.r_start:>8.1f}  {m.r_end:>8.1f}")
    if not any_match:
        print(f"(no peak reached min_votes={args.min_votes} — try --full-episode "
              "or lower --min-votes)")


if __name__ == "__main__":
    main()
