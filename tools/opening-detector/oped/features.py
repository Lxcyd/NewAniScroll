"""DSP descriptors shared by the classifier (level 2) and the single-episode
fallback (level 3).

Empirical finding from SnK probing (zones with known labels): the descriptors
that actually separate MUSIC from DIALOGUE are:

  - spectral-centroid stability (centroidCV): music holds a steady timbre
    (CV ~0.23-0.26); dialogue's centroid jumps around (CV ~0.39-0.41). BEST
    music-vs-speech signal found.
  - bass/low-band energy ratio: a credits theme carries bass+percussion
    (ED 0.33); sparse dialogue is thin in the low band (0.09-0.14).
  - sustain (continuity of energy without silence gaps): a theme runs ~90s
    continuously; dialogue is bursty.

IMPORTANT — what DSP can and cannot do: a recap ("Précédemment…") scores like
music on these (it has musical underscore), so `score_segment` does NOT try to
separate recap from OP/ED. That separation is the MATCHER's job (the OP/ED is a
segment that repeats IDENTICALLY across episodes; a recap changes every episode).
DSP here answers a narrower question — "is this span sustained music vs
dialogue?" — used to (a) reject dialogue-y false candidates and (b) drive the
single-episode fallback when no repetition exists.

All features run on mono samples at SAMPLE_RATE.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import stft

from . import SAMPLE_RATE, N_FFT, HOP


def rms_envelope(samples: np.ndarray, win_s: float = 1.0, hop_s: float = 0.25):
    """Coarse RMS envelope: (times_s, rms) at hop_s resolution.

    Vectorized framing (the old per-window Python loop in refine.py was a
    bottleneck on full episodes).
    """
    win = int(win_s * SAMPLE_RATE)
    hop = int(hop_s * SAMPLE_RATE)
    if len(samples) < win:
        return np.array([win / 2 / SAMPLE_RATE]), np.array(
            [np.sqrt(np.mean(samples * samples)) if samples.size else 0.0]
        )
    n = (len(samples) - win) // hop + 1
    idx = np.arange(n)[:, None] * hop + np.arange(win)[None, :]
    frames = samples[idx]
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    times = (np.arange(n) * hop + win / 2) / SAMPLE_RATE
    return times, rms


def _spectrogram(samples: np.ndarray) -> np.ndarray:
    _, _, Z = stft(
        samples, fs=SAMPLE_RATE, nperseg=N_FFT, noverlap=N_FFT - HOP, boundary=None
    )
    return np.abs(Z) + 1e-9


def _centroid_cv(mag: np.ndarray) -> float:
    """Coefficient of variation of the spectral centroid over time. Music holds
    a steady timbre (low CV ~0.25); dialogue's centroid jumps (~0.40)."""
    bins = np.arange(mag.shape[0])[:, None]
    centroid = (bins * mag).sum(0) / mag.sum(0)
    return float(centroid.std() / (centroid.mean() + 1e-9))


def _bass_ratio(mag: np.ndarray) -> float:
    """Fraction of spectral energy in the low band (~bass/percussion). A credits
    theme carries low-end; sparse dialogue is thin there."""
    return float(mag[2:30].sum() / (mag.sum() + 1e-9))


@dataclass
class SegmentScore:
    musicality: float   # 0-1 (from centroid stability)
    bass: float         # 0-1 (from low-band ratio)
    sustain: float      # 0-1 (energy continuity)
    music_likelihood: float  # 0-1 composite: "sustained music, not dialogue"

    def __repr__(self) -> str:
        return (f"SegmentScore(music={self.musicality:.2f} "
                f"bass={self.bass:.2f} sustain={self.sustain:.2f} "
                f"=> music_like={self.music_likelihood:.2f})")


def score_segment(samples: np.ndarray) -> SegmentScore:
    """Score how MUSICAL (vs dialogue) a span of audio is. Does NOT distinguish
    a recap from an OP/ED — that is the matcher's job (repetition). Used to
    reject dialogue-y candidates and to drive the single-episode fallback.

    Calibrated on SnK ep1 zones:
      OP music=.. bass=.18 centroidCV=.25 ; dialogue centroidCV~.40 bass~.10
    """
    if samples.size < SAMPLE_RATE // 2:
        return SegmentScore(0.0, 0.0, 0.0, 0.0)

    mag = _spectrogram(samples)

    # musicality from centroid stability: CV 0.25 (music) -> ~1, 0.40 (speech) -> ~0.
    cv = _centroid_cv(mag)
    musicality = float(np.clip((0.42 - cv) / (0.42 - 0.24), 0, 1))

    # bass: 0.30 -> 1, 0.08 -> 0.
    bass = float(np.clip((_bass_ratio(mag) - 0.08) / (0.30 - 0.08), 0, 1))

    _, rms = rms_envelope(samples, win_s=1.0, hop_s=0.5)
    if rms.size and rms.max() > 0:
        sustain = float(np.mean(rms > 0.4 * rms.max()))
    else:
        sustain = 0.0

    # Composite weighted toward the strongest discriminator (musicality), with
    # bass and sustain as corroboration.
    music_like = 0.6 * musicality + 0.2 * bass + 0.2 * sustain
    return SegmentScore(musicality, bass, sustain, float(np.clip(music_like, 0, 1)))
