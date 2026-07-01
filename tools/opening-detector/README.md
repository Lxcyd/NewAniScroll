# Anime OP/ED detector (frame-accurate)

Detects opening/ending timestamps per episode by **audio redundancy matching**,
not classification: OP/ED *repeat* across episodes, so the core is fingerprint
matching that recovers a precise time alignment between episodes.

## Status
- **Étape 1 (extraction + fingerprinting + matching core): DONE & validated**
  on synthetic audio with known ground truth.
- Étape 2 (sliding window + series bank, block-boundary map): not started.
- Étape 3 (mono-episode fallback): not started.

## Why homemade peak-hashing over Chromaprint
We need a **time offset** between two recordings of the same OP, not a track ID.
Constellation hashes carry absolute anchor times, so a histogram of
`(t_query − t_ref)` over colliding hashes peaks sharply at the true alignment —
recoverable to one STFT hop (~11.6 ms), finer than a 23.976 fps video frame
(41.7 ms). Chromaprint emits a coarse ~124 ms/frame fingerprint built for
whole-track ID and gives no sub-segment offset; kept only for the eval path.

## Layout
- `oped/audio.py` — ffmpeg → mono 11025 Hz PCM, cached to `cache/audio/`.
- `oped/fingerprint.py` — spectrogram → constellation peaks → paired hashes.
- `oped/matcher.py` — offset-histogram voting → `Match` (offset, span, votes).
- `poc_synthetic.py` — Étape 1 proof on synthetic episodes.

## Run the PoC
```
pip install -r requirements.txt
python poc_synthetic.py
```

## Étape 1 result (synthetic, ref = episode 0)
| pair | true Δstart | recovered | err (ms) | votes | span err (s) |
|------|------------:|----------:|---------:|------:|-------------:|
| 1    | 1.304       | 1.300     | −3.72    | 1500  | −0.34        |
| 2    | −0.304      | −0.302    | 2.18     | 2323  | −0.19        |
| 3    | 0.008       | 0.012     | 3.27     | 1920  | −0.10        |

Median |offset error| = **3.27 ms** — below one hop, i.e. frame-accurate.
