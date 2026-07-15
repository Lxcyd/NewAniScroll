"""Stage-3 iteration 2: close frame-accuracy of theme_t0 on the FLAT JJK ED.

proto_native (v1) showed the real blocker: pick_landmarks caps at 8 landmarks
(min_gap_floor_s=8 on a 90s clip) and admits weak ones (unique~6), giving only
3/8 accepted and 42-126ms per-host spread. This clip is visually flat (unique
median 6 bits), so we need (a) MORE, STRONGER landmarks and (b) a robust
estimator that trims outlier landmarks before projecting theme_t0.

This script:
  - caches each host's NATIVE ED-region fingerprint to disk (fast re-runs while
    we sweep thresholds),
  - sweeps landmark floor / min_unique / acceptance (hamming, sep),
  - reports PER-HOST spread (the frame-accuracy metric) with a MAD-trimmed
    median, plus n_accepted.
"""

from __future__ import annotations

import os, sys, subprocess
import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.adapter_aniscroll import resolve_episodes
from oped.audio import decode_audio_abs
from oped.fingerprint import Fingerprint, fingerprint
from oped.matcher import best_match
from oped.video_fingerprint import (
    VideoFingerprint, keyframe_hashes_abs, landmark_scores, _popcount64,
)

AREF = Fingerprint.load("cache/audio/animethemes__jujutsu_kaisen__ED1__v1.fp.npz")
NATIVE_REF_CACHE = "cache/video/_ED1_native_ref.npz"
FRAME_MS = 1000.0 / (24000.0 / 1001.0)  # ~41.7ms


def pick(vref, *, k, floor, min_unique):
    """Strong-landmark picker: require a real distinctiveness floor (unique bits)
    AND temporal separation. Returns [(r_time, hash), ...] sorted by time."""
    score, _detail, unique = landmark_scores(vref)
    t = vref.times
    order = np.argsort(score)[::-1]
    picked = []
    for i in order:
        if len(picked) >= k:
            break
        if unique[i] < min_unique:
            continue
        if all(abs(float(t[i]) - float(t[j])) >= floor for j in picked):
            picked.append(int(i))
    picked.sort(key=lambda i: float(t[i]))
    return [(float(t[i]), int(vref.hashes[i])) for i in picked]


def probe_dur(url, referer=None):
    c = ["ffprobe", "-v", "error"]
    if referer:
        c += ["-headers", f"Referer: {referer}\r\n"]
    if ".m3u8" in url.split("?", 1)[0].lower():
        c += ["-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0"]
    c += ["-show_entries", "format=duration", "-of", "csv=p=0", url]
    out = subprocess.run(c, capture_output=True, text=True).stdout.strip()
    return float(out) if out else 1434.99


def host_native_ed(host, url, referer, ep_dur, ref_dur):
    """Return (native ED-region fingerprint, audio_t0). Cached to disk."""
    cache = f"cache/video/_native_ed__{host}.npz"
    ss = ep_dur - 180.0
    samples, a_abs = decode_audio_abs(url, ss, None, referer=referer)
    m = best_match(fingerprint(samples), AREF, min_votes=40)
    t0c = a_abs + (m.q_start - m.r_start)
    if os.path.exists(cache):
        return VideoFingerprint.load(cache), t0c
    fp = keyframe_hashes_abs(url, t0c - 2.0, ref_dur + 4.0, fps=None, referer=referer)
    fp.save(cache)
    return fp, t0c


def anchor(fp, landmarks, *, hamming_max, sep_min, guard_s=1.0):
    """Per-landmark theme_t0 estimates that pass the acceptance guards."""
    ests = []
    for r_time, h in landmarks:
        d = _popcount64(fp.hashes ^ np.uint64(h))
        j = int(np.argmin(d)); best = int(d[j])
        guard = np.abs(fp.times - fp.times[j]) > guard_s
        second = int(d[guard].min()) if guard.any() else 64
        if best <= hamming_max and (second - best) >= sep_min:
            ests.append(float(fp.times[j]) - r_time)
    return np.array(ests)


def mad_trim(ests, *, k=3.5):
    """Drop estimates > k*MAD from the median (robust outlier rejection)."""
    if len(ests) <= 2:
        return ests
    med = np.median(ests)
    mad = np.median(np.abs(ests - med))
    if mad == 0:
        return ests
    keep = np.abs(ests - med) <= k * mad
    return ests[keep] if keep.any() else ests


def main():
    vref = VideoFingerprint.load(NATIVE_REF_CACHE)
    ref_dur = float(vref.times.max())
    hosts = {
        "megaplay": ("https://cdn.mewstream.buzz/anime/c399862d3b9d6b76c8436e924a68c45b/0b8a76448086aac881340eaba297f770/master.m3u8", "https://megaplay.buzz/"),
        "sibnet": (resolve_episodes("jujutsu-kaisen", "saison1", "vostfr", 3, 3, host_pref="sibnet")[0]["url"], None),
        "vidmoly": (resolve_episodes("jujutsu-kaisen", "saison1", "vostfr", 3, 3, host_pref="vidmoly")[0]["url"], None),
    }
    # Decode each host's native ED region once (cached).
    host_fps = {}
    for host, (url, ref) in hosts.items():
        ep_dur = probe_dur(url, ref)
        fp, t0c = host_native_ed(host, url, ref, ep_dur, ref_dur)
        host_fps[host] = (fp, ep_dur, t0c)
        print(f"{host:9s} native ED frames={len(fp.hashes)} span={float(fp.times.max()-fp.times.min()):.1f}s audio_t0={t0c:.3f}")
    print(f"ref_dur={ref_dur:.3f}  frame={FRAME_MS:.1f}ms\n")

    # Sweep landmark selection + acceptance.
    configs = [
        dict(floor=3.0, min_unique=10, hamming_max=8,  sep_min=6),
        dict(floor=3.0, min_unique=10, hamming_max=10, sep_min=4),
        dict(floor=2.0, min_unique=10, hamming_max=10, sep_min=4),
        dict(floor=3.0, min_unique=12, hamming_max=8,  sep_min=6),
    ]
    for cfg in configs:
        landmarks = pick(vref, k=30, floor=cfg["floor"], min_unique=cfg["min_unique"])
        print(f"=== floor={cfg['floor']} min_unique={cfg['min_unique']} "
              f"hamming<={cfg['hamming_max']} sep>={cfg['sep_min']}  ({len(landmarks)} landmarks) ===")
        fes = []
        for host, (fp, ep_dur, t0c) in host_fps.items():
            ests = anchor(fp, landmarks, hamming_max=cfg["hamming_max"], sep_min=cfg["sep_min"])
            if len(ests) == 0:
                print(f"  {host:9s} no landmarks accepted"); continue
            trimmed = mad_trim(ests)
            t0 = float(np.median(trimmed))
            spread = float(trimmed.max() - trimmed.min())
            raw_spread = float(ests.max() - ests.min())
            fe = ep_dur - t0
            fes.append(fe)
            flag = "OK" if spread <= FRAME_MS / 1000.0 else ""
            print(f"  {host:9s} n={len(ests)}(trim {len(trimmed)}) t0={t0:.3f} "
                  f"spread={spread*1000:.0f}ms (raw {raw_spread*1000:.0f}) from_end={fe:.3f} {flag}")
        if len(fes) >= 2:
            print(f"  cross-host from_end spread={(max(fes)-min(fes))*1000:.0f}ms\n")
        else:
            print()


if __name__ == "__main__":
    main()
