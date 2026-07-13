"""Prototype: landmark-anchored ED localisation (offline, from cache).

Validates the plan's core claim BEFORE touching production code: pick a few
DISTINCTIVE frames in the credited ED reference, re-locate each inside the
episode's coarse ED window, and project a theme_t0. Because the ED window is
decoded with `-sseof 180`, window-relative time t maps to a duration-INDEPENDENT
anchor `from_end = 180 - t`. So the right validation is cross-host convergence of
`from_end(theme_t0)`: the anime-sama trio (sibnet/sendvid/vidmoly) is the
"perfect" reference; the question is whether landmark anchoring pulls megaplay
onto the same from_end as the trio (today it drifts ~5s on the audio snap).
"""

from __future__ import annotations

import glob
import sys

import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.video_fingerprint import VideoFingerprint, _popcount64

REF = "cache/video/animethemes__jujutsu_kaisen__ED1__v1+cred.vfp.npz"
WINDOW_S = 180.0  # ED window length (-sseof 180)


def _pairdist(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """(len(a), len(b)) Hamming distance matrix between two uint64 hash arrays."""
    return _popcount64(a[:, None] ^ b[None, :])


def distinctiveness(fp: VideoFingerprint, *, neighbor_guard_s: float = 0.75) -> np.ndarray:
    """Per-frame landmark score. Two ingredients, both from the dHash alone:

      detail  = min(popcount, 64-popcount) — bit balance. A flat card, a fade,
                a black frame has a degenerate (mostly-0) hash → low detail; a
                textured, high-contrast frame balances near 32 → high detail.
      unique  = min Hamming distance to every OTHER frame that isn't a temporal
                neighbour (within neighbor_guard_s). A frame with a near-twin
                elsewhere in the clip is ambiguous to re-locate; a frame with no
                twin has a sharp, unambiguous minimum in the episode search.

    Score = detail * unique (both must be high). Returned per frame, same order.
    """
    h, t = fp.hashes, fp.times
    n = len(h)
    pc = _popcount64(h)
    detail = np.minimum(pc, 64 - pc).astype(np.float64)

    dist = _pairdist(h, h).astype(np.float64)
    # Mask self and temporal neighbours so adjacent near-duplicate frames don't
    # count as "twins" that kill uniqueness.
    dt = np.abs(t[:, None] - t[None, :])
    dist[dt <= neighbor_guard_s] = np.inf
    unique = dist.min(axis=1)
    unique[~np.isfinite(unique)] = 0.0
    return detail * unique, detail, unique


def pick_landmarks(fp: VideoFingerprint, *, k: int = 3, edge_frac: float = 0.15):
    """Choose up to k landmarks: local maxima of distinctiveness, spread across
    the clip, forced to include one in the first `edge_frac` and one in the last
    `edge_frac` so the projection is anchored near both ends."""
    score, detail, unique = distinctiveness(fp)
    t = fp.times
    dur = t.max() - t.min() if len(t) else 0.0
    order = np.argsort(score)[::-1]  # best first

    picked: list[int] = []
    min_gap = max(dur / (k + 1), 8.0)

    def far_enough(i):
        return all(abs(t[i] - t[j]) >= min_gap for j in picked)

    for i in order:
        if len(picked) >= k:
            break
        if far_enough(i):
            picked.append(int(i))
    picked.sort(key=lambda i: t[i])
    return picked, score, detail, unique


def localize(ref: VideoFingerprint, ep: VideoFingerprint, r_idx: int):
    """Find the episode frame closest (Hamming) to reference frame r_idx.
    Returns (t_ep, min_dist, second_min_dist)."""
    d = _popcount64(ep.hashes ^ np.uint64(ref.hashes[r_idx]))
    j = int(np.argmin(d))
    best = int(d[j])
    # 2nd-best OUTSIDE a small temporal guard around the winner (uniqueness of
    # the localisation, not of the reference).
    guard = np.abs(ep.times - ep.times[j]) > 1.0
    second = int(d[guard].min()) if guard.any() else 64
    return float(ep.times[j]), best, second


def run_host(tag: str, path: str, ref: VideoFingerprint, picks, scores):
    ep = VideoFingerprint.load(path)
    print(f"\n── {tag}  (n={len(ep.hashes)}, t=[{ep.times.min():.1f}..{ep.times.max():.1f}])")
    offsets = []
    for r_idx in picks:
        r_time = float(ref.times[r_idx])
        t_ep, best, second = localize(ref, ep, r_idx)
        # theme_t0 in window-relative time = where ref frame 0 lands.
        t0_win = t_ep - r_time
        from_end = WINDOW_S - t0_win
        ok = best <= 8 and (second - best) >= 6
        offsets.append((from_end, best, second, ok, r_time, t_ep))
        flag = "OK " if ok else "REJ"
        print(f"   LM r={r_time:5.1f}s (score {scores[r_idx]:5.0f})  ->  ep t={t_ep:6.2f}  "
              f"dist={best:2d} 2nd={second:2d}  {flag}  theme_t0_fromEnd={from_end:6.2f}")
    acc = [o[0] for o in offsets if o[3]]
    if acc:
        med = float(np.median(acc))
        print(f"   => from_end(theme_t0) median = {med:.2f}s   (accepted {len(acc)}/{len(picks)})")
    else:
        print("   => no accepted landmark")


def main():
    ref = VideoFingerprint.load(REF)
    picks, score, detail, unique = pick_landmarks(ref, k=4)
    print("REFERENCE ED1 credited: %d frames, dur %.1fs" % (len(ref.hashes), ref.times.max()))
    print("Landmarks (r_time, score, detail, unique):")
    for i in picks:
        print(f"   r={ref.times[i]:5.1f}s  score={score[i]:6.0f}  detail={detail[i]:3.0f}  unique={unique[i]:3.0f}")

    hosts = {
        "sibnet": "cache/video/video__jujutsu-kaisen__saison1__vostfr__sibnet__ep3.w-180.0_.vfp.npz",
        "sendvid": "cache/video/video__jujutsu-kaisen__saison1__vostfr__sendvid__ep3.w-180.0_.vfp.npz",
        "vidmoly": "cache/video/video__jujutsu-kaisen__saison1__vostfr__vidmoly__ep3.w-180.0_.vfp.npz",
        "megaplay": "cache/video/video__jujutsu-kaisen__saison1__vostfr__megaplay__ep3.w-180.0_.vfp.npz",
    }
    for tag, path in hosts.items():
        if glob.glob(path):
            run_host(tag, path, ref, picks, score)
        else:
            print(f"\n── {tag}: MISSING {path}")


if __name__ == "__main__":
    main()
