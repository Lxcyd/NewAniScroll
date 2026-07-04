"""Frame-accurate OP/ED detector for anime episodes.

Core idea: OP/ED segments REPEAT across episodes, so detection is audio
redundancy matching (fingerprinting), not semantic classification.

Pipeline (cascade):
  1. extract  -> mono ~11kHz audio per episode (cached)
  2. fingerprint -> constellation peak hashes with absolute frame times
  3. match    -> cross-episode offset via hash-collision histogram voting
  4. (later) sliding window + series bank, then mono-episode fallback
"""

__all__ = ["fingerprint", "matcher", "audio"]

# Shared audio analysis constants. These define the time grid; the matcher's
# precision is bounded by HOP_SECONDS, so we keep the hop small.
SAMPLE_RATE = 11025          # Hz, downsampled mono is enough for OP/ED matching
N_FFT = 1024                 # ~93 ms window at 11025 Hz
HOP = 128                    # samples per STFT hop
HOP_SECONDS = HOP / SAMPLE_RATE  # ~11.6 ms -> sub-frame time resolution
