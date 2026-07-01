"""Constellation peak-hashing fingerprinter (Shazam-style), tuned for
long-segment alignment rather than whole-track identification.

Why homemade over Chromaprint (spec asks to justify):
  - We need a precise TIME OFFSET between two recordings of the same OP, not a
    yes/no track ID. Constellation hashes carry absolute anchor times, so a
    histogram of (t_query - t_ref) over matched hashes peaks sharply at the
    true alignment offset — recoverable to one STFT hop (~11.6 ms).
  - Chromaprint emits a coarse 32-bit-per-frame fingerprint at ~8.06 fps
    (~124 ms/frame). That is ~10x coarser than our hop and is not designed to
    return a sub-segment alignment offset; matching long shared segments by
    bit-error is robust but blunt on the boundary. We keep a Chromaprint path
    only for the Etape 1 comparison eval.

A "fingerprint" here is a structured array of (hash, t_frame) where `hash`
encodes a peak pair (f1, f2, dt) and `t_frame` is the anchor's STFT frame index.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage
from scipy.signal import stft

from . import HOP, HOP_SECONDS, N_FFT, SAMPLE_RATE

# Constellation / pairing parameters.
PEAK_NEIGHBORHOOD = (12, 18)   # (freq bins, time frames) for local-max filter
TARGET_T_MIN = 1               # min frame gap from anchor to target peak
TARGET_T_MAX = 40              # max frame gap (~0.46 s fan-out window)
TARGET_F_MAX = 40              # max freq-bin gap for a pair
FANOUT = 8                     # target peaks paired per anchor


@dataclass
class Fingerprint:
    """Hashes for one recording. Parallel arrays sorted by hash."""

    hashes: np.ndarray   # uint64, the packed peak-pair code
    times: np.ndarray    # int32, anchor frame index
    n_frames: int        # total STFT frames (for coverage stats)

    @property
    def hop_seconds(self) -> float:
        return HOP_SECONDS

    def save(self, path) -> None:
        np.savez_compressed(
            path, hashes=self.hashes, times=self.times, n_frames=self.n_frames
        )

    @classmethod
    def load(cls, path) -> "Fingerprint":
        d = np.load(path)
        return cls(d["hashes"], d["times"], int(d["n_frames"]))


def _spectrogram(samples: np.ndarray) -> np.ndarray:
    """Log-magnitude spectrogram, shape (freq_bins, frames)."""
    _, _, Z = stft(
        samples,
        fs=SAMPLE_RATE,
        nperseg=N_FFT,
        noverlap=N_FFT - HOP,
        boundary=None,
        padded=False,
    )
    mag = np.abs(Z)
    return np.log1p(mag)


def _find_peaks(spec: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Local-maxima constellation. Returns (freq_bins, frames) of peaks."""
    footprint = np.ones(PEAK_NEIGHBORHOOD)
    local_max = ndimage.maximum_filter(spec, footprint=footprint) == spec
    # Drop the noise floor: keep peaks above a per-spectrogram threshold so
    # silent gaps don't generate junk peaks.
    thresh = spec.mean() + 0.5 * spec.std()
    peaks = local_max & (spec > thresh)
    f_idx, t_idx = np.nonzero(peaks)
    order = np.argsort(t_idx)
    return f_idx[order], t_idx[order]


def _pair_hashes(f_idx: np.ndarray, t_idx: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Pair each anchor peak with up to FANOUT later peaks in its target zone.

    Vectorized: peaks are time-sorted, so for each fan-out slot k=1..FANOUT we
    pair anchor i with peak i+k (the k-th subsequent peak) and keep the pairs
    whose (dt, df) fall inside the target window. This is the standard Shazam
    "next-N-peaks" pairing and runs in O(N·FANOUT) numpy ops instead of a
    Python double loop (orders of magnitude faster on full episodes).

    Hash packs (f1, f2, dt) into uint64; anchor time returned separately.
    """
    f1 = f_idx.astype(np.int64)
    t1 = t_idx.astype(np.int64)
    n = f1.size
    if n == 0:
        return np.empty(0, np.uint64), np.empty(0, np.int32)

    all_h: list[np.ndarray] = []
    all_t: list[np.ndarray] = []
    for k in range(1, FANOUT + 1):
        if k >= n:
            break
        a_f, a_t = f1[:-k], t1[:-k]          # anchors
        b_f, b_t = f1[k:], t1[k:]            # k-th subsequent peak
        dt = b_t - a_t
        df = np.abs(b_f - a_f)
        ok = (dt >= TARGET_T_MIN) & (dt <= TARGET_T_MAX) & (df <= TARGET_F_MAX)
        if not ok.any():
            continue
        af, bf, d, at = a_f[ok], b_f[ok], dt[ok], a_t[ok]
        # Pack: f1 (10 bits) | f2 (10 bits) | dt (8 bits)
        h = ((af & 0x3FF) << 18) | ((bf & 0x3FF) << 8) | (d & 0xFF)
        all_h.append(h.astype(np.uint64))
        all_t.append(at.astype(np.int32))

    if not all_h:
        return np.empty(0, np.uint64), np.empty(0, np.int32)
    return np.concatenate(all_h), np.concatenate(all_t)


def fingerprint(samples: np.ndarray) -> Fingerprint:
    """Compute the constellation fingerprint of mono samples."""
    spec = _spectrogram(samples)
    f_idx, t_idx = _find_peaks(spec)
    hashes, times = _pair_hashes(f_idx, t_idx)
    # Sort by hash for fast intersection in the matcher.
    order = np.argsort(hashes, kind="stable")
    return Fingerprint(hashes[order], times[order], n_frames=spec.shape[1])
