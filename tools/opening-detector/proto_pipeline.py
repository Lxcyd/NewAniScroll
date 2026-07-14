"""Stage-3 prototype: the full credited-image-authority pipeline, end-to-end, in
ABSOLUTE time. Validates frame-accuracy before wiring into theme_bank.

  A. Locate (audio) -> rough theme_t0_abs
  B. Landmark align (video, medium fps) -> precise theme_t0_abs
  C. Edge refine (video, NATIVE fps) vs credited ref -> frame-accurate start/end
"""

from __future__ import annotations

import sys
import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.audio import decode_audio_abs
from oped.fingerprint import Fingerprint, fingerprint
from oped.matcher import best_match
from oped.video_fingerprint import (
    VideoFingerprint, keyframe_hashes_abs, anchor_by_landmarks, pick_landmarks,
    refine_edge_credited_video,
)

AREF_ED = Fingerprint.load("cache/audio/animethemes__jujutsu_kaisen__ED1__v1.fp.npz")
VREF_ED = VideoFingerprint.load("cache/video/animethemes__jujutsu_kaisen__ED1__v1+cred.vfp.npz")
ED_CRED_URL = "https://v.animethemes.moe/JujutsuKaisen-ED1.webm"

MEGA = ("https://cdn.mewstream.buzz/anime/c399862d3b9d6b76c8436e924a68c45b/0b8a76448086aac881340eaba297f770/master.m3u8",
        "https://megaplay.buzz/", 1434.99)


def clock(s):
    return f"{int(s)//60}:{s%60:06.3f}"


def run_ed(url, referer, ep_dur, aref, vref, ref_url):
    ref_dur = float(vref.times.max())
    landmarks = pick_landmarks(vref, k=5)

    # A. LOCATE (audio, coarse) — rough abs theme_t0
    ss = ep_dur - 180.0
    samples, a_abs = decode_audio_abs(url, ss, None, referer=referer)
    m = best_match(fingerprint(samples), aref, min_votes=40)
    t0_audio = a_abs + (m.q_start - m.r_start)
    print(f"A. locate (audio): theme_t0 ~ {t0_audio:.2f} ({clock(t0_audio)})")

    # B. LANDMARK ALIGN (video, medium fps) — precise abs theme_t0
    lo = max(0.0, t0_audio - 12.0)
    vfp = keyframe_hashes_abs(url, lo, ref_dur + 24.0, fps=6.0, referer=referer)
    anc = anchor_by_landmarks(vfp, landmarks)
    if anc is None:
        print("B. landmark align: FAILED -> keep audio"); t0 = t0_audio
    else:
        t0 = anc.theme_t0
        print(f"B. landmark align: theme_t0 = {t0:.3f} ({clock(t0)})  "
              f"accepted {anc.n_accepted}/{anc.n_total}  spread {anc.spread_s:.2f}s")

    # C. EDGE REFINE (native fps) vs credited ref
    def refine(edge_kind, ep_edge_abs, ref_edge):
        ep_fp = keyframe_hashes_abs(url, max(0.0, ep_edge_abs - 2.0), 4.0, fps=None, referer=referer)
        ref_fp = keyframe_hashes_abs(ref_url, max(0.0, ref_edge - 2.0), 4.0, fps=None)
        return refine_edge_credited_video(
            ep_fp, ref_fp, edge_kind=edge_kind,
            theme_t0_ep_t=t0, ep_win_off=0.0, ref_win_off=0.0, fps=24.0,
        )

    start = refine("start", t0, 0.0)
    end = refine("end", t0 + ref_dur, ref_dur)
    print(f"C. edge refine (native): start={start} end={end}")

    fs = start if start is not None else t0
    fe = end if end is not None else t0 + ref_dur
    print(f"\n=> ED  start={clock(fs)}  end={clock(fe)}  (from_end start=-{ep_dur-fs:.2f})")
    print(f"   ground truth: start 21:15.0 (1274.99)  end 22:44.9 (1364.90)")
    print(f"   delta: start {fs-1274.99:+.2f}s  end {fe-1364.90:+.2f}s")


if __name__ == "__main__":
    url, ref, dur = MEGA
    print("=== megaplay ep3 ED (full new pipeline) ===")
    run_ed(url, ref, dur, AREF_ED, VREF_ED, ED_CRED_URL)
