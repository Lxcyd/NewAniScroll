"""Replay the F1 self-reference guard over CACHED fingerprints — no network.

The batch run only ever reports F1's verdict ("no repeated segment across
[2,3,4]"), which conflates two very different situations: the matcher found
nothing, or the matcher found the theme cleanly and a GUARD threw it away. On
the 15-anime audit that distinction was the whole story — 10 anime lost their
OP to the second case.

This replays `find_segment` against `cache/audio/*.fp.npz`, whose filenames
already carry the window's absolute start, so an anime the batch has processed
once can be re-evaluated in milliseconds with a different threshold. Use it to
justify a guard change with evidence instead of intuition.

Usage:
  python _replay_selfref.py                 # every cached anime, op + ed
  python _replay_selfref.py --kind op --verbose
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped import self_ref
from oped.fingerprint import Fingerprint

CACHE = Path("cache/audio")

# absa__<slug>__<season>__<lang>__ep<N>__<host>.abs<start>_<dur>.fp.npz
NAME_RE = re.compile(
    r"^absa__(?P<slug>[^_]+(?:_[^_]+)*?)__(?P<season>[^_]+)__(?P<lang>[^_]+)__"
    r"ep(?P<ep>\d+)__(?P<host>[^.]+)\.abs(?P<start>[\d.]+)_(?P<dur>[\d.]+)\.fp\.npz$"
)


def load_fp(path: Path) -> Fingerprint:
    d = np.load(path)
    return Fingerprint(**{k: d[k] for k in d.files})


def scan() -> dict[tuple, dict[int, tuple[Path, float]]]:
    """{(slug, season, lang, host, kind, win_dur): {episode: (path, win_start)}}.

    The OP window is the one starting at 0.0 (OP_SEARCH 0-300); anything with a
    late absolute start is the ED window.

    The window DURATION is part of the key: F2/F3 retry some episodes with a
    widened window (dandadan ep4 has both an `abs0.0_300.0` and an
    `abs0.0_720.0`), and folding those together let one episode's 720 s window
    overwrite another's 300 s one. The result was a "recovered" OP sitting at
    393 s — outside the 300 s window the other episodes were even allowed to
    see. That was this harness mixing incomparable windows, not the detector.
    """
    out: dict[tuple, dict[int, tuple[Path, float]]] = defaultdict(dict)
    for p in CACHE.glob("*.fp.npz"):
        m = NAME_RE.match(p.name)
        if not m:
            continue
        start = float(m["start"])
        kind = "op" if start < 1.0 else "ed"
        key = (m["slug"], m["season"], m["lang"], m["host"], kind, float(m["dur"]))
        out[key][int(m["ep"])] = (p, start)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=["op", "ed"], default=None)
    ap.add_argument("--tolerance", type=float, default=None,
                    help="override POSITION_TOLERANCE_S for this replay")
    ap.add_argument("--verbose", action="store_true",
                    help="show per-episode positions and the pairwise spans")
    args = ap.parse_args()

    if args.tolerance is not None:
        self_ref.POSITION_TOLERANCE_S = args.tolerance

    groups = scan()
    if not groups:
        raise SystemExit(f"no cached fingerprints under {CACHE}/")

    n_ok = n_ko = 0
    for key in sorted(groups):
        slug, season, lang, host, kind, win_dur = key
        if args.kind and kind != args.kind:
            continue
        eps = groups[key]
        if len(eps) < 2:
            continue

        fps = {ep: (load_fp(p), base) for ep, (p, base) in sorted(eps.items())}

        # The ED path compares positions FROM THE END, so it needs each
        # episode's duration. The ED window runs to EOF by construction
        # (`-sseof`), so its absolute start plus its decoded length IS the
        # duration — no probe, and it is the same arithmetic the detector used
        # to place the window in the first place. Without this the replay
        # silently fell through to the OP branch and mis-reported the ED.
        durations = ({ep: base + win_dur for ep, (_p, base) in fps.items()}
                     if kind == "ed" else None)
        seg = self_ref.find_segment(kind, fps, duration_by_ep=durations)
        tag = f"{slug:<20} {kind}  {host:<11} w{win_dur:<5.0f}"

        if seg is not None:
            n_ok += 1
            print(f"OK    {tag} {seg.length:6.1f}s  support {seg.support}"
                  f"  positions {seg.positions}")
            continue

        n_ko += 1
        # Explain WHY, by redoing the two stages find_segment folds together.
        spans = self_ref._pairwise_spans(fps)
        per_ep = {}
        for ep, obs in spans.items():
            if not obs:
                continue
            center, n = self_ref._agree([s for s, _ in obs], tol=2.0)
            if n:
                lens = [ln for s, ln in obs if abs(s - center) <= 2.0]
                per_ep[ep] = (center, float(np.median(lens)))
        if len(per_ep) < self_ref.MIN_SUPPORT:
            why = f"only {len(per_ep)} episode(s) carried a segment"
        else:
            # Show the criterion that actually decided (from-end for an ED,
            # length for an OP) alongside the other, so a rejection can be read
            # as "the guard was right" vs "the guard picked the wrong invariant".
            if kind == "ed" and durations:
                pos = [durations[e] - per_ep[e][0] for e in sorted(per_ep)]
                pos_label = "from-end"
            else:
                pos = [per_ep[e][0] for e in sorted(per_ep)]
                pos_label = "position"
            lens = [per_ep[e][1] for e in sorted(per_ep)]
            _c, sup = self_ref._agree(pos, tol=self_ref.POSITION_TOLERANCE_S)
            _lc, lsup = self_ref._agree(lens, tol=self_ref.LENGTH_TOLERANCE_S)
            why = (f"{pos_label} cluster {sup}/{len(per_ep)} "
                   f"(spread {max(pos) - min(pos):.0f}s) "
                   f"| length cluster {lsup}/{len(per_ep)} "
                   f"(lengths {[round(x) for x in lens]})")
        print(f"KO    {tag} {why}")
        if args.verbose:
            for ep, obs in sorted(spans.items()):
                print(f"        ep{ep}: " +
                      ", ".join(f"{s:.1f}s/{ln:.1f}s" for s, ln in obs))

    print(f"\n{n_ok} recovered, {n_ko} rejected "
          f"(POSITION_TOLERANCE_S={self_ref.POSITION_TOLERANCE_S})")


if __name__ == "__main__":
    main()
