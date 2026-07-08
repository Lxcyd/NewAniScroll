"""Full diagnostic: audio AND video signals, across EVERY resolvable host,
for BOTH OP and ED of one episode — the combined counterpart of
diag_multi_host.py (audio-only, per-host) and the video_fingerprint module
(video-only, no cross-host view).

For each host that resolves the episode:
  - runs the normal windowed audio detector (theme_bank.detect_op_ed)
  - ALSO fingerprints the episode's keyframes in the same OP/ED windows and
    matches them against the clean NC video reference (video_fingerprint.py)
  - flags whether the two signals AGREE (within --agree-tolerance seconds)

Then reconciles the AUDIO hits across hosts (oped.multi_host.reconcile_hits —
same duration-robust median/outlier logic as detect_anime.py --multi-host),
and reports, for that consensus timestamp, how many hosts had video
CONFIRMING it — a cheap independent cross-check on top of the frame-accurate
audio result, catching the failure modes audio alone can miss (VF dub ducking
the theme, a cold-open with no real music, a truncated fade-out on one host,
etc. — see oped/video_fingerprint.py's module docstring).

Usage:
  python diag_full.py --anilist 16498 --slug shingeki-no-kyojin \
      --season saison1 --ep 3 --mal 16498 \
      --va-slug shingeki-no-kyojin-vostfr

Note: --mal and --va-slug are only NEEDED to unlock the "megaplay" and
"vidmoly-va" hosts respectively (see adapter_aniscroll.resolve_episodes);
hosts missing their prerequisite are skipped, not fatal, exactly like
diag_multi_host.py and detect_anime.py --multi-host.
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from detect_anime import _probe_duration, clock, load_theme_pools, ms, refs_for_episode
from oped.adapter_aniscroll import MULTI_HOSTS, VF_INCOMPATIBLE_HOSTS, resolve_episodes
from oped.multi_host import HostStream, reconcile_hits
from oped.theme_bank import ED_WINDOW, OP_WINDOW, ThemeHit, cached_fingerprint, detect_op_ed
from oped.video_fingerprint import HAMMING_THRESHOLD, best_match_video, extract_keyframe_hashes


def _abs_offset(win, duration: float) -> float:
    """Same convention as theme_bank._abs_offset: convert a window's start
    into an absolute episode offset (negative start = -sseof, from the end).
    """
    if win is None:
        return 0.0
    start_s, _dur = win
    if start_s is None:
        return 0.0
    return duration + start_s if start_s < 0 else start_s


def build_video_refs(op_refs, ed_refs, at_slug: str) -> dict[tuple[str, int], object]:
    """Fingerprint the clean NC video for every distinct (slug, version)
    reference used by op_refs/ed_refs — built ONCE, shared across every host,
    same rationale as theme_bank.build_references for audio. Keyed exactly
    like the audio refs so the two line up 1:1 when matching an episode.
    """
    seen: dict[tuple[str, int], object] = {}
    all_refs = []
    for ref in op_refs + ed_refs:
        key = (ref.slug, ref.version)
        if key not in seen:
            seen[key] = None
            all_refs.append(ref)
    if not all_refs:
        return {}

    def _build(ref):
        key = f"animethemes/{at_slug}/{ref.slug}/v{ref.version}"
        vfp = extract_keyframe_hashes(ref.video_url, cache_key=key, cache_dir="cache/video")
        return (ref.slug, ref.version), vfp

    out: dict[tuple[str, int], object] = {}
    with ThreadPoolExecutor(max_workers=max(1, len(all_refs))) as pool:
        for k, vfp in pool.map(_build, all_refs):
            out[k] = vfp
    return out


def _video_match_for_host(
    e: dict, host: str, ep: int, refs, video_refs, win, duration: float,
    *, min_votes: int, hamming: int,
):
    """Decode this host's keyframes in `win` and match against every version
    of `refs`' clean NC video, keeping the strongest. Returns
    (result_dict_or_None, error_str_or_None) — mirrors the audio path's
    tolerance for a single failed host without sinking the whole run.
    """
    win_offset = _abs_offset(win, duration)
    base_key = f"video/{host}/ep{ep}"
    try:
        q_vfp = extract_keyframe_hashes(
            e["url"], cache_key=base_key, cache_dir="cache/video",
            referer=e.get("referer"), window=win,
        )
    except Exception as exc:
        return None, f"video decode failed — {exc}"

    best = None
    for ref in refs:
        r_vfp = video_refs.get((ref.slug, ref.version))
        if r_vfp is None or r_vfp.hashes.size == 0:
            continue
        m = best_match_video(q_vfp, r_vfp, hamming_threshold=hamming, min_votes=min_votes)
        if m is None:
            continue
        if best is None or m.n_votes > best[1].n_votes:
            best = (ref, m)
    if best is None:
        return None, None
    ref, m = best
    return {
        "slug": ref.slug, "version": ref.version,
        "abs_start": m.q_start + win_offset, "abs_end": m.q_end + win_offset,
        "votes": m.n_votes, "score": m.score,
    }, None


def _process_host(args, host: str, op_refs, ed_refs, video_refs):
    """Resolve + probe + audio-detect + video-detect ONE host. Runs in a
    worker thread (I/O-bound throughout — subprocess + network waits), same
    pattern as diag_multi_host.py's _process_host.

    Returns (log_lines, (HostStream, audio_by_kind, video_by_kind) | None).
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
        ep_dur = _probe_duration(e["url"], referer=e.get("referer"))
    except Exception as exc:
        log.append(f"  {actual_host}: probe failed — {exc}")
        return log, None

    stream = HostStream(host=actual_host, url=e["url"], duration=ep_dur)
    base_key = f"{args.slug}/{args.season}/{args.lang}/{actual_host}/ep{args.ep}"

    def resolve_window(win):
        fp, _dur = cached_fingerprint(base_key, e["url"], "cache/audio",
                                       window=win, referer=e.get("referer"))
        return fp

    try:
        audio_hits = detect_op_ed(
            resolve_window, ep_dur, op_refs, ed_refs,
            op_window=OP_WINDOW, ed_window=ED_WINDOW,
            min_votes=args.min_votes,
        )
    except Exception as exc:
        log.append(f"  {actual_host}: audio detection failed — {exc}")
        audio_hits = []
    audio_by_kind: dict[str, ThemeHit] = {h.kind: h for h in audio_hits}

    video_by_kind: dict[str, dict | None] = {}
    for kind, refs, win in (("op", op_refs, OP_WINDOW), ("ed", ed_refs, ED_WINDOW)):
        if not refs:
            continue
        v, err = _video_match_for_host(
            e, actual_host, args.ep, refs, video_refs, win, ep_dur,
            min_votes=args.video_min_votes, hamming=args.hamming,
        )
        if err:
            log.append(f"  {actual_host} [{kind}] video: {err}")
        video_by_kind[kind] = v

    log.append(f"  {actual_host}: resolved, duration {ep_dur:.1f}s ({ms(ep_dur)})")
    return log, (stream, audio_by_kind, video_by_kind)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--anilist", type=int, required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--season", default="saison1")
    ap.add_argument("--lang", default="vostfr")
    ap.add_argument("--ep", type=int, required=True)
    ap.add_argument("--hosts", default=None,
                     help="comma list (default: all of MULTI_HOSTS)")
    ap.add_argument("--mal", default=None,
                     help="MAL id — required to reach the 'megaplay' host")
    ap.add_argument("--va-slug", default=None,
                     help="voir-anime slug — required to reach 'vidmoly-va'")
    ap.add_argument("--min-votes", type=int, default=40,
                     help="audio min votes (default: 40, same as detect_anime.py)")
    ap.add_argument("--video-min-votes", type=int, default=50,
                     help="video min votes — real matches land at 130-250 votes "
                          "while spurious clusters top out ~25, so 50 cleanly "
                          "separates them (default: 50)")
    ap.add_argument("--hamming", type=int, default=HAMMING_THRESHOLD,
                     help=f"max Hamming distance (bits/64) for two keyframe "
                          f"hashes to 'match' (default: {HAMMING_THRESHOLD})")
    ap.add_argument("--agree-containment", type=float, default=0.7,
                     help="min fraction of the VIDEO span that must fall inside "
                          "the audio span to call them 'in agreement'. Video "
                          "confirms audio when the visual slice lands INSIDE the "
                          "music span (video ⊆ audio), even if video caught a "
                          "shorter slice (default: 0.7)")
    ap.add_argument("--workers", type=int, default=5)
    args = ap.parse_args()

    hosts = args.hosts.split(",") if args.hosts else MULTI_HOSTS
    if args.lang != "vostfr":
        dropped = [h for h in hosts if h in VF_INCOMPATIBLE_HOSTS]
        if dropped:
            print(f"[info] lang={args.lang!r}: skipping {dropped} — no lang "
                  f"signal in their embed construction\n")
        hosts = [h for h in hosts if h not in VF_INCOMPATIBLE_HOSTS]

    at_slug, themes, refs_by_theme, op_pool, ed_pool = load_theme_pools(args.anilist)
    op_refs, ed_refs, inferred_op, inferred_ed = refs_for_episode(
        themes, refs_by_theme, op_pool, ed_pool, args.ep
    )
    if not op_refs and not ed_refs:
        raise SystemExit(f"No OP/ED reference resolved for ep{args.ep}.")

    print("Building video keyframe references (clean NC clip, cached)…")
    video_refs = build_video_refs(op_refs, ed_refs, at_slug)
    print(f"  {len(video_refs)} version(s) fingerprinted for video\n")

    print(f"Trying hosts: {hosts}\n")
    per_host_audio: list[tuple[HostStream, list[ThemeHit]]] = []
    # video_summary[kind] = [(host, audio_hit|None, video_hit_dict|None, agree|None), …]
    video_summary: dict[str, list] = {"op": [], "ed": []}

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {
            pool.submit(_process_host, args, host, op_refs, ed_refs, video_refs): host
            for host in hosts
        }
        # Submission-order printing keeps output deterministic across runs
        # despite the work itself running concurrently (same as diag_multi_host.py).
        for host in hosts:
            fut = next(f for f, h in futures.items() if h == host)
            log, result = fut.result()
            for line in log:
                print(line)
            if result is None:
                continue
            stream, audio_by_kind, video_by_kind = result
            per_host_audio.append((stream, list(audio_by_kind.values())))

            for kind in ("op", "ed"):
                a = audio_by_kind.get(kind)
                v = video_by_kind.get(kind)
                if a is None and v is None:
                    continue
                agree = None
                if a is not None and v is not None:
                    # Audio (music span) and video (visual span) of an OP/ED do
                    # NOT start at the same instant, NOR cover the same length —
                    # an ED's picture may run over dialogue before the song
                    # enters, one host's video match may catch only the back half
                    # of the sequence, etc. So neither start-equality nor
                    # symmetric IoU is the right test. What "video confirms audio"
                    # really means: the video slice lands INSIDE the audio span
                    # (video ⊆ audio). We measure containment = fraction of the
                    # VIDEO interval that overlaps the audio interval; a high
                    # value means the video saw the same segment the audio did,
                    # even if it saw a shorter slice of it.
                    ov_lo = max(a.start, v["abs_start"])
                    ov_hi = min(a.end, v["abs_end"])
                    inter = max(0.0, ov_hi - ov_lo)
                    v_len = max(1e-6, v["abs_end"] - v["abs_start"])
                    containment = inter / v_len
                    agree = containment >= args.agree_containment
                video_summary[kind].append((stream.host, a, v, agree))

    print("\n" + "=" * 100)
    print("Per-host audio vs video (raw, before cross-host reconciliation):\n")
    hdr = (f"{'host':>9}  {'kind':>4}  {'audio(abs)':>13}  {'a.votes':>7}  "
           f"{'video(abs)':>13}  {'v.votes':>7}  {'agree':>6}")
    print(hdr)
    print("-" * len(hdr))
    for kind in ("op", "ed"):
        for host, a, v, agree in video_summary[kind]:
            a_str = clock((a.start, a.end)) if a else "no match"
            a_votes = a.votes if a else "-"
            v_str = clock((v["abs_start"], v["abs_end"])) if v else "no match"
            v_votes = v["votes"] if v else "-"
            agree_str = "-" if agree is None else ("YES" if agree else "NO !")
            print(f"{host:>9}  {kind:>4}  {a_str:>13}  {a_votes!s:>7}  "
                  f"{v_str:>13}  {v_votes!s:>7}  {agree_str:>6}")

    print("\n" + "=" * 100)
    print("Cross-host reconciled result (audio-anchored, frame-accurate):\n")
    reconciled = reconcile_hits(per_host_audio)
    if not reconciled:
        print("  (no consensus — no host produced a usable audio match)")

    hdr2 = (f"{'kind':>4}  {'recovered':>13}  {'votes':>6}  {'hosts agree':>12}  "
            f"{'spread':>7}  {'video confirms':>15}")
    print(hdr2)
    print("-" * len(hdr2))
    for h in reconciled:
        vs = video_summary.get(h.kind, [])
        n_checked = sum(1 for _h, _a, _v, agree in vs if agree is not None)
        n_agree = sum(1 for _h, _a, _v, agree in vs if agree)
        confirm_str = f"{n_agree}/{n_checked} hosts" if n_checked else "no video signal"
        agree_col = f"{h.n_hosts_agree}/{h.n_hosts_total}"
        print(f"{h.kind:>4}  {clock((h.start, h.end)):>13}  {h.votes:>6}  "
              f"{agree_col:>12}  {h.spread_s:>6.1f}s  {confirm_str:>15}")
        if n_checked and n_agree < n_checked:
            print(f"      ⚠ video DISAGREES on {n_checked - n_agree} host(s) for "
                  f"{h.kind} — worth a manual check (see per-host table above)")

    inferred_note = []
    if inferred_op:
        inferred_note.append("op")
    if inferred_ed:
        inferred_note.append("ed")
    if inferred_note:
        print(f"\n(* {'/'.join(inferred_note)} matched via cour fallback — "
              f"no direct AnimeThemes episode mapping for ep{args.ep})")


if __name__ == "__main__":
    main()