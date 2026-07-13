# RÉCAP — Détecteur d'intro/outro (OP/ED) via AnimeThemes.moe

> Note pour Claude Sonnet (assistant dev) : ce document explique **comment fonctionne
> le détecteur de timestamps OP/ED** dans `tools/opening-detector/`. Il a été rédigé
> après lecture du code réel (pas seulement de la mémoire). Lis-le en entier avant de
> proposer des modifs. Les fichiers cités sont sous `tools/opening-detector/`.
>
> **Mise à jour 2026-07-08** : section 4 (liste des hosts) et section 8 (TODO)
> corrigées après une session de débogage réelle sur SnK ep3. Voir §11 pour le
> changelog complet des bugs trouvés et corrigés depuis la rédaction initiale.

---

## 0. Le problème qu'on résout (et pourquoi c'est dur)

L'app NewAniScroll a un `SkipOverlay` (bouton « passer l'intro / l'outro »). Il lui
faut, **par épisode**, les timestamps où l'OP et l'ED commencent et finissent DANS
l'épisode (temps intra-épisode).

**Fait tranché et vérifié (ne pas re-poser la question) : AUCUNE API publique ne
donne ces timecodes intra-épisode pour l'anime.**
- Les sources crowdsourcées (AniSkip, Anime-Skip) ont une **mauvaise couverture** et
  se trompent souvent → abandonnées comme source de vérité (gardées au mieux comme
  sanity-check).
- AnimeThemes.moe donne la **chanson/vidéo OP/ED et la plage d'épisodes** couverte,
  mais **PAS** le timestamp intra-épisode (structurellement : ils stockent les OP/ED
  comme fichiers vidéo séparés, jamais l'épisode complet).

**L'idée-clé** : on **fabrique** nous-mêmes ce timestamp par *matching audio*.
AnimeThemes nous donne l'OP/ED « propre » (vidéo NC téléchargeable). On empreinte
(fingerprint) cette référence UNE fois, puis on cherche où elle apparaît dans chaque
épisode. Le pic de l'histogramme d'offset donne directement l'intervalle de skip.
C'est une donnée que personne n'a proprement → ça a de la valeur.

C'est un **outil offline autonome** : il ne touche JAMAIS Redis/Turso de l'app.
Livraison = batch offline → JSONL → (futur) importeur DB. Donc ffmpeg/détection
restent hors du request path et ne consomment aucun quota prod.

---

## 1. Vue d'ensemble du pipeline

```
  MAL/AniList id
       │  (oped/animethemes.py : /resource → slug → /anime/{slug})
       ▼
  Thèmes AnimeThemes  ──►  { OP1, OP2, ED1, ED2, … }  chacun :
       │                     - song/artistes
       │                     - episodes_spec  ("1-13", "2-18, 20-25", "1000"…)
       │                     - vidéo NC .webm téléchargeable  ← la RÉFÉRENCE
       ▼
  build_references()  (oped/theme_bank.py)
       │  télécharge la webm du thème, en extrait l'audio (ffmpeg),
       │  calcule le FINGERPRINT (oped/fingerprint.py), le met en cache (.fp.npz)
       ▼
  Pour CHAQUE épisode de l'app (résolu vers une URL de lecteur : sibnet, megaplay…) :
       │  detect_op_ed()  (oped/theme_bank.py)
       │    1. décode SEULEMENT 2 fenêtres courtes (OP = 4 premières min,
       │       ED = 3 dernières min) via ffmpeg input-seeking (oped/audio.py)
       │    2. fingerprint l'épisode, puis best_match(episode, référence)
       │       (oped/matcher.py) → histogramme d'offsets → pic
       │    3. le SPAN du pic (en temps épisode) = intervalle de skip
       ▼
  ThemeHit { kind: op|ed, start, end, votes, score }
       │
       ▼
  (batch)  batch_detect.py  →  JSONL { mal_id, episode, op, ed }
```

---

## 2. Les modules cœur (le « moteur » de matching)

Ces 3 modules sont **validés Étape 1** (test synthétique, erreur médiane **3,27 ms**,
sous un hop STFT donc « frame-accurate »). **Ne pas les casser** — tout le reste est
construit dessus sans les modifier.

### `oped/audio.py` — extraction audio + fenêtrage
- `load_audio(src, window=(start, dur), cache_key=…)` → renvoie du PCM mono float32
  à 11025 Hz.
- `src` peut être un fichier local OU **n'importe quelle URL** que ffmpeg lit
  (http/m3u8). C'est comme ça qu'on lit l'audio d'un lecteur streamé **sans
  télécharger la vidéo** (`-vn`, audio seulement).
- **Le fenêtrage est LA grosse optimisation.** `window=(start, dur)` place les
  options de seek **AVANT `-i`** → ffmpeg fait une requête HTTP Range (mp4) ou ne
  récupère que les segments HLS couvrants (m3u8). On décode donc seulement
  OP = `(0, 240)` et ED = `(-180, None)` au lieu des ~24 min. `start<0` → `-sseof`
  (seek depuis la fin), parfait pour l'ED. Gain ~5-8×.
- Le seek d'input est grossier (keyframe la plus proche), MAIS le matcher récupère
  l'alignement absolu quand même → la précision n'en souffre pas.
- **Piège cache** : une URL n'est PAS cachable par URL (les tokens signés tournent).
  Il FAUT passer un `cache_key` stable (ex. `"snk/s1/vostfr/ep1"`). La fenêtre est
  intégrée au nom de fichier cache → OP et ED cachent séparément sans collision.
- Certains hosts (megaplay, embed4me) renvoient 403 sur le m3u8 sans header
  `Referer` → passer `referer=…`.
- **`-allowed_extensions ALL -allowed_segment_extensions ALL -extension_picky 0`**
  sont nécessaires pour certains hosts HLS (megaplay's zapora CDN sert des segments
  media réels sous une extension déguisée type `.jpg`). ⚠️ Ce sont des options
  **privées du démuxer HLS** — elles n'existent pas pour un flux MP4 direct (ex.
  sendvid) et ffmpeg plante avec `Option ... not found` si on les passe quand même.
  `_ffmpeg_decode` les ajoute donc **conditionnellement**, via `_is_hls_url(src)`
  (test sur `.m3u8` dans le chemin de l'URL, hors query string) — jamais
  inconditionnellement. Voir §11.2.

### `oped/fingerprint.py` — empreinte façon Shazam (constellation)
- Spectrogramme log → pics locaux (constellation) → hachage de **paires de pics**
  `(f1, f2, dt)` packé en uint64, avec le temps de l'ancre.
- **Pourquoi maison plutôt que Chromaprint** : on ne veut pas un ID de piste, on veut
  un **offset temporel** précis entre deux enregistrements du même OP. Les hashes de
  constellation portent des temps d'ancre absolus → un histogramme de
  `(t_query − t_ref)` pique net sur le vrai alignement, récupérable à un hop STFT
  (~11,6 ms), plus fin qu'une frame vidéo (~41,7 ms à 23.976 fps). Chromaprint est
  ~10× plus grossier et ne donne pas d'offset de sous-segment.
- Le fingerprint est un `Fingerprint(hashes, times, n_frames)`, sérialisable
  (`.save`/`.load` en `.npz`).

### `oped/matcher.py` — vote d'offset par collisions de hash
- `best_match(q, r)` : pour chaque hash partagé entre query et référence, on calcule
  l'offset candidat `t_q − t_r`. Si le même OP est présent, plein de hashes tombent
  d'accord sur UN offset → pic net dans l'histogramme.
- Le pic donne l'alignement ; **le span des ancres qui ont voté donne le
  début/fin** du segment répété.
- **Détail important — `_dense_span`** : un segment répété est un *cluster dense*
  d'ancres. Quelques ancres coïncidentes ailleurs partagent le même offset par hasard
  et, avec un simple min/max, feraient exploser le span sur tout l'épisode (bug vu sur
  SnK : un bin ED s'étirait 165s→1531s). On prend donc le plus grand run contigu
  d'ancres (clustering par gap de 8 s) → span propre.
- `all_matches(q, r)` : renvoie TOUS les bins forts (pas seulement le top). Utile car
  OP et ED d'une même paire d'épisodes tombent dans deux bins d'offset distincts.
- `SeriesBank` : ancien mode épisode↔épisode (comparer tous les épisodes entre eux).
  **Ce n'est PAS le chemin recommandé** — on garde l'ancrage par référence
  AnimeThemes. Le SeriesBank ne récupère qu'un offset *relatif* et exige plusieurs
  streams complets du même host. On peut l'ignorer pour le dev courant.

---

## 3. L'ancrage par référence (le chemin recommandé)

### `oped/animethemes.py` — client AnimeThemes.moe
- `resolve_slug(mal_id=… | anilist_id=… | slug=…)` : id → slug via `/resource`
  (endpoint canonique `filter[site]` + `filter[external_id]`).
- `fetch_themes(slug)` : renvoie une liste de `Theme` normalisés. Chaque `Theme` a un
  `slug` ("OP1"), un `kind` ("op"/"ed"), une `song`, et des `entries` (versions).
  Chaque `ThemeEntry` a `version`, `episodes_spec`, `video_url`, `nc`, `resolution`.
- `parse_episode_spec` : le champ `episodes` est **libre et sale** — ranges
  (`"1-13"`), listes à trous (`"2-18, 20-25"` → ep 19 a un ED différent), single
  (`"1000"`), ou `None`. Ce parser en fait un test d'appartenance inclusif.
- `themes_for_episode(themes, episode)` → `{"op": Theme|None, "ed": Theme|None}` : les
  thèmes dont le mapping couvre cet épisode. En cas de conflit même-kind, la plus
  petite `sequence` gagne.
- `Theme.entry_for_episode(ep)` : choisit la meilleure entrée jouable (préfère une
  vraie vidéo, puis NC = sans crédits à l'écran = audio plus propre, puis résolution
  la plus haute).
- Cache disque des métadonnées (TTL 24 h, elles sont statiques) — bon citoyen API.

### `oped/theme_bank.py` — construit les références et détecte dans l'épisode
- `build_references(theme)` → une liste de `ThemeReference` (une par **version**
  jouable du thème). Empreinte chaque version UNE fois, cache PCM **et** fingerprint
  (`.fp.npz` + sidecar `.dur.txt`). Matcher un épisode contre toutes les versions
  rattrape le cas où la release utilise une coupe différente.
- `detect_op_ed(resolve_window, episode_duration, op_refs, ed_refs, …)` → `list[ThemeHit]` :
  1. Pour l'OP et l'ED : appelle `resolve_window(win)` (closure fournie par
     l'appelant qui résout/cache le stream) pour obtenir le fingerprint de la fenêtre.
  2. `_match_best_version` : matche contre toutes les versions, garde la plus forte
     (le plus de votes, au-dessus de `min_votes=40` et `min_score`).
  3. Convertit le span fenêtre-relatif en **temps épisode absolu** via `_abs_offset` :
     pour l'ED (start négatif = `-sseof`), l'offset absolu = `episode_duration + start`.
     ⚠️ Cette conversion suppose `episode_duration` correcte pour CE host — voir
     §11.1 pour le bug où une durée probe échouée corrompait silencieusement tout
     l'offset ED d'un host.
  4. **Fallback plein épisode** (`full_fallback=True`) : si la fenêtre rate, retente
     sur l'épisode entier (rattrape un long cold-open qui pousse l'OP hors fenêtre).
     Seulement en cas d'échec → le chemin rapide reste fenêtré.
- Un `ThemeHit` porte `kind`, `slug`, `start`, `end` (temps épisode absolu), `votes`,
  `score`, et `inferred` (True si matché via fallback de cour, sans mapping direct).

---

## 4. Multi-lecteur — robustesse aux durées différentes

### `oped/multi_host.py` (`--multi-host`)
**Le problème** : le même épisode chez deux hosts (Sibnet, megaplay, sendvid…) est un
**encode différent avec une durée totale différente** (cold-opens rognés, cartons de
pub, padding noir). Un timecode détecté chez A est donc faux chez B — **surtout
l'ED**, ancré depuis la fin : un delta de durée décale tout son start absolu.

**La solution — réconcilier sur la bonne quantité selon l'ancrage** :
- **OP** = ancré au **début**. On réconcilie sur le **start absolu** (le consensus
  rejette un host dont le cold-open diffère).
- **ED** = ancré à la **fin**. La quantité **indépendante de la durée** est
  **secondes-depuis-la-fin** (`duration − start`). Des hosts de 23:40 / 24:00 / 23:55
  s'accordent tous sur « 90 s avant la fin ». On réconcilie là-dessus, puis on
  re-projette sur la durée canonique (médiane des durées host).

- `HostStream` = un stream résolu (host, url, **sa propre** durée).
- `detect_op_ed_multi(streams, resolve_window_for, …)` : appelle `detect_op_ed` **une
  fois par host** (chacun avec SA durée, pour que la fenêtre `-sseof` de l'ED tombe
  juste), puis `reconcile_hits`. Un host défaillant est isolé (try/except) — ses pairs
  le portent.
- `reconcile_hits` : `_consensus` cluster les valeurs autour de la médiane, drop les
  outliers > ±4 s (`OUTLIER_TOLERANCE_S`), centre = moyenne pondérée par les votes.
- Sortie = `ReconciledHit`, **auto-descriptif** : `start`/`end` (absolus dans
  `canonical_duration`), `from_end_start`/`from_end_end` (ancre ED indépendante de la
  durée), `n_hosts_agree`/`n_hosts_total`/`spread_s` (confiance), `inferred`.
- **Pourquoi ces champs comptent pour l'app** : au runtime, `SkipOverlay` connaît la
  durée réelle du `<video>` actif → il doit **re-dériver l'ED depuis `from_end_*`**
  contre cette durée réelle. L'importeur DB DOIT propager ces champs en mode
  multi-host.
- ⚠️ **`MULTI_HOSTS` corrigé** (l'ancienne valeur `sibnet, embed4me, lpayer, sendvid,
  uqload` documentée ici ne correspondait plus au code réel) : c'est en fait
  `["sibnet", "sendvid", "megaplay", "vidmoly", "vidmoly-va"]`, défini dans
  `oped/adapter_aniscroll.py`. vidmoly/vidmoly-va passent par le CF Worker
  (`wrapWorkerM3U8`) pour garder leur token IP-bound valide ; megaplay a besoin d'un
  `mal_id` (embed dérivé de MAL id + numéro d'épisode, pas scrapé comme les autres) ;
  vidmoly-va a besoin d'un `va_slug` voir-anime séparé.
- ⚠️ **megaplay n'a AUCUN signal de langue** dans la construction de son embed (juste
  `mal_id` + numéro d'épisode) — voir §11.3. `VF_INCOMPATIBLE_HOSTS = {"megaplay"}`
  dans `adapter_aniscroll.py` l'exclut automatiquement de tout run `lang != "vostfr"`
  pour éviter qu'il ne reserve silencieusement le flux VOSTFR sous étiquette VF.

---

## 5. Le batch à l'échelle (2000 animes)

### `batch_detect.py`
- **Pré-filtre AnimeThemes-only** : résout chaque anime vers AnimeThemes et le skip
  (sans jamais fetch un stream) s'il n'a pas de thème/vidéo → enlève une grosse part
  du travail d'entrée.
- **Reprise** (`--resume`) : manifeste JSONL crash-safe (`oped/manifest.py`), skip les
  animes déjà `done`/`skipped`, last-write-wins (un anime retenté supersede son état
  échoué ; `failed` n'est PAS terminal → requeue).
- **Concurrence adaptative** : limiteur AIMD par host (`oped/throttle.py`) — grandit
  sur succès propres, divise par 2 sur 429/timeout/503 → s'auto-cale à ce que Sibnet
  tolère sans ban, pas de cap magique en dur.
- **Requeue** : les échecs transitoires ont une passe de retry en fin de run ; les
  permanents (404, « no sibnet array ») ne sont pas retentés.
- **Caches partagés** sur tout le run : fingerprints de référence, PCM des fenêtres
  épisode, URLs de stream résolues.
- Entrée = `--anime-list anime.json`, sortie = `--out results.jsonl`.
  ```
  python batch_detect.py --anime-list anime.json --out results.jsonl --resume
  python batch_detect.py --anime-list anime.json --out results.jsonl --multi-host --resume
  ```

### CONTRAT D'ENTRÉE (`anime.json`) — important
Le tool **ne dérive PAS** le mapping MAL↔slug↔saisons. C'est **l'app** (son season
resolver) qui doit générer :
```json
[{ "mal_id": 16498,
   "slug": "shingeki-no-kyojin",         // slug anime-sama
   "seasons": [{ "season_dir": "...", "lang": "vostfr", "ep_start": 1, "ep_end": 25 }] }]
```

---

## 6. Robustesse — « quand le thème n'est pas où AnimeThemes le dit »
1. Épisode **sans thème mappé** (trous dans `episodes`, ex. Kimetsu ep19) → fallback :
   matche quand même les refs OP/ED de la cour, flag `inferred`.
2. Thème **absent de la fenêtre** → `detect_op_ed` retente sur l'épisode entier
   (rattrape les longs cold-opens).
3. **Multi-versions** (JJK OP1 a 4 versions) → matche toutes, garde la meilleure.
4. **Rien ne matche** → trou explicite loggé (jamais de timestamp inventé).

---

## 7. Preuve que ça marche (validé en local, 2026-07-02)
- **Étape 1 (synthétique)** : erreur médiane d'offset **3,27 ms** — frame-accurate.
- **SnK ep1-2** via `probe_animethemes.py` : durées détectées parfaites (90 s = pile la
  longueur du thème), votes massifs (2857-4200).
- **On bat AniSkip** : SnK ep1 OP détecté à 2:03 vs AniSkip 0:47. Le diag montre que la
  référence s'aligne r_start=0.58s → r_end=90.35s (début→fin du webm) : SnK ep1 a un
  long cold-open ~2 min, **AniSkip pointe à tort le cold-open**, nous avons raison.
- **Multi-host** (synthétique) : 3 hosts 1420/1440/1435 s → ED `from_end=90.0s`
  `spread=0.0` (immunité à la durée prouvée) ; OP outlier +40 s correctement rejeté.
- **SnK ep3, run réel multi-host (2026-07-08)** : après les correctifs de §11, megaplay
  passe de `22:10-23:38` (durée fallback fausse 24:00) à `22:37-24:04` (durée réelle
  24:26), cohérent à ~5s près avec vidmoly-va `22:42-24:09` — dans la marge normale
  d'un encode différent.

### Environnement pour lancer
- **ffmpeg/ffprobe 8.1.2** installés manuellement (zip Gyan) dans `C:\ffmpeg\bin`,
  ajouté au PATH USER (winget avait échoué : accès refusé).
- Lancer les probes **depuis** `tools/opening-detector` (le CWD par défaut = racine
  projet). Deps : `pip install -r requirements.txt` (numpy/scipy).
- Harnais : `probe_animethemes.py` (SnK end-to-end), `probe_multihost.py` (spread de
  durée), `poc_synthetic.py` (Étape 1), `diag_match.py` / `diag_multi_host.py`
  (diagnostic par host, voir §9).

---

## 8. Ce qui RESTE à faire (TODO — c'est là que le dev continue)
1. **Script d'export `anime.json`** depuis la DB/app (le season resolver de l'app doit
   générer le contrat d'entrée du §5). ⚠️ Le tool ne le fait pas.
2. **Importeur JSONL → DB** pour l'API `pages/api/v2/skip/[malId]/[episode].ts`. En
   mode multi-host il DOIT propager `from_end_start`/`from_end_end`/`canonical_duration`
   **ET** gérer le nouveau nesting par langue `episodes[ep][lang] = {op, ed}` (voir
   §11.4 — ce n'est plus `episodes[ep] = {op, ed}` en mode `--multi-host`).
3. **Côté `SkipOverlay`** : re-dériver l'ED depuis `from_end_*` contre la durée réelle
   du lecteur actif (le composant connaît déjà la durée du `<video>`).
4. Valider `probe`/`batch` en local à plus grande échelle (venv numpy/scipy/ffmpeg).
5. **Confirmer/lever la mitigation megaplay/VF** (§11.3) : lire `bridge/resolve.mjs`
   pour savoir si l'embed megaplay peut réellement être dérivé en VF (auquel cas la
   vraie correction est côté bridge, pas l'exclusion côté Python actuelle).
6. `sendvid` échoue parfois à la résolution même (`resolution failed: []`) — pas
   encore investigué, indépendant des bugs de §11.

---

## 9. Outils de diagnostic

### `diag_match.py`
Diagnostic un-seul-host : montre l'alignement référence↔épisode en détail pour un
host/épisode donné.

### `diag_multi_host.py`
Le pendant multi-host de `diag_match.py` : lance la détection sur UN épisode, sur
CHAQUE host individuellement (pas de réconciliation), pour comparer côte à côte ce
que chaque lecteur produit — utile pour distinguer un bug systémique (même décalage
partout → bug de code, ex. la conversion abs-offset) d'un bug propre à un host
(encode réellement différent).
```
python diag_multi_host.py --anilist 16498 --slug shingeki-no-kyojin --season saison1 \
    --lang vostfr --ep 3 --kind ed --mal 16498 --va-slug shingeki-no-kyojin
```
Les hosts sont maintenant traités **en parallèle** (`ThreadPoolExecutor`, `--workers`,
défaut = tous les hosts en même temps) — c'est un run I/O-bound (subprocess Node +
ffprobe/ffmpeg réseau), donc le gain est proche du nombre de hosts. Si un host se met
à échouer sous concurrence (rate-limit CDN), baisser `--workers` avant de suspecter
un nouveau bug.

---

## 10. À NE PAS confondre — le dropdown OP/ED (fonctionnalité SÉPARÉE)
Il existe une autre feature qui **joue les clips NC AnimeThemes** dans la page info
(un 3e dropdown à côté saison/film). Ce n'est **PAS** le détecteur — c'est juste de la
lecture de vidéos NC. Fichiers : `lib/animethemes/themes.ts` (port runtime du client
python), `pages/api/v2/themes/[id].ts`, `components/anime/v2/OpEdPanel.tsx`. Ne pas
mélanger les deux chantiers.

---

## 11. Changelog des bugs trouvés et corrigés (session du 2026-07-08)

Trouvé en diagnostiquant un ED megaplay décalé de ~26s sur SnK ep3. Quatre bugs
distincts, ne pas les recasser en retouchant le code :

### 11.1 — `_probe_duration` fallback silencieux sur 1440.0s (`detect_anime.py`)
`ffprobe` échouait pour megaplay (403 sans `Referer`, puis segments `.jpg` rejetés
par l'allowlist d'extension par défaut) et un `except Exception: return 24*60.0`
avalait l'erreur sans logger. Conséquence en cascade : fenêtre `-sseof` de l'ED mal
calée + conversion abs-offset fausse de ~26s, et en mode multi-host un host dont la
durée amont est fausse vote un `from_end` faux (fausse le consensus ou se fait
rejeter comme outlier ±4s pour la mauvaise raison).
**Fix** : `_probe_duration(url, referer=None)` prend et transmet `referer`, plus les
flags HLS conditionnels (§11.2). L'`except` logge désormais un `[warn]` explicite
avant de retomber sur le fallback, au lieu d'échouer en silence.
**Propagé à** : les deux call-sites dans `detect_anime.py` (`run_single_host`,
`run_multi_host`), et le call-site dans `diag_multi_host.py` qui avait été oublié
lors d'une première passe de patch (`_probe_duration(e["url"])` sans `referer` —
c'est ce qui faisait encore apparaître le fallback 1440s dans les diagnostics même
après que `detect_anime.py` ait été corrigé).

### 11.2 — Flags HLS ajoutés inconditionnellement → crash sur hosts non-HLS
`-allowed_extensions ALL -allowed_segment_extensions ALL -extension_picky 0` sont des
options privées du démuxer HLS. Ajoutées sans condition dans `_ffmpeg_decode`
(`audio.py`) et `_probe_duration` (`detect_anime.py`), elles faisaient planter ffmpeg
sur sendvid (MP4 direct, pas HLS) avec `Option extension_picky not found`.
**Fix** : nouvelle fonction `_is_hls_url(src)` dans `audio.py` (teste `.m3u8` dans le
chemin de l'URL, hors query string), réutilisée par les deux fichiers pour rester
cohérente. Les flags HLS ne sont ajoutés que si `_is_hls_url(src)` est vrai.

### 11.3 — megaplay n'a aucun signal de langue
Constaté empiriquement : un run `--lang vf` contre megaplay renvoyait une durée
identique à la décimale près (`1466.5s`) au run `--lang vostfr` — signe que le même
flux VOSTFR est reservi sous étiquette VF. Cohérent avec le docstring existant :
l'embed megaplay est dérivé de `mal_id` + numéro d'épisode uniquement, jamais de
`lang`. **Mitigation appliquée** (pas une preuve définitive — voir TODO §8.5) :
`VF_INCOMPATIBLE_HOSTS = {"megaplay"}` dans `adapter_aniscroll.py`, appliqué dans
`resolve_episodes_multi` pour tout `lang != "vostfr"`, et dupliqué dans
`diag_multi_host.py` (qui appelle `resolve_episodes` directement, pas via
`resolve_episodes_multi`, donc ne bénéficiait pas du filtre automatiquement).

### 11.4 — `detect_anime.py --multi-host` : `--mal`/`--va-slug` absents + un seul `lang` par run
`detect_anime.py` n'avait **aucun argument `--mal`/`--va-slug`** : `run_multi_host`
appelait toujours `resolve_episodes_multi(..., mal_id=None, va_slug=None)`, donc
megaplay et vidmoly-va étaient **silencieusement exclus de tout run multi-host**,
même avant les bugs ci-dessus. Par ailleurs, un run ne couvrait qu'un seul `--lang` à
la fois, obligeant deux invocations séparées (VOSTFR puis VF) pour couvrir les deux.
**Fix** :
- `--mal` et `--va-slug` ajoutés et transmis à `resolve_episodes_multi`.
- `--langs vostfr,vf` (remplace `--lang` en mode `--multi-host`) : une passe par
  langue dans la même invocation, megaplay auto-exclu en VF via §11.3.
- **Format de sortie JSON changé** : `episodes[ep] = {op, ed}` devient
  `episodes[ep][lang] = {op, ed}` en mode `--multi-host` (mode single-host inchangé,
  reste plat). ⚠️ Tout consommateur (importeur DB notamment, voir TODO §8.2) doit
  être adapté à ce nesting avant bascule prod.
- **Écriture du fichier `--out` devenue incrémentale** : si le fichier existe déjà,
  il est chargé et fusionné épisode par épisode / langue par langue au lieu d'être
  écrasé — un run partiel (ex. un seul épisode pour valider) n'efface pas le reste
  d'un run précédent plus large.

### 11.5 — `diag_multi_host.py` : hosts traités en série
Aucune parallélisation : chaque host payait resolve (subprocess Node) + probe
(ffprobe réseau) + decode (ffmpeg réseau) l'un après l'autre, d'où des runs de
diagnostic à ~5 minutes pour 4-5 hosts. **Fix** : `ThreadPoolExecutor` (nouveau
`--workers`, défaut = tous les hosts en parallèle) — I/O-bound donc le GIL n'est pas
un obstacle (`subprocess.run` et les I/O réseau le libèrent). Les logs par host sont
bufferisés et affichés en bloc dans l'ordre de soumission pour rester lisibles malgré
l'exécution concurrente.

### 11.6 — Ancre ED `-sseof` fausse quand le seek keyframe déborde (megaplay 21:10→21:15)
**Symptôme** : megaplay ep3 livrait l'ED à **21:10-22:40** alors que le trio anime-sama
(sibnet/sendvid/vidmoly) et la vérité terrain sont à **21:15-22:44.9**. Un décalage
systématique de ~5s, uniquement sur megaplay.

**Fausse piste écartée (mesurée)** : ce n'était PAS un problème de précision audio ni
de landmarks vidéo. En décodant la fenêtre ED, l'audio place le thème à `theme_t0=15.07`
(temps fenêtre) et la vidéo à `25.0` — **10s d'écart pour le MÊME ED**. Un décodage
ffmpeg **fusionné** (un seul `-sseof`, deux sorties) ne corrige rien : l'écart persiste
→ ce n'est pas un désaccord de seek entre passes.

**Cause racine** : `-sseof 180` demande « 180s avant la fin », mais ffmpeg seeke à la
**keyframe la plus proche ≤ (EOF-180)** puis décode jusqu'à EOF. Sur le HLS de megaplay
le seek déborde : il ne décode que **175.08s** au lieu de 180. Or `_abs_offset` supposait
que la fenêtre commençait pile à `EOF-180`, donc **chaque timestamp ED partait 5s trop
tôt**. Le vrai début de fenêtre = `EOF - longueur_décodée_réelle`. Vérifié : `1434.99 -
175.08 + 15.07 = 1274.98 = 21:15.0` (cible 1274.99), fin `+90.05 = 1365.03 = 22:45.0`
(vérité terrain じゅじゅさんぽ 22:44.9). Le trio décode ~180s pile (179.96/180.00/180.00)
→ décalage ≤ 0.04s, **inchangé**.

**Fix** : `_abs_offset` calcule, pour une fenêtre à start négatif (`-sseof`), l'offset =
`episode_duration - longueur_décodée` au lieu de `episode_duration + start`. La longueur
décodée est fournie par un nouveau callback optionnel `resolve_window_duration(window)`
(câblé sur `cached_fingerprint`, qui renvoie déjà la durée depuis le sidecar `.dur.txt`
— gratuit en cache-hit). Fallback sur l'ancre nominale si le callback est absent. Le
paramètre est propagé dans `detect_op_ed`, `multi_host.detect_per_host` /
`detect_op_ed_multi`, et câblé aux deux chemins (`run_single_host` /
`run_multi_host`) de `detect_anime.py`. Auto-correctif : gère aussi bien un débordement
(décode <180s) qu'un sous-débordement (>180s).

**Note pour la suite (landmarks)** : le prototype d'ancrage sur image-repère (voir
`proto_landmark.py`) a été validé — la localisation de repères distinctifs est
extrêmement robuste, même sur megaplay (4/4 repères, Hamming 0-3, là où le raffineur
dense d'arête ne décodait qu'`n=1` frame). Mais ce n'était PAS le correctif megaplay
(la vidéo megaplay a en plus un offset A/V de ~5s propre à son décodage HLS seeké, qui
la rend peu fiable en temps absolu). Les landmarks restent un chantier ouvert pour les
**fondus** (bord OP/ED sur un aplat/fade où l'audio et l'arête dense échouent), pas pour
megaplay.

---

## 12. Résumé en une phrase
AnimeThemes nous donne l'OP/ED propre + la plage d'épisodes mais **pas** le timestamp
intra-épisode ; on empreinte le thème une fois (Shazam maison), on matche chaque
épisode contre lui par vote d'histogramme d'offsets, et **le span du pic EST
l'intervalle de skip** — récupéré en ne décodant que 2 fenêtres courtes par épisode,
réconcilié sur plusieurs lecteurs (et, depuis §11.4, sur plusieurs langues en une
seule commande) pour être robuste aux durées différentes.