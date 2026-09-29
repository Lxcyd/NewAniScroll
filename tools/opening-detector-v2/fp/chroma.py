"""Empreinte Chromaprint brute, via le muxer chromaprint de ffmpeg.

Un mot de 32 bits toutes les ~0,124 s. Contrairement aux hachages epars de la
v1 (faits pour TROUVER un morceau), une suite dense de mots se compare trame
par trame a decalage fixe : c'est ce qui permet de mesurer la CONTINUITE.

Referente et episode passent par le meme chemin (PCM mono 11025 Hz ->
chromaprint), pour que leurs trames soient comparables.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

from fetch import SAMPLE_RATE

# Chromaprint reechantillonne en 11025 Hz, trame 4096, recouvrement 2/3.
FRAME_S = 4096 / 3 / 11025  # ~0.1238 s


def decode_file(path: str | Path, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Fichier local -> PCM mono float32."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr),
         "-f", "f32le", "-"], capture_output=True, timeout=600)
    if out.returncode != 0:
        raise RuntimeError(f"ffmpeg decode {path}: {out.stderr.decode(errors='replace')[-300:]}")
    return np.frombuffer(out.stdout, dtype=np.float32)


def fingerprint(pcm: np.ndarray, sr: int = SAMPLE_RATE) -> np.ndarray:
    """PCM mono float32 -> empreinte brute (uint32, une valeur par FRAME_S)."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "-",
         "-f", "chromaprint", "-fp_format", "raw", "-"],
        input=np.ascontiguousarray(pcm, dtype=np.float32).tobytes(),
        capture_output=True, timeout=600)
    if out.returncode != 0:
        raise RuntimeError(f"ffmpeg chromaprint: {out.stderr.decode(errors='replace')[-300:]}")
    return np.frombuffer(out.stdout, dtype="<u4").copy()
