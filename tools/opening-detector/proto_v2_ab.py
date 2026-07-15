"""A/B harness for detect_op_ed_v2 (Stage 4 step 2) on JJK ep3, all hosts.

Runs the NEW image-credited pipeline (LOCATE audio -> ALIGN native landmarks)
against the ED and prints start/end + landmark confidence per host, next to the
ground-truth marks (ED ~21:15 .. cut じゅじゅさんぽ ~22:44.9). Confirms the new
path reproduces the Stage-3 t0 through the real detect_op_ed_v2 entry point (not
just the proto), and that the audio-fallback flag behaves.
"""

from __future__ import annotations

import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.adapter_aniscroll import resolve_episodes
from oped.animethemes import resolve_slug, fetch_themes
from oped.audio import decode_audio_abs
from oped.fingerprint import fingerprint
from oped.theme_bank import build_references, detect_op_ed_v2
from oped.video_fingerprint import keyframe_hashes_abs


def probe_dur(url, referer=None):
    c = ["ffprobe", "-v", "error"]
    if referer:
        c += ["-headers", f"Referer: {referer}\r\n"]
    if ".m3u8" in url.split("?", 1)[0].lower():
        c += ["-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0"]
    c += ["-show_entries", "format=duration", "-of", "csv=p=0", url]
    out = subprocess.run(c, capture_output=True, text=True).stdout.strip()
    return float(out) if out else 1434.99


def mmss(t):
    return f"{int(t) // 60}:{t % 60:05.2f}"


def main():
    slug = resolve_slug(mal_id=40748)
    themes = fetch_themes(slug)
    refs = []
    for t in themes:
        refs += build_references(t, slug_prefix=f"animethemes/{slug}", with_video=True)
    op_refs = [r for r in refs if r.kind == "op"]
    ed_refs = [r for r in refs if r.kind == "ed"]
    ed1 = next((r for r in ed_refs if r.slug == "ED1"), None)
    print(f"refs: {len(op_refs)} OP, {len(ed_refs)} ED "
          f"(ED1 landmarks={len(ed1.landmarks) if ed1 else 0}, "
          f"native_dur={ed1.ref_native_dur if ed1 else 0:.3f})")

    hosts = {
        "megaplay": ("https://cdn.mewstream.buzz/anime/c399862d3b9d6b76c8436e924a68c45b/0b8a76448086aac881340eaba297f770/master.m3u8", "https://megaplay.buzz/"),
        "sibnet": (resolve_episodes("jujutsu-kaisen", "saison1", "vostfr", 3, 3, host_pref="sibnet")[0]["url"], None),
        "vidmoly": (resolve_episodes("jujutsu-kaisen", "saison1", "vostfr", 3, 3, host_pref="vidmoly")[0]["url"], None),
    }

    print("\nground truth ED: ~21:15 .. cut じゅじゅさんぽ ~22:44.9\n")
    for host, (url, ref) in hosts.items():
        ep_dur = probe_dur(url, ref)

        def resolve_audio_abs(start_abs, dur, _u=url, _r=ref):
            samples, abs_start = decode_audio_abs(_u, start_abs, dur, referer=_r)
            return fingerprint(samples), abs_start

        def resolve_video_abs(start_abs, dur, fps, _u=url, _r=ref):
            return keyframe_hashes_abs(_u, start_abs, dur, fps=fps, referer=_r)

        try:
            hits = detect_op_ed_v2(
                ep_dur, op_refs, ed_refs,
                resolve_audio_abs=resolve_audio_abs,
                resolve_video_abs=resolve_video_abs,
            )
        except Exception as e:
            print(f"{host:9s} ERROR {e}")
            continue
        ed = next((h for h in hits if h.kind == "ed"), None)
        op = next((h for h in hits if h.kind == "op"), None)
        print(f"{host:9s} ep_dur={ep_dur:.2f}")
        for lbl, h in (("OP", op), ("ED", ed)):
            if h is None:
                print(f"   {lbl}: (none)")
                continue
            conf = "AUDIO-FALLBACK" if h.low_confidence else f"img {h.consensus_frac*100:.0f}%/{h.n_landmarks}"
            print(f"   {lbl} {h.slug}: {mmss(h.start)} .. {mmss(h.end)}  "
                  f"src={h.source} {conf}  from_end={ep_dur - h.start:.3f}")


if __name__ == "__main__":
    main()
