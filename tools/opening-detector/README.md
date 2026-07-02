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

## AnimeThemes reference anchoring (recommended path)
Instead of matching episode ↔ episode (needs several full streams from the
*same host* with aligned cuts, and only recovers a *relative* offset),
[AnimeThemes.moe](https://animethemes.moe) hands us the exact OP/ED as a clean,
downloadable NC `.webm` plus the episode range each theme covers (`"1-13"`). So
we **fingerprint the known theme once** and match each episode against it — the
offset-histogram peak's query span *is* the skip interval, in episode time. The
`episodes` field tells us which theme to expect per episode, so we only match
the right reference. No changes to the audio/fingerprint/matcher core:
`load_audio` already reads any URL, and `best_match` is already query↔reference.

Lookup: MAL/AniList id → `/resource` → slug → `/anime/{slug}` themes. Note this
gives the theme *song/video/episodes*, **not** the in-episode timestamp — that
timestamp is exactly what our matcher derives.

### Speed — the episode download is the bottleneck
We never decode the whole ~24 min episode. Because we already know *which*
theme to look for and OP/ED only live at predictable spots, we decode two
short **windows** per episode via ffmpeg input seeking (`load_audio(window=)`):
OP = first 4 min, ED = last 3 min (`-sseof`). ffmpeg then HTTP-range-requests
(mp4) or fetches only the covering HLS segments (m3u8) — a ~5–8× cut in both
transfer and decode. Reference themes are fingerprinted once per (anime,
theme, version) and the **fingerprint itself** is cached (`.fp.npz`), so
re-runs skip the spectrogram too. Coarse input seeking is fine: the
offset-histogram matcher recovers absolute alignment regardless.

Note: this detector is a standalone offline tool — it never touches the app's
Redis/Turso. Delivery is offline-batch → DB/JSON, so ffmpeg/detection stay off
the request path and burn no prod quotas.

### Scale — the 2000-anime batch (`batch_detect.py`)
Windowing speeds up one episode; the batch makes 2000 anime survivable:
- **Pre-filter**: resolve each anime to AnimeThemes and skip it (no stream ever
  fetched) when it has no theme/video — removes a big slice of work up front.
- **Resume**: a crash-safe JSONL manifest (`oped/manifest.py`) skips anime
  already `done`/`skipped` on `--resume`; last-write-wins so a retried anime
  supersedes its failed state.
- **Adaptive concurrency**: a per-host AIMD limiter (`oped/throttle.py`) grows
  parallelism on clean successes and halves it on 429/timeout, self-tuning to
  the most Sibnet tolerates without a ban — no hard-coded magic cap.
- **Requeue**: transient failures get one retry pass at end of run; permanent
  ones (404, "no sibnet array") are not retried.
- **Shared caches**: reference fingerprints, episode PCM windows, and resolved
  stream URLs are reused across the whole run.

Input is a JSON list the app already knows (`{mal_id, slug, seasons:[…]}` — the
app owns the MAL↔anime-sama↔season mapping via its season resolver). Output is a
JSONL of `{mal_id, episode, op, ed}` for a separate DB importer.
```
python batch_detect.py --anime-list anime.json --out results.jsonl --resume
```

### Multi-host — robust to per-player duration differences (`--multi-host`)
The same episode from different players/hosts is a **different encode with a
different total duration** (trimmed cold-opens, ad-cards, black padding). A skip
time detected on one host is therefore wrong on another — worst on the **ED**,
which is anchored from the end, so a duration delta shifts its absolute start by
that whole delta.

`--multi-host` resolves each episode from *every* audio-capable host
(`oped/multi_host.py` + `resolve_episodes_multi`), detects the OP/ED against
**each host's own duration**, then reconciles:
- **OP** on absolute start (consensus rejects a host whose cold-open differs);
- **ED** on **seconds-from-end** (`duration − start`), which is
  duration-INDEPENDENT — hosts of 23:40 / 24:00 / 23:55 all agree on "90 s
  before the end". Absolute times are re-projected onto the median (canonical)
  duration; outliers past ±4 s of the consensus are dropped; votes weight it.

Multi-host rows carry extra fields the importer should keep so the API/player
stays correct on any encode:
`canonical_duration`, `from_end_start`, `from_end_end` (ED re-projection anchor),
`hosts_agree`/`hosts_total` and `spread` (confidence). At playback time the
client (SkipOverlay already knows the `<video>` duration) re-derives the ED from
`from_end_*` against the ACTIVE player's real length.
```
python batch_detect.py --anime-list anime.json --out results.jsonl --multi-host --resume
```

### Robustness — when the theme isn't where AnimeThemes says
- Episode with **no mapped theme** (holes in `episodes`, e.g. Kimetsu ep19):
  fall back to matching the cour's OP/ED refs anyway, flagged `inferred`.
- Expected theme **not found in the window**: `detect_op_ed` retries against
  the full episode (rescues long cold-opens) before giving up.
- Multiple theme **versions** (JJK OP1 has 4): match all, keep the best.
- Nothing matches → explicit hole (no invented timestamp), logged.

## Layout
- `oped/audio.py` — ffmpeg → mono 11025 Hz PCM, cached to `cache/audio/`.
- `oped/fingerprint.py` — spectrogram → constellation peaks → paired hashes.
- `oped/matcher.py` — offset-histogram voting → `Match` (offset, span, votes).
- `oped/animethemes.py` — AnimeThemes client: id→slug, themes, `episodes` parser.
- `oped/theme_bank.py` — fingerprint the clean theme, `detect_in_episode`.
- `probe_animethemes.py` — end-to-end SnK validation vs AniSkip ground truth.
- `poc_synthetic.py` — Étape 1 proof on synthetic episodes.

## Run the AnimeThemes probe
```
python probe_animethemes.py   # SnK S1: recovered OP/ED start-end vs AniSkip
```

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
