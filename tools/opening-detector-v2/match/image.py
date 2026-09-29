"""Controle image a temps relatif CONNU.

L'audio a deja donne l'alignement exact : la trame 0 de la reference tombe au
temps T de l'episode. On compare donc l'image de l'episode a T + r a l'image
de la video de reference a r — sans recherche, sans vote.

Ce controle sert a ecarter le cas que l'audio ne voit pas : la chanson passe
en entier, a l'identique, mais sur d'AUTRES images (ED du dernier episode pose
sur l'epilogue, OP rejoue en generique de fin sur des credits deroulants).

Robustesse :
- sous-titres incrustes (VOSTFR) : la bande basse de l'image est ignoree ;
- credits (reference NC contre episode credite, ou l'inverse) : on prend le
  meilleur score entre toutes les videos de la reference, image par image, et
  la correlation porte sur une image tres reduite (le texte fin y pese peu) ;
- decalage audio/video entre encodes : meilleure image dans +/- AV_SLACK_S.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import numpy as np

from fetch.audio import _container_start, _hls_flags, _input_headers
from fetch.hls_cache import local_mp4, local_window
from fetch.megaplay import is_megaplay, materialize_window

W, H = 32, 18
FPS = 2.0
SUB_BAND = 0.25        # part basse de l'image ignoree (sous-titres incrustes)
AV_SLACK_S = 0.6
MATCH_NCC = 0.50       # correlation au-dessus de laquelle deux images « concordent » (credits incrustes sur une reference NC : 0,5-0,8 ; autres images : ~0)
PREROLL_S = 12.0
NEAR_FLAT_STD = 15.0   # texte sur fond uni : encore « uni » face a un aplat
FLAT_STD = 4.0         # ecart-type sous lequel une image est un aplat (noir, fondu)

_PTS_RE = re.compile(rb"pts_time:\s*(-?[0-9.]+)")


def _decode(cmd: list[str]) -> tuple[np.ndarray, np.ndarray]:
    proc = subprocess.run(cmd, capture_output=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg (images): {proc.stderr.decode(errors='replace')[-300:]}")
    n = len(proc.stdout) // (W * H)
    frames = np.frombuffer(proc.stdout[: n * W * H], np.uint8).reshape(n, H, W)
    pts = [float(m.group(1)) for m in _PTS_RE.finditer(proc.stderr)]
    k = min(len(pts), n)
    return frames[:k], np.asarray(pts[:k], np.float64)


def _vf(fps: float | None = FPS) -> list[str]:
    rate = f"fps={fps}," if fps else ""  # None : cadence native
    return ["-vf", f"{rate}scale={W}:{H}:flags=area,format=gray,showinfo",
            "-an", "-f", "rawvideo", "-pix_fmt", "gray", "-"]


def episode_frames(src: str, start_abs: float, dur: float, *, referer: str | None = None,
                   fps: float | None = FPS) -> tuple[np.ndarray, np.ndarray]:
    """Images de l'episode sur [start_abs, start_abs + dur], temps ABSOLUS
    (meme horloge que l'audio : -copyts, comme fetch.audio.decode_audio_abs).

    La fenetre est demandee PREROLL_S plus tot puis filtree par horodatage :
    sur ansembed, la recherche atterrissait ~4 s apres le temps demande (premiere
    image a 1380,19 pour 1376,0), et la fin d'un ED tombait dans ce trou."""
    frames, times = _episode_frames(src, max(0.0, start_abs - PREROLL_S), dur + PREROLL_S,
                                    referer=referer, fps=fps)
    keep = (times >= start_abs - 1e-3) & (times <= start_abs + dur + 1e-3)
    return frames[keep], times[keep]


def _episode_frames(src: str, start_abs: float, dur: float, *, referer: str | None,
                    fps: float | None) -> tuple[np.ndarray, np.ndarray]:
    seek = start_abs
    local = local_window(src, start_abs, dur, referer=referer, want="video") or local_mp4(src, referer=referer)
    if local is None and is_megaplay(src, referer):
        local = materialize_window(src, start_abs, dur, referer=referer)
    if local is not None:
        src, referer = local, None
        seek = max(0.0, start_abs - _container_start(src))  # -ss relatif au debut du conteneur
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info", *_input_headers(src, referer),
           *_hls_flags(src), "-copyts", "-ss", str(seek), "-to", str(seek + dur), "-i", src, *_vf(fps)]
    return _decode(cmd)


def ref_frames(path: str | Path) -> tuple[np.ndarray, np.ndarray]:
    """Images d'une video de reference a sa cadence NATIVE, temps depuis son
    debut : l'image la plus proche de n'importe quel instant est a ~20 ms, la
    ou un echantillonnage a 2 i/s la mettait jusqu'a 0,25 s (plans rapides
    comptes a tort comme differents)."""
    cache = Path("cache/refs/frames") / (Path(path).stem + ".native.npz")
    if cache.exists():
        z = np.load(cache)
        return z["frames"], z["times"]
    frames, times = _decode(["ffmpeg", "-hide_banner", "-loglevel", "info", "-i", str(path), *_vf(None)])
    times = times - (times[0] if len(times) else 0.0)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez(cache, frames=frames, times=times)
    return frames, times


def _prep(frames: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Bande haute (hors sous-titres), centree-reduite ; ecart-type brut a part."""
    top = frames[:, : int(round(H * (1 - SUB_BAND))), :].reshape(len(frames), -1).astype(np.float32)
    mu = top.mean(axis=1, keepdims=True)
    sd = top.std(axis=1, keepdims=True)
    return (top - mu) / np.maximum(sd, 1e-3), np.concatenate([sd[:, 0:1], mu[:, 0:1]], axis=1)


def similarity(ep: np.ndarray, ref: np.ndarray, ep_stats: np.ndarray, ref_stats: np.ndarray) -> float:
    """Correlation entre deux images preparees ; aplats compares par luminance."""
    (sd_e, mu_e), (sd_r, mu_r) = ep_stats, ref_stats
    if sd_e < FLAT_STD or sd_r < FLAT_STD:
        # Un aplat face a une image quasi unie : c'est le carton de credits sur
        # fond uni contre le meme fond sans credits (reference NC). Kimetsu ep2 :
        # carton blanc final, ecart-type 4,2 chez ansembed (texte + filigrane)
        # contre 0 pour la reference -> la fin tombait 2,8 s trop tot.
        near_flat = max(sd_e, sd_r) < NEAR_FLAT_STD
        return 1.0 if (near_flat and abs(mu_e - mu_r) < 20) else 0.0
    return float((ep * ref).mean())


def compare(ep_frames: np.ndarray, ep_times: np.ndarray, t0: float,
            refs: list[tuple[np.ndarray, np.ndarray]], *, slack: float = AV_SLACK_S) -> np.ndarray:
    """Pour chaque image d'episode, meilleure correlation avec une image de
    reference au meme temps relatif (t - t0), toutes videos de reference
    confondues. NaN quand aucune reference ne couvre ce temps."""
    ep_p, ep_s = _prep(ep_frames)
    prepped = [(times, *_prep(frames)) for frames, times in refs]
    out = np.full(len(ep_frames), np.nan)
    for i, t in enumerate(ep_times):
        r = t - t0
        best = np.nan
        for times, rp, rs in prepped:
            for j in np.flatnonzero(np.abs(times - r) <= slack):
                s = similarity(ep_p[i], rp[j], ep_s[i], rs[j])
                best = s if np.isnan(best) else max(best, s)
        out[i] = best
    return out

