# RÉCAP — Détecteur d'intro/outro (OP/ED) via AnimeThemes.moe

Doc unique de reprise (remplace l'ancien RECAP + ROADMAP_FRAME_ACCURATE + STAGE4_PLAN).
Dernière mise à jour : 2026-07-15.

**En une phrase** : pour chaque épisode d'anime, on récupère l'OP/ED credited
d'AnimeThemes comme RÉFÉRENCE, on LOCALISE grossièrement le thème dans l'épisode par
l'audio, puis on PRÉCISE le bord au niveau frame par l'IMAGE (landmarks distinctifs),
et on livre `start`/`end` en temps épisode absolu — par lecteur, pour alimenter le
`SkipOverlay`.

---

## 0. Le problème et la décision de fond

Aucune API ne donne les timecodes intra-épisode (OP/ED start/end DANS l'épisode) —
vérifié sur données brutes AnimeThemes + AniSkip/Anime-Skip (mauvaise couverture,
écartés). AnimeThemes donne par anime : chanson, plage d'épisodes, et surtout la
**vidéo credited (.webm)** de l'OP/ED. On inverse donc le matching : fingerprint du
thème connu UNE fois, puis on matche chaque épisode contre lui.

**Décision cadrée (frame-accurate) :** précision ±1 frame (~42 ms à 23.976 fps).
- **L'audio mesure la MUSIQUE** (~12 ms, plus fin) → sert au REPÉRAGE grossier + au
  choix de version (OP1 vs OP2). Rien d'autre.
- **L'image credited mesure la COUPE VISUELLE** (le vrai événement à skipper) →
  AUTORITÉ UNIQUE du bord. Elle reste juste quand l'audio est le canal corrompu :
  fondu au noir (musique continue), carton silencieux, VF qui duck le thème sous
  les dialogues, encode qui trim l'audio.

---

## 1. Vue d'ensemble du pipeline (v2, chemin par défaut)

```
  MAL/AniList id
       │  oped/animethemes.py : resolve_slug → fetch_themes
       ▼
  Thèmes { OP1, OP2, ED1, ED2 } chacun : song, episodes_spec, .webm NC + credited
       ▼
  build_references()  (oped/theme_bank.py)
       │  - audio : fingerprint de chaque version, caché .fp.npz
       │  - image : décode NATIF (fps=None) du clip CREDITED → landmarks
       │            (frames distinctives, r_time frame-exact) + ref_native_dur
       ▼
  Pour chaque (épisode, lecteur, langue) : detect_op_ed_v2()
       │  A. LOCATE (audio, ABSOLU) : decode_audio_abs(fenêtre large) → best_match
       │     → theme_t0 GROSSIER + VERSION + ref choisie
       │  B. ALIGN (image, ABSOLU) : keyframe_hashes_abs(fenêtre native autour de t0)
       │     → anchor_by_landmarks → theme_t0 PRÉCIS (consensus de landmarks)
       │  C. BORDS : start = theme_t0 ; end = theme_t0 + ref_native_dur
       │  D. Fallback : consensus image faible → garde le t0 audio, low_confidence
       ▼
  ThemeHit { kind, slug, version, start, end (absolus),
             source: credited|audio, n_landmarks, consensus_frac, low_confidence }
       │
       ├─ multi-host : detect_op_ed_multi → reconcile_hits (CONTRÔLE DE CONFIANCE,
       │               plus une correction : chaque host est déjà frame-accurate)
       ▼
  (batch)  batch_detect.py  →  JSONL { mal_id, episode, op, ed }
```

**Fondation « horloge absolue partagée » (ce qui rend v2 possible) :**
`decode_audio_abs` et `keyframe_hashes_abs` décodent avec `-copyts` + `-ss` absolu +
`-to` (jamais `-t`, qui tronque à ~rien sur HLS avec -copyts). Résultat mesuré :
audio et vidéo portent le MÊME pts absolu (megaplay : vidéo 1260.0 / audio 1260.08).
→ theme_t0 audio et image sont directement comparables, sans ancre `-sseof` ni
réconciliation A/V. C'est ce qui a tué la classe de bugs `-sseof` (le « décalage A/V
de 10 s » megaplay était un artefact de `-sseof`, pas un vrai désync).

---

## 2. Les modules cœur (moteur de matching) — NE PAS CASSER

Validés Étape 1 (synthétique, erreur médiane 3,27 ms). Tout le reste est construit
dessus sans les modifier.

### `oped/audio.py`
- `load_audio(src, window=(start,dur), cache_key=…)` → PCM mono float32 11025 Hz.
  Fenêtrage = grosse optim : seek AVANT `-i` → HTTP Range (mp4) / segments HLS
  couvrants seulement. (Chemin LEGACY.)
- `decode_audio_abs(src, start_abs, dur)` → `(samples, abs_start)`. Décode en ABSOLU
  (`-copyts` + `-ss` + `-to`). `abs_start` récupéré via `ashowinfo` (le seek arrondit).
  **Chemin v2.**
- `_is_hls_url(src)` : les flags `-allowed_extensions ALL …` sont PRIVÉS au démuxer
  HLS → ajoutés seulement si `.m3u8` (sinon ffmpeg plante sur MP4 direct type sendvid).
- Cache : jamais par URL (tokens signés tournent) → passer un `cache_key` stable.
  Certains hosts (megaplay) : 403 sans header `Referer`.

### `oped/fingerprint.py` — empreinte façon Shazam (constellation)
- Spectrogramme → pics → hash de paires `(f1,f2,dt)` packé uint64 + temps d'ancre.
- Maison (pas Chromaprint) car on veut un OFFSET temporel précis (histogramme de
  `t_q − t_r` pique net, récupérable à un hop STFT ~11,6 ms), pas un ID de piste.

### `oped/matcher.py` — vote d'offset par collisions de hash
- `best_match(q, r)` : offset le plus voté = alignement ; span des ancres = segment.
- `_dense_span` : plus grand run contigu d'ancres (clustering gap 8 s) → span propre
  (sinon des coïncidences lointaines feraient exploser le span sur tout l'épisode).
- `SeriesBank` (épisode↔épisode) = ANCIEN mode, PAS le chemin recommandé, ignorer.

### `oped/video_fingerprint.py` — empreinte image (dHash keyframes)
- `keyframe_hashes_abs(src, start_abs, dur, fps=None, cache_key=…)` : décode en ABSOLU.
  `fps=None` = toutes les frames NATIVES (pts réel) → précision ±1 frame. Cache
  optionnel par (cache_key, start_abs, dur, fps) arrondi 0,1 s.
- `pick_landmarks(vfp)` : choisit ~15-24 frames DISTINCTIVES (plancher `min_unique=10`
  bits + écart temporel `min_gap 3 s`). Une frame distinctive a un dHash rare → se
  relocalise nettement dans l'épisode (contrairement à un aplat/fondu qui matche
  « partout »).
- `anchor_by_landmarks(ep_vfp, landmarks)` → `LandmarkAnchor(theme_t0, n_accepted,
  consensus_frac, …)`. Pour chaque landmark : meilleure frame épisode par Hamming,
  ACCEPTÉE si distance ≤ 8 ET 2e-meilleure ≥ 6 plus loin (localisation non ambiguë).
  **Estimateur = MODE, pas médiane** : les estimations forment un mode net sur la
  grille frame 23.976 fps avec quelques outliers à ±N frames entières (landmark
  relocalisé sur la frame GOP voisine) ; on snappe à la grille, prend le mode, moyenne
  ±1 frame. `consensus_frac` (fraction à ±1 frame du mode) = le signal de CONFIANCE.
- `refine_edge_credited_video` / `decode_dense_window` : raffineur dense d'arête
  (chemin LEGACY ; pas branché dans v2 — voir §6 « ED trimés »).

---

## 3. Références & détection (`oped/theme_bank.py`)

- `build_references(theme, with_video=True)` → `list[ThemeReference]` (une par version).
  - audio : `fp` + `duration`, caché `.fp.npz`.
  - image : `video_fp` 2fps (legacy cross-confirm) ; **landmarks + `ref_native_dur`**
    depuis un décode NATIF du clip credited (Stage-3 fix : un décode 2fps quantifie
    r_time à 0,5 s et biaise toute projection).
  - Robustesse : `_native_ref_ok` (ne cache/traite JAMAIS un décode dégénéré <500
    frames / <60 s) + `_decode_native_ref` (retry borné + LOCK sérialisant les décodes
    natifs lourds — sinon les décodes concurrents se font rate-limiter par
    animethemes.moe et 0 frame était caché en dur).
- `ThemeReference` : `kind, slug, version, fp, duration, video_fp, video_ref_url,
  landmarks, ref_native_dur`.
- `detect_op_ed_v2(episode_duration, op_refs, ed_refs, resolve_audio_abs,
  resolve_video_abs=None, …)` → `list[ThemeHit]` — LE détecteur par défaut (§1.A-D).
  `resolve_video_abs=None` (ou `--no-video`) → skip ALIGN, tout en fallback audio.
- `ThemeHit` : `start`/`end` absolus, `source` (credited/audio), `n_landmarks`,
  `consensus_frac`, `low_confidence`, + champs legacy (`votes`, `score`, `inferred`,
  `confirmed_by_video`…) gardés pour compat.
- `detect_op_ed(...)` = ANCIENNE cascade (override guards, `_abs_offset`, dense refine…).
  Encore présente, accessible via `--legacy`. À SUPPRIMER une fois v2 validé large.

---

## 4. Multi-lecteur (`oped/multi_host.py`)

Chaque host sert un encode différent (durée/trim ≠). On détecte par host EN ABSOLU,
puis `reconcile_hits` fait un **contrôle de confiance** (plus une correction) :
- OP ancré sur le start ; ED ancré sur les SECONDES-FROM-END (indépendant de la durée),
  re-projetable sur la durée du `<video>` joué au runtime.
- Outliers >±4 s droppés, `spread`/`agree` rapportés. `reconcile_hits` ne lit que
  `source`/`votes`/flags (tous peuplés par v2) → marche tel quel avec v2.
- `detect_per_host` / `detect_op_ed_multi` : params `resolve_audio_abs_for` /
  `resolve_video_abs_for` + `v2=True`.

---

## 5. CLI, batch, contrat d'entrée

**CLI** `detect_anime.py` (v2 par défaut ; `--legacy` = ancienne cascade) :
```
# single-host
python detect_anime.py --anilist 113415 --slug jujutsu-kaisen --host sibnet --start 3 --end 3
# multi-host VO+VF (megaplay + vidmoly-va via --mal/--va-slug)
python detect_anime.py --anilist 113415 --slug jujutsu-kaisen --multi-host \
    --langs vostfr,vf --start 3 --end 3 --mal 40748 --va-slug jujutsu-kaisen
```
`--no-video` = audio seul (skip ALIGN). `--out fic.json` = écriture incrémentale
(fusion par épisode/langue). Sortie multi-host nichée : `episodes[ep][lang] =
{per_host:{host:{op,ed}}, consensus:{op,ed}}`. Single-host reste plat
`episodes[ep] = {op, ed}`.

**Batch** `batch_detect.py` : runner 2000 animes, pré-filtre AnimeThemes-only, reprise
`--resume`, throttle AIMD par host (`oped/throttle.py`), manifest JSONL
(`oped/manifest.py`), sink `{mal_id, episode, op, ed}`.

**Contrat d'entrée batch** : JSON `[{mal_id, slug(anime-sama), seasons:[{season_dir,
lang, ep_start, ep_end}]}]`. Le tool NE dérive PAS le mapping MAL↔slug↔saisons —
c'est l'app (son season resolver) qui génère ce `anime.json`.

**Cache v2** : fenêtres absolues audio (`absa/…`) et vidéo (`absv/…`) cachées par
(base_key, start_abs, dur, fps) — re-run ~2× plus rapide. Refs natives credited :
`…+cred.native.vfp.npz`.

---

## 6. État actuel & ce qui RESTE

**FAIT (branche dev) :** Stages 1-2 (horloge absolue + landmarks), Stage 3 (theme_t0
frame-accurate par mode-consensus), Stage 4 steps 1-5a — v2 est le chemin PAR DÉFAUT,
single + multi-host, avec cache.

**Validé E2E (JJK ep3, multi-host VO+VF, 9 lignes host×lang, TOUTES credited) :**
- megaplay ED **21:15** (fin du bug -5 s → 21:10) ; vidmoly-va OP **3:12** (fin du bug
  +15 s → 3:28) ; trio (sibnet/sendvid/vidmoly) inchangé.
- ED fin 22:44.9-22:45.1 vs coupe terrain じゅじゅさんぽ ~22:44.9 → frame-accurate.
- 2 clusters d'encode (sendvid/sibnet ~21:14.9 vs megaplay/vidmoly/-va ~21:15.11) :
  vraie diff par host, préservée en timing par-hôte (jamais moyennée) ; consensus
  spread 0.15-0.27 s. Confiance image par host 71-94 %.
- SnK ep1 (cold-open ~2 min) : OP1 2:02 localisé (fallback audio, pas de rip credited),
  ED1 credited 94 %. Métrique = `consensus_frac` PAR HÔTE, PAS l'accord cross-host
  (le contenu POST-ED diffère légitimement entre hosts).

**RESTE — étape 5b : supprimer l'ancienne cascade** (`detect_op_ed`, `_apply_video`,
`_video_sourced_hit`, `_refine_credited_dense`, `_abs_offset`, `resolve_window_duration`,
constantes `*_OVERRIDE_*`/`VIDEO_EDGE_*`/`CREDITED_ALIGN_MIN_VOTES`/
`DENSE_AUDIO_SHARPEN_BAND_S`…) + le flag `--legacy`. ⚠ À FAIRE seulement quand v2 aura
tourné sur PLUS d'animes que JJK/SnK (le filet legacy existe pour ça).

**À surveiller avant 5b :**
- Sélection de VERSION OP par fill audio : v2 a pris OP1 v1 vs legacy v2 sur JJK ep3.
  Cuts OP1 quasi identiques → cosmétique pour le timing, mais tester sur un titre où
  les versions diffèrent VRAIMENT (durée/cut).
- Bord « end » des ED TRIMÉS : v2 fait `end = theme_t0 + ref_native_dur` systématique
  (OK JJK/SnK). Si un host coupe l'ED avant la fin du clip credited, brancher un refine
  « end » (l'outil `refine_edge_credited_video(edge_kind="end")` existe mais renvoyait
  None — à déboguer : fenêtres ref/épisode natives + ref_native_dur, garde-fou =
  n'accepter que si la fin détectée est ANTÉRIEURE et proche).

**TODO câblage app (hors détecteur) :**
1. Script export `anime.json` depuis la DB/app (season resolver).
2. Importeur JSONL→DB pour `pages/api/v2/skip/[malId]/[episode].ts` : propager
   `from_end_*`/`canonical_duration` + gérer le nesting par langue en multi-host.
3. `SkipOverlay` : re-dériver l'ED depuis `from_end_*` vs la durée du `<video>` actif.
4. megaplay/VF : `VF_INCOMPATIBLE_HOSTS={"megaplay"}` est une MITIGATION (embed dérivé
   de mal_id+ep, pas de lang) — confirmer/lever en lisant `bridge/resolve.mjs`.
5. `sendvid` échoue parfois à la résolution (`resolution failed: []`) — non investigué.

---

## 7. Outils de diagnostic
- `diag_match.py` : alignement référence↔épisode détaillé, un host.
- `diag_multi_host.py` : détection par host (sans réconciliation) côte à côte —
  distingue un bug systémique (même décalage partout) d'un encode réellement différent.
  Hosts en parallèle (`--workers`) ; baisser `--workers` si rate-limit CDN avant de
  suspecter un bug.
- `proto_native.py` / `proto_native2.py` / `proto_v2_ab.py` : harnais de validation
  Stage 3-4 (landmarks natifs, sweep d'estimateur, A/B v2). Pas du code de prod.

---

## 8. À NE PAS confondre — le dropdown OP/ED (feature SÉPARÉE)
Une autre feature JOUE les clips NC AnimeThemes dans la page info (3e dropdown). Ce
n'est PAS le détecteur. Fichiers : `lib/animethemes/themes.ts`,
`pages/api/v2/themes/[id].ts`, `components/anime/v2/OpEdPanel.tsx`. Chantiers distincts.

---

## 9. Historique des bugs corrigés (ne pas recasser)
- **Durée probe silencieuse** (`_probe_duration`) : ffprobe échouait sur megaplay (403
  sans Referer, segments `.jpg` rejetés) et un `except` avalait l'erreur → offset ED
  corrompu ~26 s. Fix : `referer` + flags HLS conditionnels + `[warn]` explicite.
- **Flags HLS inconditionnels** → crash sur MP4 direct (sendvid). Fix : `_is_hls_url`.
- **megaplay sans signal de langue** : embed dérivé de mal_id+ep, jamais de lang →
  `VF_INCOMPATIBLE_HOSTS={"megaplay"}` (mitigation, cf. §6 TODO 4).
- **Ancre ED `-sseof` fausse** quand le seek keyframe déborde (megaplay 21:10→21:15,
  décodait 175 s au lieu de 180). Fix legacy `_abs_offset`. RENDU OBSOLÈTE par v2
  (horloge absolue, plus de `-sseof`).
- **_dense_span** : span ED qui explosait 165→1531 s sur des coïncidences lointaines.
- **theme_t0 bruité (Stage 3)** : cause = estimateur + fourniture de landmarks (pas
  l'acceptation). Fix : landmarks natifs + plancher `min_unique` + estimateur MODE.
- **Décodes natifs credited rate-limités** (build_references concurrent) → 0 frame caché
  en dur → OP toujours en fallback audio. Fix : `_native_ref_ok` + retry + LOCK.
