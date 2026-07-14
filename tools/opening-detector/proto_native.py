"""Decisive Stage-3 test: frame-accurate theme_t0 via NATIVE-fps landmarks on
both ref and episode, validated by CROSS-HOST agreement (all hosts show the same
credited ED, so their from_end(theme_t0) must agree to < 1 frame ~42ms). This is
the ground-truth proxy, replacing the fuzzy hand-clocked values.
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
    VideoFingerprint, keyframe_hashes_abs, pick_landmarks, _popcount64,
)

AREF = Fingerprint.load("cache/audio/animethemes__jujutsu_kaisen__ED1__v1.fp.npz")
REFURL = "https://v.animethemes.moe/JujutsuKaisen-ED1.webm"
NATIVE_REF_CACHE = "cache/video/_ED1_native_ref.npz"


def native_ref_landmarks(k=10):
    if os.path.exists(NATIVE_REF_CACHE):
        vref = VideoFingerprint.load(NATIVE_REF_CACHE)
    else:
        vref = keyframe_hashes_abs(REFURL, 0.0, None, fps=None)  # native, whole clip
        vref.save(NATIVE_REF_CACHE)
    return pick_landmarks(vref, k=k), float(vref.times.max())


def probe_dur(url, referer=None):
    c = ["ffprobe", "-v", "error"]
    if referer:
        c += ["-headers", f"Referer: {referer}\r\n"]
    if ".m3u8" in url.split("?", 1)[0].lower():
        c += ["-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0"]
    c += ["-show_entries", "format=duration", "-of", "csv=p=0", url]
    out = subprocess.run(c, capture_output=True, text=True).stdout.strip()
    return float(out) if out else 1434.99


def theme_t0_native(url, referer, ep_dur, landmarks, ref_dur):
    # A. coarse locate via audio
    ss = ep_dur - 180.0
    samples, a_abs = decode_audio_abs(url, ss, None, referer=referer)
    m = best_match(fingerprint(samples), AREF, min_votes=40)
    t0c = a_abs + (m.q_start - m.r_start)
    # B. ONE native decode of the whole ED region, localize every landmark in it
    fp = keyframe_hashes_abs(url, t0c - 2.0, ref_dur + 4.0, fps=None, referer=referer)
    if fp.hashes.size == 0:
        return None, t0c, 0, 0.0
    ests = []
    for r_time, h in landmarks:
        d = _popcount64(fp.hashes ^ np.uint64(h)); j = int(np.argmin(d)); best = int(d[j])
        guard = np.abs(fp.times - fp.times[j]) > 0.3
        second = int(d[guard].min()) if guard.any() else 64
        if best <= 8 and (second - best) >= 6:
            ests.append(float(fp.times[j]) - r_time)
    if not ests:
        return None, t0c, 0, 0.0
    ests = np.array(ests)
    return float(np.median(ests)), t0c, len(ests), float(ests.max() - ests.min())


def main():
    landmarks, ref_dur = native_ref_landmarks(k=25)
    print(f"native ref landmarks: {len(landmarks)}  ref_dur={ref_dur:.3f}s")
    hosts = {
        "megaplay": ("https://cdn.mewstream.buzz/anime/c399862d3b9d6b76c8436e924a68c45b/0b8a76448086aac881340eaba297f770/master.m3u8", "https://megaplay.buzz/"),
        "sibnet": (resolve_episodes("jujutsu-kaisen", "saison1", "vostfr", 3, 3, host_pref="sibnet")[0]["url"], None),
        "vidmoly": (resolve_episodes("jujutsu-kaisen", "saison1", "vostfr", 3, 3, host_pref="vidmoly")[0]["url"], None),
    }
    rows = []
    for host, (url, ref) in hosts.items():
        try:
            ep_dur = probe_dur(url, ref)
            t0, t0c, n, spread = theme_t0_native(url, ref, ep_dur, landmarks, ref_dur)
        except Exception as e:
            print(f"{host:9s} ERROR {e}"); continue
        if t0 is None:
            print(f"{host:9s} no landmarks"); continue
        fe = ep_dur - t0
        rows.append((host, fe))
        print(f"{host:9s} ep_dur={ep_dur:.2f}  audio_t0={t0c:.3f}  NATIVE_t0={t0:.3f}  "
              f"n={n}/{len(landmarks)}  spread={spread*1000:.0f}ms  from_end={fe:.3f}")
    if len(rows) >= 2:
        fes = [r[1] for r in rows]
        print(f"\nCROSS-HOST from_end spread = {(max(fes)-min(fes))*1000:.0f} ms across {len(rows)} hosts (target < 42ms)")
        print("  (per-host SPREAD is the frame-accuracy metric; cross-host may differ if post-ED content differs)")


if __name__ == "__main__":
    main()
