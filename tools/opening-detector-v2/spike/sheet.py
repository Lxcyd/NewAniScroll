"""Planche d'images autour d'un bord, pour juger a l'oeil ou le generique
commence ou finit vraiment sur UN lecteur.

    python -m spike.sheet <mal> <ep> <lang> <host> <t_abs> [--span 3] [--fps 10] [--out f.png]

Images a --fps sur [t - span, t + span] en temps ABSOLUS (meme horloge que le
detecteur), chacune legendee de son temps ; sous chaque image, l'energie audio
(barre) pour voir ou la musique demarre.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from fetch import SAMPLE_RATE
from fetch.audio import _container_start, _hls_flags, _input_headers, decode_audio_abs
from fetch.episode import resolve, season_of
from fetch.hls_cache import local_mp4, local_window
from fetch.megaplay import is_megaplay, materialize_window

ANIME = Path(__file__).resolve().parents[2] / "opening-detector" / "datasets" / "anime.gt10.json"
W, H = 192, 108
_PTS = re.compile(rb"pts_time:\s*(-?[0-9.]+)")


def frames(src: str, referer, t0: float, dur: float, fps: float):
    seek = t0
    local = local_window(src, t0, dur, referer=referer, want="video") or local_mp4(src, referer=referer)
    if local is None and is_megaplay(src, referer):
        local = materialize_window(src, t0, dur, referer=referer)
    if local is not None:
        src, referer = local, None
        seek = max(0.0, t0 - _container_start(src))
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info", *_input_headers(src, referer), *_hls_flags(src),
           "-copyts", "-ss", str(max(0.0, seek - 12)), "-to", str(seek + dur), "-i", src,
           "-vf", f"fps={fps},scale={W}:{H},showinfo", "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.run(cmd, capture_output=True, timeout=600)
    n = len(p.stdout) // (W * H * 3)
    fr = np.frombuffer(p.stdout[: n * W * H * 3], np.uint8).reshape(n, H, W, 3)
    pts = np.array([float(m.group(1)) for m in _PTS.finditer(p.stderr)][:n])
    k = min(len(pts), n)
    keep = (pts[:k] >= t0 - 1e-3) & (pts[:k] <= t0 + dur)
    return fr[:k][keep], pts[:k][keep]


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("mal", type=int); ap.add_argument("ep", type=int); ap.add_argument("lang"); ap.add_argument("host")
    ap.add_argument("t", type=float); ap.add_argument("--span", type=float, default=3.0)
    ap.add_argument("--fps", type=float, default=10.0); ap.add_argument("--out"); ap.add_argument("--list")
    a = ap.parse_args(argv)
    entry = next(x for x in json.load(open(a.list or ANIME, encoding="utf-8")) if x["mal_id"] == a.mal)
    s = next(x for x in resolve(entry, season_of(entry, a.lang), a.ep, hosts=[a.host]) if x["host"] == a.host)
    t0 = a.t - a.span
    fr, pts = frames(s["url"], s.get("referer"), t0, 2 * a.span, a.fps)
    pcm, a0 = decode_audio_abs(s["url"], t0, 2 * a.span, sample_rate=SAMPLE_RATE, referer=s.get("referer"))
    def rms(t):
        i = int((t - a0) * SAMPLE_RATE); w = int(SAMPLE_RATE / a.fps)
        seg = pcm[max(0, i): max(0, i) + w]
        return float(np.sqrt((seg ** 2).mean())) if len(seg) else 0.0
    cols = 10
    rows = (len(fr) + cols - 1) // cols
    img = Image.new("RGB", (cols * W, rows * (H + 26)), "white")
    d = ImageDraw.Draw(img)
    for i, (f, t) in enumerate(zip(fr, pts)):
        x, y = (i % cols) * W, (i // cols) * (H + 26)
        img.paste(Image.fromarray(f), (x, y))
        m = int(t // 60)
        d.text((x + 3, y + H + 1), f"{m}:{t - 60 * m:05.2f}", fill="red" if abs(t - a.t) < 0.5 / a.fps else "black")
        e = min(1.0, rms(t) * 8)
        d.rectangle([x + 3, y + H + 15, x + 3 + int(e * (W - 6)), y + H + 22], fill=(40, 120, 220))
    out = a.out or f"out/sheet_{a.mal}_{a.ep}_{a.lang}_{a.host}_{int(a.t)}.png"
    img.save(out)
    print(out, len(fr), "images")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
