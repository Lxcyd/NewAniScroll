"""Etape 1 PoC: prove the matcher recovers a shared segment's alignment to
sub-frame precision on synthetic audio with KNOWN ground truth.

We synthesize N fake episodes. Each is unique random "body" audio with one
shared "OP" recording spliced in at a known start time. We then match each
episode against episode 0 and check:
  - recovered offset == (op_start_i - op_start_0) within one hop
  - recovered span covers the true OP extent

Run:  python poc_synthetic.py
"""

from __future__ import annotations

import sys

import numpy as np

# Windows consoles default to cp1252; force UTF-8 so Δ etc. print.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped import SAMPLE_RATE, HOP_SECONDS
from oped.fingerprint import fingerprint
from oped.matcher import best_match

RNG = np.random.default_rng(1234)


def _make_op(duration_s: float) -> np.ndarray:
    """A fixed, content-rich 'OP' recording: layered tones + texture so the
    constellation has plenty of distinct peaks (like real music would)."""
    n = int(duration_s * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    sig = np.zeros(n, dtype=np.float32)
    # A little chord progression so peaks vary over time.
    for base in (220, 330, 440, 660):
        sweep = base * (1 + 0.05 * np.sin(2 * np.pi * 0.5 * t))
        sig += np.sin(2 * np.pi * sweep * t).astype(np.float32)
    sig += 0.2 * RNG.standard_normal(n).astype(np.float32)  # texture
    return (sig / np.max(np.abs(sig))).astype(np.float32)


def _make_body(duration_s: float) -> np.ndarray:
    """Unique per-episode body: filtered noise + sparse speech-like bursts."""
    n = int(duration_s * SAMPLE_RATE)
    sig = 0.3 * RNG.standard_normal(n).astype(np.float32)
    # sparse "dialogue" bursts
    for _ in range(int(duration_s)):
        start = RNG.integers(0, n - SAMPLE_RATE)
        f = RNG.uniform(120, 300)
        seg = np.arange(SAMPLE_RATE) / SAMPLE_RATE
        sig[start:start + SAMPLE_RATE] += (
            0.5 * np.sin(2 * np.pi * f * seg)
        ).astype(np.float32)
    return (sig / (np.max(np.abs(sig)) + 1e-9)).astype(np.float32)


def build_episode(op: np.ndarray, op_start_s: float, total_s: float,
                  sub_frame_shift_s: float) -> tuple[np.ndarray, float]:
    """Splice `op` into a unique body at a precise (sub-frame) start time.

    The shift is folded directly into the OP's sample-accurate start position,
    so the true start is below the STFT hop grid — that is what stresses
    alignment precision. Returns (samples, true_op_start_s).
    """
    body = _make_body(total_s)
    start = int(round((op_start_s + sub_frame_shift_s) * SAMPLE_RATE))
    end = start + len(op)
    if end > len(body):
        body = np.concatenate([body, np.zeros(end - len(body), np.float32)])
    mixed = body.copy()
    mixed[start:end] = 0.5 * mixed[start:end] + op  # OP dominates but not pure
    mixed /= (np.max(np.abs(mixed)) + 1e-9)
    return mixed.astype(np.float32), start / SAMPLE_RATE


def main() -> None:
    op_dur = 90.0          # >= 80s floor for an OP candidate
    total = 240.0          # 4-min fake episodes
    op = _make_op(op_dur)

    # Episode i has the OP at a different absolute start, each with its own
    # tiny sub-frame shift, to stress alignment precision.
    op_starts = [30.0, 31.3, 29.7, 30.0]
    shifts = [0.0, 0.004, -0.004, 0.0083]  # seconds; < one hop (11.6 ms)

    episodes = []
    truth = []
    for s, sh in zip(op_starts, shifts):
        samples, true_start = build_episode(op, s, total, sh)
        episodes.append(samples)
        truth.append(true_start)

    fps = [fingerprint(e) for e in episodes]
    print(f"hop = {HOP_SECONDS*1000:.2f} ms  (video frame @23.976fps = 41.7 ms)\n")
    print(f"{'pair':>6} {'true Δstart':>11} {'recovered':>10} "
          f"{'err(ms)':>8} {'votes':>6} {'span(s)':>8} {'span err':>9}")

    errs = []
    ref_fp = fps[0]
    for i in range(1, len(episodes)):
        m = best_match(fps[i], ref_fp)
        true_doff = truth[i] - truth[0]
        if m is None:
            print(f"{i:>6} {true_doff:>11.3f}   NO MATCH")
            continue
        err_ms = (m.offset_seconds - true_doff) * 1000
        errs.append(abs(err_ms))
        # The matched query span should line up with the true OP extent in ep i.
        true_span = op_dur
        span_err = m.duration - true_span
        print(f"{i:>6} {true_doff:>11.3f} {m.offset_seconds:>10.3f} "
              f"{err_ms:>8.2f} {m.n_votes:>6} {m.duration:>8.1f} {span_err:>9.2f}")

    if errs:
        print(f"\nmedian |offset error| = {np.median(errs):.2f} ms "
              f"(< one hop = {HOP_SECONDS*1000:.2f} ms means frame-accurate)")


if __name__ == "__main__":
    main()
