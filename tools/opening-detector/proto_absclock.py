"""Stage-1 invariance test: with absolute-timestamp decoding, audio and video
place the SAME ED at the SAME absolute time (theme_t0). Before, on megaplay's
-sseof windows, they were ~10s apart. Target: |t0_audio - t0_video| < ~0.1s.
"""

from __future__ import annotations

import sys
import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.audio import decode_audio_abs
from oped.fingerprint import Fingerprint, fingerprint
from oped.matcher import best_match
from oped.video_fingerprint import VideoFingerprint, keyframe_hashes_abs
from proto_landmark import pick_landmarks, localize

AREF = Fingerprint.load("cache/audio/animethemes__jujutsu_kaisen__ED1__v1.fp.npz")
VREF = VideoFingerprint.load("cache/video/animethemes__jujutsu_kaisen__ED1__v1+cred.vfp.npz")

HOSTS = {
    "megaplay": (
        "https://cdn.mewstream.buzz/anime/c399862d3b9d6b76c8436e924a68c45b/0b8a76448086aac881340eaba297f770/master.m3u8",
        "https://megaplay.buzz/", 1434.99),
}
GROUND_TRUTH_ED_START = 1274.99  # 21:15.0 (trio geometry)


def audio_t0_abs(url, referer, ss):
    samples, abs_start = decode_audio_abs(url, ss, None, referer=referer)
    m = best_match(fingerprint(samples), AREF, min_votes=40)
    if m is None:
        return None, abs_start
    return abs_start + (m.q_start - m.r_start), abs_start


def video_t0_abs(url, referer, ss):
    vfp = keyframe_hashes_abs(url, ss, None, fps=2.0, referer=referer)
    picks, score, _, _ = pick_landmarks(VREF, k=4)
    t0s = []
    for r_idx in picks:
        t_ep, best, second = localize(VREF, vfp, r_idx)   # t_ep is ABSOLUTE now
        if best <= 8 and (second - best) >= 6:
            t0s.append(t_ep - float(VREF.times[r_idx]))
    return (float(np.median(t0s)) if t0s else None), vfp


def main():
    for host, (url, referer, ep_dur) in HOSTS.items():
        ss = ep_dur - 180.0
        at0, a_abs = audio_t0_abs(url, referer, ss)
        vt0, vfp = video_t0_abs(url, referer, ss)
        print(f"=== {host} (ep_dur={ep_dur}, -ss {ss:.2f}) ===")
        print(f"  audio abs_start={a_abs:.2f}  theme_t0_abs={at0:.2f} ({int(at0)//60}:{at0%60:05.2f})")
        print(f"  video times=[{vfp.times.min():.1f}..{vfp.times.max():.1f}]  theme_t0_abs={vt0:.2f} ({int(vt0)//60}:{vt0%60:05.2f})")
        print(f"  INVARIANT |audio - video| = {abs(at0 - vt0):.3f}s   (target < 0.1)")
        print(f"  vs ground truth ED start {GROUND_TRUTH_ED_START:.2f}: audio {at0-GROUND_TRUTH_ED_START:+.2f}s  video {vt0-GROUND_TRUTH_ED_START:+.2f}s")


if __name__ == "__main__":
    main()
