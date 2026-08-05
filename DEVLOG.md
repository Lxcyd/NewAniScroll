# DEVLOG

## 2026-08-05 (2) — OP/ED : passe sur les 6 lecteurs + megaplay corrige (fenetre ED)

Test demande par Luc : `diag_multi_host.py` sur tous les lecteurs affiches.
Resultat : **6/6 resolvent et detectent**, mais la passe a revele un bug megaplay
que la passe precedente ne pouvait pas voir.

### Etat par lecteur (SnK ep3 vostfr + erased ep3 vostfr)
| host | SnK OP | SnK ED | erased ED |
|---|---|---|---|
| sibnet | 0:01-1:30 | 22:25-23:53 | non propose |
| megaplay | 0:17-1:47 | 22:42-24:10 | 21:21-22:46 |
| ansembed | 0:00-1:30 | 22:24-23:51 | 21:19-22:43 |
| vidmoly-va | 0:01-1:31 | 22:42-24:10 | — |
| uqload | 0:00-1:30 | 22:25-23:53 | non propose |
| sendvid | non propose | non propose | 21:21-22:46 |

« non propose » = anime-sama ne liste pas ce host pour cette saison (pas une panne).
Les ecarts d'absolu suivent les durees d'encode (megaplay 24:27 vs 24:11) : c'est
exactement ce que `from_end_*` neutralise cote client.

### Bug corrige : megaplay perdu sur la fenetre ED
Deux defauts en serie, tous deux invisibles jusqu'ici :
1. **`_ffmpeg_decode` (chemin fenetre) ne de-PNG-ait pas megaplay** — seul
   `decode_audio_abs` le faisait. Or c'est le chemin fenetre que `detect_anime`
   appelle. Quand le CDN rotatif sert des segments PNG-wrappes (mesure sur
   `megap.norami.top`), ffmpeg lit un `Video: png` sans audio et le host tombe en
   « fetch failed ». SnK passait parce que SON CDN servait du non-wrappe : le host
   avait l'air sain.
2. **`-ss` de ffmpeg est RELATIF au `start_time` du conteneur** (il ajoute
   `ic->start_time` ; `-seek_timestamp 1` ne l'annule pas en mpegts — mesure). Le
   .ts materialise commence a `start_abs - _LEAD_S`, pas a 0 : passer l'absolu
   seekait au double, au-dela de l'EOF, 0 frame. Ne mordait que les fenetres
   tardives — l'ED. Une fenetre OP (fichier partant de ~0) marchait.

Ajouts : `megaplay.playlist_duration()` (somme des EXTINF) pour ancrer le `-sseof`
negatif sans demuxer, et `audio._container_start()` pour convertir l'absolu en
relatif. `-copyts` garde les pts de SORTIE absolus, donc l'horloge partagee tient.

**Effet mesure** : erased ED megaplay passe de « fetch failed » a 21:21-22:46,
identique a sendvid. Et SnK ED megaplay passe de 22:37 (3162 votes) a **22:42
(4478 votes)** — soit exactement ce que rapporte vidmoly-va, donc l'ancien chemin
donnait deja un resultat legerement FAUX sans le signaler.

### 2e bug, trouve parce que Luc a dit « il y a clairement une erreur »
Le tableau ci-dessus annoncait ED 21:42 pour vidmoly-va sur erased. Verification a
l'image (frames extraites du stream) : derniere scene a 21:19, fondu au noir
21:21-21:24, premier credit « CAST » a 21:28. Donc 21:42 etait FAUX — et l'app,
elle, affichait « Outro » a 21:23, c-a-d juste.

Cause : les DEUX outils de diag (`diag_multi_host.py`, `diag_match.py`) ancraient la
fenetre ED sur le nominal `ep_dur + start_s`. Or `-sseof -180` seeke a la frontiere de
segment AU PLUS TARD egale a EOF-180, puis decode jusqu'a EOF : mesure 197.8s decodes
pour 180s demandes sur le HLS vidmoly de voir-anime. L'ancre nominale etait donc 18s
trop tard, et poussait chaque timestamp ED de +18s. `theme_bank._abs_offset` faisait
DEJA la correction (ancre = EOF - duree reellement decodee) — c'est le chemin de prod ;
seuls les outils de diag mentaient. Le matcher n'a jamais ete en cause.

Corrige : `_window_offset()` dans diag_match.py, partage par diag_multi_host.py.
Apres correction, les 4 hosts d'erased s'accordent (21:21 x3, 21:24 pour vidmoly-va
dont l'encode a +7s) et SnK ne bouge quasiment pas (ses hosts decodent bien 180s).

A noter : `_measure_actual_window_start`, ecrit exactement pour attraper ce genre
d'ecart, renvoie None sur tous les hosts (colonne « measured win » = n/a) — le
garde-fou etait mort, personne ne l'a vu. Reste a reparer.

### Piege releve
Le slug voir-anime a change : `shingeki-no-kyojin-vostfr` 404, c'est
`shingeki-no-kyojin` (sans suffixe de langue). Un `--va-slug` perime ressemble a
un host en panne.

`test_guards.py` : 65 assertions vertes.


## 2026-08-05 — OP/ED : 4 lecteurs au lieu d'1 (megaplay, ansembed, DNS box)

Parti d'une question de Luc (« quel lecteur as-tu mesure ? »), fini sur trois bugs
distincts qui se masquaient l'un l'autre. Verification de depart : sur sibnet notre
ED SnK ep1 (23:55 -> 25:24.9) est JUSTE, verifie en extrayant les frames (23:50
derniere scene, 23:55 fondu au noir, 24:00 visuels de l'ED, 25:20 generique, 25:28
preview). Le 24:05 observe par Luc venait d'un AUTRE encode (voir-anime/vidmoly).

### 1. Le pont n'expliquait jamais un echec (commit 1e75bf0)
`out.errors` n'etait affecte que dans `episodes.length > out.episodes.length`. Un
host resolvant ZERO episode (0 > 0 = faux) voyait ses raisons JETEES : l'echec
total, le cas qui demande le plus d'etre explique, etait le seul a n'expliquer
rien. D'ou le `resolution failed: []` uniforme, deja note comme non diagnosticable
le 29/07. Les erreurs s'accumulent maintenant, prefixees par host, et `pickArray`
vide dit « not offered by anime-sama for this season » (absence de donnee != panne).

### 2. megaplay muet depuis une rotation de CDN (commit cf6e76c)
`is_megaplay()` reconnaissait le stream sur une liste FIGEE de domaines CDN ; le CDN
est passe a `megap.shiora.top`. La branche de-PNG etait donc court-circuitee, ffmpeg
lisait la playlist brute — dont les premiers segments sont des PUBS au format PNG —
concluait `Video: png` sans audio, et ne sortait rien. Zero erreur, zero hit. Le
commentaire du code disait deja « its CDN hosts rotate ». **Le REFERER
(`https://megaplay.buzz/`) est le signal stable**, pas le hostname du CDN.

### 3. Le DNS de la box bloque en IPv6 seulement
`uqload.is` et `vidmoly.net` -> `::1` via le resolveur IPv6 de la box Bouygues,
alors que l'IPv4 (8.8.8.8) rend les vraies IP Cloudflare. Le fichier hosts est vide,
ce n'est pas un blocage local. L'app n'est pas affectee (Worker + proxy.aniscroll),
seul l'outil local tape ces domaines en direct. **Non corrige** : changer le DNS
IPv6 de l'interface demande l'elevation. Commande a passer en admin :
`Set-DnsClientServerAddress -InterfaceAlias "Ethernet 2" -ServerAddresses ("2606:4700:4700::1111","2606:4700:4700::1001")`.

### 4. Ansembed implemente (commit 3e4db04) — app + detecteur
anime-sama liste 5 lecteurs pour SnK S1 (sibnet, ansembed, uqload, embed4me,
minochinos) et on n'en exploitait que 2. **ansembed.net EST vidmoly** sous domaine
white-label (meme page, meme master.m3u8) mais c'est une entree anime-sama distincte
avec ses propres uploads -> un encode de plus. Host `ansembed` PROPRE, pas un alias
de `vidmoly` : partager les lignes servirait le timing d'un encode sur l'autre.
**Bonus** : ansembed.net n'est pas dans la liste de blocage de la box, donc
l'extraction vidmoly-va remarche en local via ce miroir.

Resultat SnK ep1 VOSTFR, de 1 lecteur exploitable a 4 :
```
sibnet     OP 2:03.0  ED 23:55.0  image
ansembed   OP 2:03.2  ED 23:55.2  image
vidmoly-va OP 2:03.8  ED 24:05.7  image   <- l'encode que Luc regardait
megaplay   OP 2:19.6            audio   <- encode +16.6s en tete
```
Consensus OP 3/4 spread 0.77s, ED 2/3 spread 0.17s : les deux servis.

### Calibration corrigee par ces donnees reelles
- `peak_margin` mesure **0.001-0.005** sur des matches corrects (seuil 0.6) et
  `av_delta` **4 a 66 ms** quand les deux signaux s'accordent (seuil 4s) : enormement
  de marge, les gardes ne peuvent pas mordre sur un vrai positif.
- **`av_divergence` ne bloque plus un hit dont le timing vient de l'IMAGE.** Sur
  ansembed l'audio etait a 12.6s d'un ancrage image que 3 autres hosts confirment a
  0.2s pres : bloquer aurait jete un intervalle correct au nom du signal qu'il venait
  de corriger. Reste rapporte en consultatif (`audio_diverged`).
- `SERVE_MAX_SPREAD_S` valide sur du reel : megaplay a 16.6s d'ecart en tete est
  exclu du consensus (3/4) au lieu de le polluer.
- `align_status` distinguait mal « l'image n'a rien dit » de « l'image n'a pas
  confirme » (commit b3e7b39) — les deux retombaient sur `absent`.

### 5. DNS corrige (05/08, machine de Luc) — 5 lecteurs
`Set-DnsClientServerAddress -InterfaceIndex 19 -ServerAddresses ("2606:4700:4700::1111","2606:4700:4700::1001")`
en PowerShell ADMIN (l'IPv4 etait deja sur 8.8.8.8 ; c'est le resolveur IPv6 de la box
qui sinkholait vers `::1`/`127.0.0.1`). Verifie au prealable que la box n'intercepte
PAS le port 53 : une requete explicite vers 8.8.8.8/1.1.1.1 rendait deja les vraies IP.

uqload devient extractible et concorde parfaitement. Etat final SnK ep1 VOSTFR :
```
sibnet     OP 2:03.0  ED 23:55.0  image
ansembed   OP 2:03.2  ED 23:55.2  image
uqload     OP 2:03.2  ED 23:55.2  image
vidmoly-va OP 2:03.8  ED 24:05.7  image   <- encode different (ED plus tard)
megaplay   OP 2:19.6            audio   <- encode +16.6s en tete, pas d'ED
```
Consensus OP 4/5 (spread 0.77s) et ED 3/4 (spread 0.17s), les deux SERVIS.

### A retenir
Le risque de cette couche n'est pas dans la logique de decision (65 tests hors-ligne
verte des le depart) mais dans le **cablage** et dans les **listes figees** (domaines
CDN, listes de hosts) : c'est ce que seul un run reel expose. Trois des quatre bugs
de cette session sont de cette famille.

## 2026-08-04 (suite 4) — OP/ED : couche de replis (F) + garde-fous faux positifs (P)

Demande : « il nous faut énormément de fallback, par ex si l'OP/ED fourni n'est pas
du tout le même que ce qu'on a ; et des vérifications pour ne pas avoir de faux
positifs ». Fait : tous les F sauf F6 (AniSkip, écarté), tous les P.

### Les deux principes qui structurent la couche
- **Rien n'est jamais déplacé.** Un hit douteux est retenu ou signalé, jamais
  « corrigé » en un timing inventé. Les raisons vivent dans `oped/validate.py` ;
  celles de `validate.BLOCKING` empêchent de servir, les autres sont consultatives.
- **L'accord entre lecteurs n'est PAS une preuve d'exactitude.** Tous les hosts
  passent la MÊME référence dans le MÊME matcher : ils reproduisent la même erreur.
  C'était le trou central. Les deux preuves réellement indépendantes sont l'IMAGE
  (par épisode) et la SAISON (par titre).

### Replis
- **F1 auto-référence ep↔ep** (`oped/self_ref.py`) — le cas « le thème fourni n'est
  pas le nôtre » : l'OP/ED est récupéré comme le segment qui SE RÉPÈTE entre
  épisodes, puis découpé du fingerprint déjà calculé (`slice_fingerprint`) → **zéro
  décodage supplémentaire**, et ça redevient une `ThemeReference` ordinaire que tout
  le pipeline existant consomme. Anti-recap : échantillonnage **stridé** (ep 1,4,7…)
  — un recap ne se répète qu'entre épisodes ADJACENTS, il ne peut donc pas voter.
  Tout hit dérivé est retenu jusqu'à confirmation par la passe saison.
- **F2** fenêtre ED élargie (240→420 s de fin), **F3** repli sur le pool de thèmes
  quand le mapping direct échoue (le champ `episodes` d'AnimeThemes est souvent
  décalé d'un épisode autour d'un OP1→OP2), **F4** durée estimée depuis les pairs
  quand ffprobe échoue (l'OP est servi, l'ED retenu — son ancre dépend de la durée),
  **F5** `min_fill` relâché mais seulement si l'image confirme, **F7** prédiction
  intra-saison des trous.
- **F6 (AniSkip) volontairement non fait** : écarté comme source, et comme
  validateur il aurait ajouté une dépendance réseau pour une couverture faible.

### Vérifications
- **P2 pic rival** : `best_match_ranked` sort le rapport de votes du meilleur offset
  concurrent dans la MÊME passe (coût nul). Une chanson qui se rejoue produit deux
  pics — c'est la cause RACINE du faux positif cyberpunk, qui n'était jusqu'ici que
  mitigé par `inferred`.
- **P4** : `av_delta` mesuré dès que audio et image ancrent tous les deux
  (`video_disagreement` était déclaré depuis le début mais **jamais posé en v2**) ;
  `align_status` distingue enfin « l'image a rejeté » (preuve CONTRE) de « l'image
  n'a rien dit » (aucune info) — les deux finissaient en `source="audio"`.
- **P5 cohérence intra-saison** (`season_pass.py`), le plus fort et le plus délicat.
  **Par clusters, pas par médiane** : la position de l'OP est légitimement bimodale
  (cold-open ou non selon l'épisode), une médiane tomberait entre les deux modes et
  signalerait la moitié de la saison. **ep1 et dernier épisode exemptés** (piège
  signalé par Luc : beaucoup d'animes placent le premier OP très loin dans l'ep1 —
  c'est normal, jamais une anomalie). Une saison trop dispersée ne rend AUCUN verdict
  plutôt qu'un faux.
- **P3, décision assumée** : `low_confidence` est remonté partout mais n'est PAS
  bloquant. SnK ep1 OP (2:02, correct) est un hit audio-seul : le bloquer coûterait
  de la couverture réelle. C'est la passe saison qui arbitre les audio-seuls.

### Ordre d'exploitation (la passe saison est OBLIGATOIRE avant import)
```
python batch_detect.py … --multi-host --out results.jsonl
python season_pass.py --in results.jsonl --out results.checked.jsonl --report
node scripts/import-oped-host-skips.mjs --in=results.checked.jsonl
```
Elle promeut les hits `derived` et retire les outliers. L'importeur jetait déjà tout
`serve:false` : les nouveaux blocages arrivent donc en DB sans le toucher.

### Vérifié / non vérifié
- `python test_guards.py` : **65 assertions vertes, hors-ligne** (ni réseau ni
  ffmpeg) — plausibilité, pic rival, slicing, découverte de segment + anti-recap,
  gate `serve`, passe saison (dont les deux pièges ep1/bimodal), et la cascade v2 de
  bout en bout sur audio synthétique.
- **NON vérifié** : aucun run réseau réel depuis ces changements. Les seuils
  (bandes de longueur, 0.6 de pic rival, 12 s de tolérance de cluster) sont raisonnés,
  pas calibrés sur des mesures — à confronter à un vrai batch avant backfill.

## 2026-08-04 (suite 3) — CORRECTION de l'entrée précédente : Vercel va bien, seul le Worker est muet

**L'entrée « suite 2 » ci-dessous est FAUSSE sur son point principal.** Je l'ai
laissée telle quelle plutôt que de la réécrire, parce que l'erreur de méthode est
plus instructive que le diagnostic.

### Ce que j'avais conclu (à tort)
Que `bug_reports` (écrit par Vercel) et `user_analytics` (écrit par le Worker)
s'étant arrêtés à 26 h d'intervalle, le facteur commun était forcément le couple
`TURSO_ADMIN_*`, périmé des deux côtés. J'ai écrit « c'est étanche ».

### Ce que dit le test
Un POST réel sur `/api/v2/admin/bug-report` en prod : **`{"message":"Report
received","id":39}` — HTTP 200.** La ligne est apparue dans la base lue en local
(donc même base), puis supprimée. Vercel écrit parfaitement dans la base ADMIN.

`bug_reports` s'arrêtait au 10/07 pour la raison la plus bête : **personne n'a
envoyé de rapport depuis**. 38 rapports en six semaines, très irréguliers
(28/06, 29/06, 07/07, 09/07, 10/07) — un trou de 25 jours n'a rien d'anormal à ce
rythme. J'ai pris une coïncidence pour une corrélation, sur un échantillon de deux.

### Ce qui reste vrai
`user_analytics` est bien morte depuis le **11/07 21:14**, et le Worker en est le
**seul** écrivain depuis le 4-5/07. Le problème est donc entièrement côté
Cloudflare — secrets propres, configurés par `wrangler secret put`, indépendants
de ceux de Vercel. Non vérifiable d'ici : wrangler exige un `CLOUDFLARE_API_TOKEN`
en session non interactive. À faire à la main :
`wrangler secret list`, puis `wrangler secret put TURSO_ADMIN_TOKEN` /
`TURSO_ADMIN_URL`, redéployer, et vérifier `GET /w/status`.

Les correctifs d'observabilité du Worker (commit 1dcfb0c) restent entièrement
valables : c'est justement parce que tout y était muet que j'ai dû deviner.

### La leçon
Deux séries temporelles qui s'arrêtent en même temps ne partagent pas forcément
une cause — surtout quand l'une est un flux continu (50-110 lignes/jour) et
l'autre un événement rare (moins d'un par jour). **Il fallait tester le chemin
d'écriture avant de conclure**, ce qui coûtait une requête curl. Le DEVLOG du
01/07 disait déjà « ne pas surinterpréter une capture » ; ici c'était deux dates.

---


## 2026-08-04 (suite 2) — ⚠️ ENTRÉE ERRONÉE (voir la correction en suite 3) — la base ADMIN n'est plus écrite depuis la prod (11/07)

Trouvé en cherchant « ce qui reste à faire » : ce n'est pas de la perf, c'est une
panne de production silencieuse depuis presque quatre semaines.

### Le constat
Deux chemins d'écriture **indépendants** vers la base Turso ADMIN se sont
arrêtés à 26 h d'intervalle :

| table | écrite par | dernière écriture |
|---|---|---|
| `bug_reports` | route Vercel `/api/v2/admin/bug-report` | **2026-07-10 19:03** |
| `user_analytics` | Worker Cloudflare `/w/track` | **2026-07-11 21:14** |

`user_analytics` tournait à 50-110 pages vues/jour (12 443 lignes) puis plus rien.

### Le diagnostic
Le facteur commun n'est ni Vercel ni Cloudflare : c'est le **couple
TURSO_ADMIN_URL / TURSO_ADMIN_TOKEN**, configuré séparément des deux côtés.
Éléments qui verrouillent la conclusion :

- La base **MAIN** (`TURSO_DATABASE_URL`, creds différents) est écrite depuis la
  prod **aujourd'hui** (`player_map.checked_at` = 04/08 06:41). Donc Turso n'est
  pas en panne et la prod tourne.
- Le token ADMIN de `.env.local` **lit la base sans problème** → le token a été
  renouvelé en local lors d'une rotation, mais **ni Vercel ni Cloudflare** n'ont
  reçu le nouveau.
- Aucun changement de code sur le chemin de report à cette date. Le seul commit
  proche (0fc9f23, 07/07, refonte des notices) est écarté : des rapports sont
  arrivés les 9 et 10 juillet APRÈS lui.

### Ce que ça casse, en silence
1. **Les rapports de bug ne sont plus enregistrés.** La route renvoie un 500 à
   l'utilisateur — bruyant pour lui, muet pour nous. Le bouton report est notre
   seul canal de remontée : on est aveugles depuis un mois.
2. **Analytics visiteurs mortes.** C'est aussi la seule qui voit l'IP → la
   modération / le bannissement d'IP travaille à l'aveugle.
3. `banned_ips` est vide et ne peut pas être écrite.

### À faire (côté dashboards, pas côté code)
Repousser le token ADMIN courant dans les deux environnements :
`vercel env` pour `TURSO_ADMIN_URL`/`TURSO_ADMIN_TOKEN`, et
`wrangler secret put TURSO_ADMIN_TOKEN` pour le Worker. Puis vérifier
`GET /w/status` (nouveau) et guetter une ligne fraîche dans `user_analytics`.

### Corrigé côté code : la cécité
Le token, je ne peux pas le voir. Mais la panne était **inobservable**, et c'est
ça le vrai défaut. Dans le Worker (`worker/src/edge-endpoints.js`) :
- config absente renvoyait un `{ok:true}` nu, identique à une écriture réussie
  → `{ok:true, stored:false, reason:"unconfigured"}` + `console.error` ;
- le `.catch(() => {})` avalait TOUT, y compris le 401 d'un token expiré — le
  mode de panne exact qu'on vient de vivre. On n'échoue toujours jamais, mais on
  logge : visible dans `wrangler tail` ;
- nouveau `GET /w/status`, lecture seule, booléens uniquement (jamais les
  secrets), constatable d'un `curl`.

**Leçon** : un chemin fail-open sans log est un chemin qui meurt sans témoin.
Tout `.catch(() => {})` sur une écriture doit au minimum logger.

### Autres tables — état des lieux
Passe de fraîcheur sur les deux bases :
- Saines : `anime` (22 533, 0 j), `season_cache` (31 380, 0 j), `player_map`
  (3 484, 0,3 j), `fribb_map` (20 693, 1,3 j), `anime_fanarts` (123 339, 4,3 j).
- **`oped_skips` = 0 et `oped_host_skips` = 0**, `skip_episodes` = 1 ligne. Tout
  le travail du détecteur d'OP/ED n'a **jamais été importé en base** — l'endpoint
  `/api/v2/skip` (718 invocations/12 h) retombe donc systématiquement sur
  AniSkip. Le TODO de l'importeur JSONL→DB (noté au 01/07) est toujours ouvert.
- `tmdb_stills_cache` : 10 lignes, 18 j. Vestige — TMDB est banni comme provider
  depuis le 03/08, Simkl est la seule source de vignettes. Table à supprimer.

---

## 2026-08-04 (suite) — Passe de propreté : deps mortes, duplication, pages statiques

Suite de la passe de perf. Cette fois la question était « que reste-t-il de sale,
en double ou mal pensé ». Plusieurs trouvailles dépassent la cosmétique.

### ⚠️ cheerio n'était pas déclaré
`pages/api/v2/source/index.js` — le cœur de la résolution vidéo — importe
`cheerio` directement, mais il **n'était pas dans package.json**. Il n'arrivait
que comme dépendance transitive de `@consumet/extensions`, un paquet git que
l'application n'importe nulle part. Supprimer cette dépendance morte (ce qui
paraissait totalement anodin) aurait cassé la fonctionnalité principale du site
sans le moindre avertissement au build. Déclaré explicitement avant toute
suppression. **Leçon : avant de retirer une dépendance inutilisée, vérifier ce
qu'elle traîne derrière elle.**

### 10 dépendances mortes retirées
Aucun import dans tout le dépôt, et aucun paquet installé ne les déclare en peer
(vérifié par script sur node_modules) : `@consumet/extensions` (dépendance git,
clonée à chaque install), `@tensorflow/tfjs-node` (module natif — c'est LUI qui
fait échouer `npm install` en local sans toolchain C++), `nsfwjs`, `media-icons`,
`workbox-webpack-plugin` (déjà une vraie dep de next-pwa), `cron`, `graphql`,
`i18next-browser-languagedetector` et `react-use-draggable-scroll` (ces deux-là
n'apparaissaient que dans des commentaires expliquant qu'on ne les utilise
volontairement PAS), `disqus-react`. `onnxruntime-node` déplacé en devDeps (seul
scripts/classify-fanarts.mjs s'en sert).

`tailwindcss-animate` a bien failli y passer aussi : absent des 60 premières
lignes de tailwind.config.js, il est en fait bien dans `plugins`. **C'est le
build qui l'a rattrapé** — d'où l'intérêt de rebuilder après chaque lot.

### 4 pages passées de serverless à statique
En typant un composant partagé, TypeScript a sorti ce que les fichiers `.js`
cachaient : **`<MobileNav>` n'accepte pas de prop `sessions`** — il lit la
session lui-même via `useSession()`. Or popular, trending et recent appelaient
`getServerSession` dans getServerSideProps *uniquement* pour alimenter cette
prop morte. recently-watched, elle, lisait la session… mais seulement dans des
effets client. Les quatre pages sont maintenant ○ (statiques, CDN) au lieu de ƒ :
plus aucune invocation Vercel par vue.

### Duplication
- **popular.js et trending.js étaient le même fichier** (147 et 145 lignes) à la
  clé de tri, deux clés i18n et une meta près → components/anime/CatalogGrid.
  Un `mt-5` parasite sur le bouton de trending était de la dérive, pas une
  intention.
- **getClientIp existait en 3 exemplaires divergents**, et l'écart comptait :
  deux copies ne gardaient pas contre un `x-forwarded-for` vide et renvoyaient
  `""`. Comme bug-report conditionne son anti-spam par IP à `if (ip)`, une
  chaîne vide **désactivait le contrôle**. → lib/net/clientIp.
- **setEdgeCache** redéfini dans 3 handlers → lib/http/edgeCache. Ces en-têtes
  décident si une requête est facturée en Edge Request : un seul endroit.
- **`convertSecondsToTime` existait en double avec DES SORTIES DIFFÉRENTES**
  (2 unités vs 4 avec les secondes). Substituer l'une par l'autre aurait changé
  le compte à rebours de la home. Les deux vivent maintenant dans getTimes, la
  compacte renommée `formatCountdownCompact`. **Un nom identique pour deux
  comportements, c'est comme ça qu'on « corrige » l'un en cassant l'autre.**
- listEditor importait `inputToFuzzy as toFuzzy` ET redéfinissait sa propre copie
  identique sous le vrai nom — deux appels utilisaient l'une, deux l'autre.
- `getCurrentSeason` de footer.tsx : copie mot pour mot de utils/getTimes.

### Fichiers morts supprimés
components/anime/{charactersCard.js (2023), episode.js}, components/anime/mobile/
(topSection + reused/, tout le dossier), utils/getRedisWithPrefix.ts (2024),
components/disqus.tsx — ce dernier accompagné d'une prop `disqus` que la page
watch calculait, sérialisait dans les props SSR de CHAQUE épisode et
déstructurait sans jamais l'utiliser.

`components/home/content.tsx` coexistait avec un dossier `components/home/content/`,
et content.tsx importait `./content/historyOptions` — un fichier important depuis
un dossier portant son propre nom. Aplati.

### Volontairement PAS touché
- **`components/shared/{AnimeCard,RankingBadge,StatusPill}.tsx`** : importés
  nulle part, mais créés ensemble le 2026-04-28 et jamais câblés depuis. Ça
  ressemble à un design system amorcé — c'est un choix produit, pas du code mort
  évident. (Note : AnimeCard a reçu l'optimisation d'images de la passe
  précédente avant que je réalise qu'il était orphelin.)
- **`pages/api/v2/source/index.js`** (3129 lignes) duplique `fetchWithTimeout` et
  `fetchViaWorker` avec lib/extractors.js. C'est le fichier le plus critique du
  site et le player ne se teste pas en local (cf. no-local-player-testing) :
  refactor à faire avec une vraie session de test sur dev, pas à l'aveugle.
- **components/admin/{dashboard,reports}** partagent 4 fonctions identiques
  (fetchReports, handleResolved, handleTogglePending, openImageInNewTab). Page
  admin, trafic nul, aucun impact perf → pas prioritaire.
- **Page watch (91,9 kB)** : ReportModal / RateModal / WatchPartyPanel montés en
  permanence. ReportModal se splitte proprement (`<Transition appear>` de
  headlessui), mais **RateModal anime son ouverture en CSS depuis l'état monté**
  — le gater sur le montage lui ferait perdre son fondu.

---

## 2026-08-04 — Passe de perf : bundle, images, code splitting, scroll

Point de départ : « le site est très laggy ». Tout a été mesuré au build, pas
supposé — et le build lui-même était cassé, ce qui a été la première trouvaille.

### Le build ne passait plus (et personne ne le voyait)
`tsconfig.json` avait `exclude: ["node_modules"]`, qui n'exclut QUE le
node_modules racine. Avec `include: ["**/*.ts"]`, tsc avalait donc
`worker/node_modules` (125 Mo, typings wrangler + workerd) et les caches de
scraping sauvegardés en `.ts` sous `tools/`. Le build mourait en OOM au-delà de
**12 Go** de heap, en phase « checking validity of types ». Excludes explicites
→ build complet en **71 s**. À retenir : `"node_modules"` seul est un piège dès
qu'un sous-projet a ses propres deps.

### Bundle : shared 247 → 201 kB, _app 138 → 91,6 kB
- **framer-motion vivait dans `_app`** pour un unique fade d'opacité 0→1 — donc
  dans le chunk partagé de TOUTES les pages. Remplacé par un keyframe CSS
  (`.as-fade-in` dans globals.css). Même chose pour les wrappers purement
  décoratifs de about / my-list / profile / settings, et pour search où
  l'animation tournait **par carte de résultat**. framer-motion ne reste que
  sur home et schedule, où il anime réellement quelque chose (carrousel héros).
- **Les deux locales étaient bundlées** dans `_app` : chaque visiteur
  téléchargeait ~48 kB de traductions qu'il ne lirait jamais. Seule la locale
  par défaut (celle du SSR) reste bundlée ; l'autre arrive via `ensureLanguage()`
  dans son propre chunk, dont le fetch part à l'évaluation du module pour
  recouvrir l'hydratation. `I18nProvider` l'attend avant `changeLanguage`, donc
  on ne bascule jamais sur une langue dont les chaînes ne sont pas là.
  `partialBundledLanguages: true` est requis côté i18next.

### Images : la vraie cause du scroll qui saccade
`images.unoptimized: true` (volontaire, pour ne pas payer les transformations
Vercel) veut dire que l'URL passée à `<Image>` est **littéralement** ce que le
navigateur télécharge et décode. Or presque tous les appelants prenaient
`coverImage.extraLarge`, y compris les cartes de 135-180 px. Mesuré :

| variante | segment d'URL AniList | taille | poids |
|---|---|---|---|
| extraLarge | `/cover/large/` | 460×636 | 83,8 kB |
| large | `/cover/medium/` | 230×318 | 28,8 kB |
| medium | `/cover/small/` | 100×138 | 9,7 kB |

Sur une home d'une soixantaine de posters : ~5 Mo et ~18 Mpx à décoder contre
~1,7 Mo et ~4 Mpx. Les trois variantes ne diffèrent que par ce segment, donc
`lib/images/cover.ts` **dérive** la bonne taille de celle qu'on a reçue —
aucune query GraphQL à changer (le batch de la home ne demande QUE extraLarge),
aucun payload en plus, et les URL non-AniList passent intactes. Le helper
remplace au passage l'échelle `extraLarge || large || medium` recopiée dans une
dizaine de composants. Laissé en `full` là où l'image est réellement grande :
héros, poster de fiche, grille de recherche, deck discover.

### Code splitting de la fiche anime : 53,2 → 9,1 kB de JS de page
Les onglets étaient déjà montés à la demande mais **importés statiquement** :
tout le monde téléchargeait Episodes (le plus gros composant de l'app),
ScoresTab, CharactersTab et Artworks pour n'afficher qu'Overview. Pire, la page
embarquait InfoPage (desktop) ET InfoPageMobile alors que la branche est connue
dès le SSR via l'useragent. Chacun est passé en `next/dynamic` (ssr:true — rien
n'est browser-only, un onglet restauré depuis le hash d'un lien partagé doit
rendre côté serveur). L'overlay RelationsGraph n'est monté qu'à la première
ouverture, avec un montage **collant** (pas lié à `open`) pour qu'un graphe
rouvert garde son pan/zoom, exactement comme quand il restait monté.
299 → 212 kB de first load.

### Scroll
- **Navbar** (sur quasi toutes les pages) : elle stockait l'offset brut, donc un
  setState et un re-render de tout le composant à chaque événement de scroll,
  alors que seuls **deux booléens** en sont dérivés. Calculés dans le handler,
  coalescés en rAF, setState uniquement quand un booléen bascule.
- Bug trouvé au passage : `scrollPosition?.y ?? 0 >= 180` se parse en
  `scrollPosition?.y ?? (0 >= 180)`, soit « y est-il non nul » → le bouton
  « haut de page » apparaissait après 1 px de scroll, pas 180.
- **Scroll infini** : le même useEffect copié-collé dans 4 pages, lisant
  `document.body.offsetHeight` dans le handler (reflow synchrone forcé à chaque
  scroll, sur les pages au DOM le plus long). Chaque copie appelait aussi
  `removeEventListener` depuis l'intérieur du handler, en doublon du cleanup —
  et ce mécanisme cessait silencieusement de marcher dès que l'effet se
  ré-exécutait. Factorisé dans `lib/hooks/useInfiniteScroll`.

### Résultat (first load JS)
| route | avant | après |
|---|---|---|
| shared / `_app` | 247 / 138 kB | **201 / 91,6 kB** |
| `/en/anime/[...id]` | 299 kB | **212 kB** |
| `/en/anime/watch/[...info]` | 341 kB | **296 kB** |
| `/en/settings` | 256 kB | **209 kB** |
| `/en/anime/popular` | 230 kB | **184 kB** |

### Pistes restantes
- Page watch encore à 91,9 kB de JS de page : ReportModal / RateModal /
  WatchPartyPanel sont montés en permanence et se contentent de se cacher —
  mêmes candidats que RelationsGraph. Attention : RateModal anime son ouverture
  en CSS depuis l'état monté, donc le gater sur le montage lui ferait perdre son
  fondu (contrairement à ReportModal qui utilise `<Transition appear>` de
  headlessui et supporte le montage tardif).
- `tailwindcss-animate` est en devDependency mais **absent des plugins** de
  tailwind.config.js → dépendance morte.
- `components/home/content.tsx` coexiste avec un dossier `components/home/content/`
  (un seul fichier dedans, historyOptions.js). Résolution ambiguë à l'œil nu,
  piège pour la prochaine personne.
- Vérifier en vrai sur dev.aniscroll.com : bascule FR (le chunk de locale arrive
  maintenant en différé) et onglets de la fiche anime.

---

Journal des modifs de dev, pour garder le contexte entre les sessions (survit aux `/clear`).
Ordre anti-chronologique (le plus récent en haut). Une entrée = une session/sujet, avec **décisions** et **leçons/pièges**, pas juste les commits (git les a déjà).

> Convention : dates absolues. Branche de travail = `dev` (push auto, voir mémoire). Le Worker Cloudflare se déploie **à la main** (`cd worker && npx wrangler deploy`) — un `git push` ne le déploie pas.

---

## 2026-08-03 (suite 3) — Audit usage Vercel : le plus gros poste de coût était notre propre cron

Parti de la doc « manage and optimize usage ». La doc elle-même n'apporte presque rien (c'est un
guide de dashboard), mais **mesurer** a renversé trois conclusions successives.

### Méthode (à réutiliser)
- `npx vercel logs https://aniscroll.com --json` sur ~40 min → tableau path × source × cache.
  C'est le seul instrument qui donne la répartition réelle ; l'Observability donne l'Active CPU
  par route, la page **Usage** donne les barres d'allotment. Les trois sont nécessaires.
- ⚠️ **Ne jamais extrapoler une fenêtre de 12 h Production vers le mois** : j'ai projeté 66 K
  invocations, la vraie barre en disait **256 K** (×4). La page Usage compte *tous* les
  environnements, previews `dev` comprises, et une fenêtre courte tombe dans un creux.

### Le vrai coupable : `warm-cache.yml`
Le step « Run page warmer » (`scripts/warm-cache.mjs`) parcourait **chaque `/en/anime/{id}`** tous
les jours depuis un runner GitHub (datacenter US). Conséquences mesurées :
- **56,4 % des Edge Requests sur le PoP Cleveland** contre 15,6 % Paris → il réchauffait un edge
  que personne ne consulte. Un cache CDN est **par PoP** : warmer depuis les US ne sert pas les FR.
- `/en/anime/[...id]` = 1ʳᵉ route en Active CPU (54 s/12 h) **et 1,2 % de hit CDN** — chaque id
  marché est une clé de cache distincte, rendue à froid, jetée.
- ~170 KB de HTML SSR par page droit dans le **Fast Origin Transfer** (quota Hobby = 10 GB, on
  était à 40 %).
- **Et il n'atteignait pas son but** : un `fetch()` Node ne parse pas le HTML et ne charge aucune
  sous-ressource — il ne pouvait donc pas faire ingérer un seul fanart au Worker. Le vrai
  réchauffage d'images, c'est `warm-images.mjs`, qui tape `fanart-proxy` en direct.
→ Step passé en `if: github.event_name == 'workflow_dispatch'`. Le schedule ne fait plus que les images.

### Leçons
- **Un Edge Request est facturé sur un HIT comme sur un MISS.** Donc `s-maxage` réduit les
  invocations mais **pas** la barre Edge Requests (la plus haute : 420 K/1 M). Le seul levier sur
  celle-ci, c'est de **ne pas émettre la requête** : `max-age` navigateur, et SW en `CacheFirst`.
- **Le `s-maxage` ne sert à rien sur une route à longue traîne à faible trafic.** `/en/anime/{id}`
  a `s-maxage=21600` et 1,2 % de hit : 15 requêtes = 15 ids distincts, zéro répétition. À
  l'inverse `/en/manga/[...id]`, qui n'a **aucun `getServerSideProps`**, est à 94,4 %. C'est le
  mode de rendu qui décide, pas le TTL.
- **Fluid ne facture pas l'attente I/O** : `/api/v2/source` est la route la plus invoquée (341)
  mais seulement 29 s d'Active CPU — scraper des hosts morts ne coûte quasi rien. J'avais dit le
  contraire avant de mesurer.
- Le SW interceptait **tout** `/api/` en `NetworkFirst` avec `maxEntries: 16` → chaque GET repartait
  au réseau et le peu de cache était évincé avant réutilisation.

### Fait
- `warm-cache.yml` : page-walk en dispatch-only.
- `pages/api/og.tsx` : **4,5 s d'Active CPU par appel** (23 % du budget mensuel pour 8 appels) —
  rendu 1800×945 ramené à 1200×630 via une constante `SCALE` (revert = une ligne). Le blur du
  bandeau est l'opération dominante de resvg. Meta `og:image:width/height` synchronisées.
- SW : nouvelle règle `CacheFirst` (`apis-static`, 256 entrées) pour skip/themes/episode-scores/
  changelog-popup/changelog/banner-tone/fanarts ; `apis` passe de 16 → 64 entrées.
- `max-age` navigateur 60 s → 300 s sur catalog / discover / etc-recent / episode (les 2 sorties).
- `changelog-popup` : 300 s → 3600 s (il était à 7,5 % de hit — 5 min est plus court que
  l'intervalle entre deux visiteurs).
- `Tabs.tsx` : **suppression du prefetch idle de `/api/v2/episode-scores`** — il partait à chaque
  chargement de page pour un onglet que peu ouvrent. Les onglets ne montent que sur clic.
- `lib/db/fanarts.ts` : `slimFanartsForSsr()` retire `label`/`nsfwScore` (décidés par le WHERE SQL,
  lus par aucun composant) du payload SSR — ~9 KB sur les 34 KB de la prop `fanarts`.

### Restant / piège
- **`/en/anime/[...id]` en ISR : BLOQUÉ**, pas par la donnée mais par `initialUA`. La page choisit
  `InfoPageMobile` vs `InfoPage` à partir du User-Agent lu au SSR ; un rendu statique ne le connaît
  pas → tout visiteur mobile recevrait le HTML desktop puis un swap complet de composant au mount.
  Il faut d'abord passer ce choix en CSS (rendre les deux, masquer par media-query) — ce qui gonfle
  le HTML et va contre l'allègement. Décision produit, pas technique.
- `__NEXT_DATA__` = **40 % du HTML** (120 KB sur 300 KB pour One Piece) : `info.relations` 37,7 KB,
  `tags` 15,6 KB, `characters` 11,8 KB, `fanarts` 34 KB. La suite = sortir `characters` et
  `fanarts` du payload SSR et les charger au clic sur l'onglet.
- **`npx tsc --noEmit` OOM même à 8 GB** sur ce repo (préexistant) → validation par parsing
  TypeScript fichier par fichier. Le vrai gate, c'est `build-test.yml`, qui tourne **sur PR vers
  main** — donc une release passe par une PR, pas par un merge direct.

---

## 2026-08-03 (suite 2) — « Pourquoi on a pas les bonnes vignettes ? » — Fribb ne connaît qu'un tiers des ids Simkl

Signalement user : `/fr/anime/208044`, les 6 épisodes affichent **la même image**. `GET /api/v2/episode/208044` → `img: null` partout, donc le client retombe sur le pool fanart.

**Ce n'est pas notre code, c'est la couverture de Fribb.** Mesuré sur le fichier live :
```
anime-list-mini.json : 14 480 / 42 868 entrées ont un simkl_id  (34 %)
fribb_map (Turso)    : 13 018 / 20 693
AniList 208044       : simkl_id = null   (mais mal_id 63508 présent)
```
Simkl a pourtant l'entrée complète (id 3025908, 6 stills). **On ne lui demandait jamais**, parce que Fribb était le seul chemin qu'on connaissait vers son id. Et le trou frappe exactement les titres qui en ont le plus besoin : une série en cours de diffusion est la moins susceptible d'avoir été indexée par le mapping.

**Fix :** Fribb reste le chemin rapide (une ligne locale, zéro réseau), `resolveSimklId` est le repli — `/search/id` de Simkl, par id AniList puis par id MAL. Une ligne Fribb absente n'est plus bloquante (`no-fribb` n'est plus un cul-de-sac). Vérifié en prod, cache purgé, **dès le premier appel à froid : 6/6 vraies URLs `simkl.in`**.

**Note sur TMDB :** Fribb avait `themoviedb_id.tv: 314554` + `season.tmdb: 1` pour ce titre — mais TMDB ne l'aurait pas sauvé non plus, son ancien chemin exigeait une **égalité exacte** du nombre d'épisodes, ce qu'une série en diffusion ne peut pas satisfaire. La suppression de TMDB ne coûte rien ici.

### Deux pièges de diagnostic à retenir

1. **`?refresh=1` ne purge que Redis, pas le cache de stills Turso.** Le premier test après le fix renvoyait toujours `null` : c'était la ligne `{"reason":"no-simkl-id"}` de `tmdb_stills_cache` (TTL 24 h) qui répondait, avant même que le code ne tourne. Il faut supprimer la ligne pour tester un changement de résolution. 6 lignes bloquées ont été purgées après le déploiement.
2. **Vercel ne remonte pas les `console.info`** dans `vercel logs --json` — seulement warn/error. Un titre en vignettes génériques ne laissait donc **aucune trace**, ce qui est précisément le symptôme dont on nous parle. Le log de refus est passé en `warn`, et la résolution directe logge son issue.

**Leçon générale : « aucune ligne écrite en cache » ne prouve pas quelle branche a tourné** — si le client Turso n'est pas configuré dans cet environnement, rien ne s'écrit quoi qu'il arrive. J'ai perdu plusieurs allers-retours à déduire d'une absence. Instrumenter au bon niveau de log, puis lire, aurait été plus court.

### Changelog v0.0.6

`changelog/full.{en,fr}.md` + `popup.{en,fr}.md`. Format respecté (popup = première ligne `## vX.Y.Z`, puis 4 lignes `emoji + **titre** — phrase` ; seul `**gras**` est rendu, la signature est un hash du fichier entier donc toute édition re-déclenche le popup). Contenu : éditeur de raccourcis, stats vidéo, bouton épisode suivant, plein écran conservé, vraies vignettes, page Sources, uqload, et le travail de perf.

---

## 2026-08-03 (suite) — Release `dev` → `main`, monitor vivant, et TMDB dégagé

### La release

`dev` → `main` mergé (PR #1, 136 commits). Merge testé avant : **zéro conflit**, `next build` propre sur l'arbre mergé. Le conflit sur `episode/[id].tsx` que le DEVLOG du 29/07 annonçait n'a pas eu lieu — git a auto-mergé et les deux fixes perf ont survécu (vérifié : `edgeSmaxage`, `filterData` sans clone).

**`perf-prod-aug` supprimée.** Elle réécrivait à la main sur `main` ce que `dev` avait nativement → la merger d'abord créait 2 conflits (`next.config.js`, page watch) que `dev` seul n'avait pas. Les deux seules choses qui n'étaient que sur elle (redirect `/`, durcissement du monitor) ont été portées sur `dev` d'abord. **Leçon : quand une branche de backport et la branche principale se recouvrent, porter le delta sur la principale et jeter le backport — ne jamais merger les deux.**

**Vérifié en prod après déploiement** (curl, pas déduit) :
```
page watch          MISS → HIT      (avant : MISS, MISS)   + Set-Cookie disparu
GET /api/v2/source  MISS → HIT → HIT
absent (~½ sondes)  MISS → HIT
/                   307 sans en-tête x-vercel-cache → servi par le routage, pas de fonction
```
Et sur 133 s de trafic réel : `/api/v2/source` en **GET, 5 HIT / 2 MISS**. Le matin même : 54 POST, 54 MISS, zéro HIT.

### `build-test.yml` n'avait jamais réussi une seule fois

Sa toute première exécution était cette PR #1 — et elle a échoué **avant de compiler quoi que ce soit** : `npm run build` commence par `prisma migrate deploy`, qui veut `DATABASE_URL`/`DIRECT_URL` et un Postgres joignable. La CI n'a ni l'un ni l'autre. Le gate ne disait rien sur le code depuis sa création. Corrigé : `prisma generate && next build` avec des URLs bidons (parsées pour valider le schéma, jamais connectées), Node 18 → 22, actions v2 → v4, `npm install --ignore-scripts`. **Leçon : un check qui n'a jamais été vert n'est pas un check.** Il passe maintenant en 1 min 52.

### Le monitor tourne

Secrets Upstash posés par le user → run vert en 22 s, premier recensement commité. Ce qu'il montre tout de suite : **`anime:v5` = 3 756 clés, 67 % du keyspace**. Le gros du cache Redis, c'est la page info, pas `src:` (1 clé — TTL 5 min). `episode:v3` (1 654) est le résidu de l'ancienne prod, il expirera seul ; `episode:v5` démarrait à 15.

Restent optionnels : `UPSTASH_EMAIL`+`UPSTASH_API_KEY` (c'est **eux** qui projettent le plafond de 500 K, donc qui voient venir le mur) et `VERCEL_TOKEN`.

### TMDB supprimé (décision user)

« On arrête avec TMDB, plus jamais, on utilise Simkl. » Retiré : client, résolveur de saison, adaptateur de stills, crédit sur /en/sources, disclaimer contractuel, `TMDB_API_KEY`.

Le point qui justifie la décision : **Simkl n'a aucune saison à inférer** (son id, via `simkl_id` de Fribb, indexe la MÊME entrée qu'AniList). Tout le poids du chemin TMDB venait de là — mapper une franchise sur une saison TMDB, valider contre un compte d'épisodes exact, et refuser dès qu'il ne pouvait pas prouver le match. **Mesuré après suppression, avec `?refresh=1` pour forcer le recalcul** : couverture inchangée. Chainsaw Man 12/12 par Simkl (AniList ne liste rien), One Piece 1102 Simkl + 69 Crunchyroll sur 1172.

**Gardés exprès :**
- `tmdb_stills_cache` **garde son nom** : la table contient des lignes Simkl vivantes en prod ; la renommer les orphelinerait et re-téléchargerait le catalogue pour rien. `StillsSource` garde sa variante `"tmdb"` pour que les vieilles lignes restent lisibles.
- **`tmdb_id` / `season.tmdb` de Fribb ne sont PAS TMDB le fournisseur** — ce sont des identifiants dans un fichier de mapping statique dont `resolveSeason.ts` se sert pour arbitrer l'ordre des franchises. Rien à voir avec l'API.

**Piège corrigé au passage :** une note mémoire affirmait « l'onglet Scores utilise TMDB, nécessite `TMDB_API_KEY` ». **Faux** — il est sur Jikan depuis toujours. J'avais recommandé au user de poser `TMDB_API_KEY` en me basant dessus. **Leçon : une note périmée qui contredit le code produit une recommandation fausse ; vérifier avant de conseiller une variable d'env.**

### Piège d'outillage (auto-infligé)

J'avais créé une jonction Windows `node_modules` **à l'intérieur** d'un worktree de test. `git worktree remove --force` a suivi la jonction et vidé le `node_modules` du dépôt principal. Réinstallé (`npm install --ignore-scripts`). **Leçon : ne jamais mettre de jonction/symlink vers un dossier partagé dans un worktree qu'on va supprimer en `--force`.**

Effet de bord non résolu : depuis, `next build` **local** meurt en OOM dans la phase de type-check (le worker de Next plafonne à 4 Go et n'hérite pas de `NODE_OPTIONS`). **Vérifié que ce n'est PAS lié à la suppression de TMDB** — il OOM aussi avec les changements remisés. La validation est passée par le build Vercel (préview Ready en 1 min), qui est de toute façon l'environnement de référence. À creuser si ça gêne.

---

## 2026-08-03 — Le fix du 30/07 n'était jamais parti en prod (et le monitor ne pouvait pas le dire)

Parti de deux captures Vercel (Functions 12 h + Fluid Active CPU **6h41 / 4h**) avec la consigne « regarde le usage monitor ». Le monitor n'a rien à dire : `snapshots/` est vide depuis le 30/07. **Ma première lecture des captures était fausse** et c'est la leçon centrale de la session.

### Ce que j'ai cru, puis mesuré

Lecture naïve du tableau : `/api/v2/source` 1,5 K → 155 invocations, page watch 1,3 K → 31. « Le fix du 30/07 a marché, spectaculairement. » Faux. `npx vercel logs aniscroll.com --json` (le CLI est authentifié, ça marche, **c'est l'outil qui manquait**) :

```
requestMethod:"POST"  requestPath:"/api/v2/source"  cache:"MISS"  branch:"main"
```

**La prod tourne `main`, qui n'a jamais reçu le commit `8fc3d62`.** `dev` est 135 commits devant ; le seul truc mergé le 29/07 était la branche `perf-cpu-fix`. Toutes les mesures triomphales du 30/07 (« 18 HIT, 0 invocation ») avaient été faites **sur le preview**. La baisse observée sur les captures, c'est le **reset mensuel Upstash du 1er août** (cache de nouveau vivant → moins de recompute), pas un fix. Le mur de mi-août revenait à l'identique.

**Leçon : un fix validé sur preview n'est pas un fix. Vérifier `git branch --contains <sha>` avant de conclure quoi que ce soit d'un dashboard de prod.** Le DEVLOG du 29/07 se faisait déjà exactement ce reproche (« toujours vérifier `git log origin/main..origin/dev` **avant** de bâtir une timeline ») — et j'ai remis le pied dedans quatre jours plus tard.

### Une 2ᵉ mise en cache décorative, du même acabit que le POST

Mesuré au curl sur la prod, deux fois de suite :

```
GET /en/anime/watch/16498/1
  Set-Cookie: __Host-next-auth.csrf-token=…
  Cdn-Cache-Control: public, s-maxage=1800…
  X-Vercel-Cache: MISS        ← les deux fois
```

`getServerSession()` **pose des cookies** en sortant. Une réponse avec `Set-Cookie` n'est stockée par aucun cache partagé → le `s-maxage=1800` de la branche *anonyme* ne servait à rien non plus. Le DEVLOG du 30/07 attribuait la non-cachabilité aux seuls connectés (`private, no-store`) ; en réalité **personne** n'était caché. **Leçon : lire la session côté serveur rend la réponse non-cachable même quand on ne met rien de personnel dedans.**

### Ce qui est parti sur `perf-prod-aug` (branche partie de `main`, 3 commits)

Même méthode que `perf-cpu-fix` : cherry-pick de ce qui s'applique proprement (4/5 fichiers de `8fc3d62`, dont la route `/source`), **réapplication à la main de la page watch** pour ne pas embarquer le code de feature de `dev` (`setPlayerFullscreen`, `DECOY_RETRIES`).

- **`/api/v2/source` en GET** + branche « absente » edge-cachée. POST intact pour les warmers.
- **SSR watch sans session** → plus de `Set-Cookie`. Au passage : `createUser`+`createList`+`getEpisode` supprimés (3 allers-retours Prisma pour une prop `userData` jamais lue).
- **`/` : redirect dans `next.config.js`** au lieu d'un `getServerSideProps` qui ne retournait que `{ redirect }` — **133 invocations/12 h** pour un en-tête `Location` que la couche de routage sert gratuitement.
- **Popup changelog** (`0413ed5`, aussi coincé sur dev) : `?t=${Date.now()}` + `no-store` deux fois par page pour un markdown qui change au déploiement.
- **`mediaMeta` supprimé du contrat client** : la route n'en lisait que `idMal` → `?malId=`. Bonus, ça ferme le piège que la route documentait déjà (données client atteignant les caches serveur, cf. « SnK S1 joue la S2 »).

**Vérifié sur le preview** (curl, pas déduit) : watch MISS→**HIT**, `Set-Cookie` disparu ; GET `/source` MISS→HIT→HIT ; **branche « absente » HIT** (c'est ~la moitié des sondes) ; POST toujours 200 ; `/` → 307 sans passer par une fonction. Type-check + `next build` propres.

### Le monitor : pourquoi il n'a jamais tourné

Pas (que) les secrets, comme dit le 30/07. **`tools/usage-monitor/` et son workflow n'existaient que sur `dev`, et GitHub n'enregistre les `schedule:` que depuis la branche par défaut.** Le cron de 06:20 n'a jamais existé côté GitHub ; le workflow n'était même pas dispatchable à la main. Déplacé sur `main`, avec la raison écrite en tête de fichier.

Second défaut : le collecteur dégradait gracieusement *chaque* source, donc une exécution **sans aucune** credential sortait en **exit 0** après avoir commité un snapshot vide. Il `exit 1` désormais si aucun collecteur Upstash n'a produit de données. **Leçon : un monitor qui ne rapporte rien en restant vert est pire que pas de monitor.**

### Restant / décidé

- **Secrets à poser** (`UPSTASH_REDIS_REST_URL`/`_TOKEN` depuis `aniscroll-cache`) : `vercel env pull` ne les donne pas, ils sortent en `[SENSITIVE]`. Console Upstash obligatoire.
- **Page info en ISR : volontairement PAS fait.** Elle pèse 51 % du CPU sur la capture (255 inv × 224 ms), mais sur 15 min de logs réels elle fait 6 lignes contre **54 pour `/api/v2/source`**, toutes MISS. Refactorer 973 lignes à l'aveugle avant que le fix ci-dessus n'ait changé le profil, c'est exactement l'erreur nommée le 30/07 (« le fix du 29 a optimisé le petit »). À rouvrir avec les chiffres d'après-merge.
- **`/api/og` compte-t-il dans Fluid ?** Le 29/07 concluait « runtime edge, pas Fluid, ne pas optimiser ». La capture le montre dans le tableau Fluid : **23 s de CPU pour 4 invocations** (5,75 s/appel), 21 % du total. À revérifier — si c'est confirmé, c'est le 2ᵉ levier. Accessoirement son `Cache-Control` sort dupliqué (`@vercel/og` pose le sien, le nôtre est concaténé derrière, `s-maxage` perdu) — sans effet mesurable, il HIT quand même.
- **Les 1,3 % d'erreurs sur `/source` sont normales** : c'est `sendRetryable` → 503 sur un upstream capricieux, compté 5XX par Vercel. Rien à corriger.
- **Le 6h41/4h est un cumul de cycle** (axe 6 juil → 3 août, reset vers le 5-6 août), dominé par le pic du 18/07 (1h23 à lui seul) et le palier pré-reset. La barre du jour : 4 min 6 s.

---

## 2026-07-30 (suite 4) — Chasse aux invocations : le POST qui rendait tout le cache décoratif

Parti du tableau Observability de Vercel (top Active CPU : `/api/v2/source` 1,5 K invocations / 1 min CPU, page watch 1,3 K / 51 s, page info 107 / 28 s). Le monitor maison (`tools/usage-monitor`) **n'a jamais tourné** : `snapshots/` est vide, pas de `LATEST.md` — il manque les secrets Upstash/Vercel dans les Actions. À réactiver, c'est lui qui doit voir venir le mur, pas une capture d'écran.

**La trouvaille : `/api/v2/source` est en POST — donc aucun CDN ne cache ses réponses.** La route posait pourtant scrupuleusement `s-maxage=300, stale-while-revalidate=600` depuis des mois : des en-têtes qui n'ont jamais rien fait. Chaque visiteur ré-invoquait la fonction pour une résolution que l'edge avait déjà, et la page watch en tire **une par serveur sondé** à chaque chargement (~18). **Leçon : un en-tête de cache sur un POST est du commentaire.** Le passage en GET n'a rien coûté côté contrat : le body ne portait qu'un seul champ utile, `mediaMeta` (objet média complet avec `synonyms` + `relations`) dont la route ne lit que `idMal` → `?malId=`. POST conservé tel quel pour les warmers/scripts d'audit.

Deuxième moitié du même bug : **la branche "source absente" n'avait que `max-age` (navigateur)**, alors que ~la moitié des sondes ratent par design → chacune ré-invoquait. Maintenant `CDN-Cache-Control` aussi, 5 min, sous le sentinel négatif Redis de 10 min (l'edge ne prétend jamais "absent" plus longtemps que le serveur). Sur GET l'absence est un **`200 {absent:true}`** et non un 204/404 : garanti cachable (le comportement de Vercel sur le cache d'un 204 n'est pas une chose sur laquelle parier pour l'endpoint le plus chaud du site) et muet en console. Côté client, les trois dialectes de statut éparpillés sur 4 appelants sont pliés dans un helper unique (`lib/watch/sourceRequest.ts`) à trois issues : `ok` / `absent` / `retry`.

**Page watch : le SSR ne dépend plus de qui demande.** Il lisait la session pour injecter `sessions` + le `mediaListEntry` de l'utilisateur dans les props → `private, no-store` → les connectés (ceux qui enchaînent le plus d'épisodes) ré-invoquaient la fonction à **chaque vue et chaque changement d'épisode** (la navigation SPA refetch les props). Les deux passent côté client (`useSession()`, et l'effet de backfill `/api/v2/media/[id]` qui existait déjà) — même arbitrage que la page info. Coût assumé : un `/api/auth/session` par chargement à froid, partagé ensuite sur toute la navigation SPA (mesuré : 1, exactement comme la page info le faisait déjà).

Au passage, trois allers-retours Prisma par vue connectée (`createUser` + `createList` + `getEpisode`) **construisaient une prop `userData` que le composant déstructurait sans jamais la lire**. Et les lignes écrites étaient des coquilles vides : `updateUserEpisode` n'a plus aucun appelant, et `recently-watched` filtre les lignes sans image/titre et retombe sur localStorage — qui est ce qui contient réellement l'historique. Supprimés. **Leçon : vérifier ce que la prop devient avant d'optimiser ce qui la produit.** Idem `getRemovedMedia()` : un `findMany` non caché à chaque SSR watch pour une table DMCA éditée à la main → cache mémoire 10 min (un échec de lecture n'est PAS caché, sinon un hoquet Prisma dé-masquerait un retrait).

**Mesuré sur le preview** (Chrome réel) : deux visiteurs neufs successifs sur la même page watch → **18 appels `/api/v2/source`, 18 `x-vercel-cache: HIT`, 0 invocation** (avant : 18 POST = 18 invocations, par visiteur). HTML de la page watch : HIT. Absence : MISS puis HIT. POST : MISS (jamais caché — la preuve du diagnostic). Lecture inchangée : `readyState 4`, durée 1435 s, zéro erreur console.

Petit à côté du même acabit : le popup changelog s'appelait avec `?t=${Date.now()}` + `cache:"no-store"`, **deux fois par chargement de page**, pour un fichier markdown qui ne change qu'au déploiement (246 invocations/jour qu'aucun cache ne pouvait servir).

---

## 2026-07-30 (suite 3) — Navbar illisible sur une bannière claire → on mesure les pixels

La navbar flotte en transparent sur la bannière de la page info, donc **tout** son chrome est blanc (liens, icônes, pilule de recherche). Sur une bannière blanche/pastel (Nippon Sangoku) elle disparaît complètement. Aucune métadonnée AniList ne dit "cette image est claire" → la seule source de vérité, ce sont les pixels.

**Design.** `lib/color/navContrast.ts` : store hors React (les deux côtés sont des composants sans lien — la navbar est rendue par la page, la bannière par le hero ; un contexte aurait voulu dire brancher un provider sur deux layouts pour un booléen). Le hero déclare l'artwork (`useNavBackdrop(src)`), la navbar lit le verdict (`useNavOnLight()`) et bascule en chrome quasi-noir. Seuil : **luminance relative WCAG moyenne > 0,42**. Le croisement blanc/noir est à L≈0,28, mais basculer pile au croisement repeindrait la navbar sur toutes les bannières gris moyen pour un gain marginal ; mesuré sur 20 bannières réelles, les claires sont à 0,51-0,99 et les "ciel bleu" (AoT, Kimi no Na wa) restent à 0,28-0,37 et gardent le look du site.

**Le piège (2 h perdues) : lire les pixels dans le navigateur est IMPOSSIBLE sur le CDN AniList.** Première version : `crossOrigin="anonymous"` sur le `<img>` + canvas + `getImageData`, en vérifiant d'abord au curl que `s4.anilist.co` renvoie bien `Access-Control-Allow-Origin` (oui, sur MISS **et** sur HIT). En vrai Chrome sur le preview : **toutes** les bannières en `ERR_FAILED` / "blocked by CORS policy". Raison : **Cloudflare ignore `Vary: origin` pour la mise en cache**. Le fait de recevoir l'en-tête dépend donc de la copie que ce PoP détient — curl (avec Origin, sa propre entrée de cache) le voit, le navigateur non, parce que les chargements *sans* CORS de la même image ailleurs sur le site ont rempli le cache en premier. **Leçon : "curl voit l'en-tête CORS" ne prouve rien ; derrière un CDN, la validité d'un ACAO dépend du cache, pas du serveur.** (Le fallback `onError` → retrait de l'attribut → rechargement en clair a bien joué son rôle : la bannière s'affichait, seule la mesure était perdue.)

**Refonte : mesure côté serveur.** `GET /api/v2/banner-tone?u=…` (sharp) renvoie `{ l }`, la luminance moyenne du haut de l'image. Réponse **immuable** (une nouvelle illustration = un nouveau nom de fichier) → `s-maxage` d'un an : **une invocation par bannière existante**, pas une par page vue, et le client télécharge ~20 octets au lieu d'une 2ᵉ copie de la bannière. Le seuil reste **côté client** exprès : la réponse est cachée un an, le régler ne doit pas demander de purge. Allowlist d'hôte (`s4.anilist.co`) parce que la route fetch l'URL qu'on lui donne (SSRF).
Alternatives écartées : `/_next/image` (l'optimiseur est désactivé, `unoptimized: true` → 404), le proxy fanart CF (quota 5k transformations/mois, réservé à fanart.tv).

**Le serveur ne connaît pas le viewport** → il échantillonne le **haut 25 %** du fichier. `object-fit: cover` place la bande de la navbar dans cette zone à toutes nos largeurs (lignes 0-80 à 1280 px, 14-86 à 1900, 47-100 à 2560). Vérifié contre le crop exact par viewport sur 21 bannières : même verdict sur 19, les 2 autres étant des crops mobiles limites.

**CSS (`.nav-on-light`) : surtout PAS de `nav.nav-on-light { color }` global.** La navbar *contient* le menu avatar, la liste de notifications et la modale changelog — des panneaux sombres dont le texte hérite sa couleur : une règle en cascade les aurait passés en noir sur noir. Seuls les éléments marqués `nav-chrome` (Discord/cloche/report/changelog) et `nav-chrome-dim` (le tag "Beta") sont repeints, marqueur posé **sur le bouton**, jamais sur un wrapper ; les liens de nav et la pilule de recherche prennent des classes conditionnelles dans NavBar. La bascule ne s'applique que tant que la navbar est transparente : passé le seuil de scroll elle peint son propre fond sombre et le blanc redevient correct.

**Validé en vrai Chrome sur le preview** (Playwright + Chrome système) : desktop 1900 px → classe posée, liens `rgba(0,0,0,.8)`, pilule `rgba(0,0,0,.06)`, icônes `rgba(11,13,18,.72)` ; scroll → retour au chrome blanc ; page à bannière sombre (Jujutsu Kaisen) inchangée ; mobile (Pixel 7) idem ; menu avatar toujours blanc sur `#212127` ; **1 seule requête** pour la bannière.

---

## 2026-07-30 (suite 2) — Bouton "épisode suivant" dans la barre + on RESTE en plein écran au changement d'épisode

Deux demandes liées. Le bouton est trivial ; garder le plein écran l'était moins.

**Bouton next (icône `skip_next` classique) dans la barre de contrôle.** Même technique que Download/Subs/Cast : un **host DOM stable** (`data-slot="moopa-nav-controls-host"`, `display:contents`) dans lequel React portale le bouton, que le MutationObserver **repositionne** juste après le bouton play. Piège évité : le host des boutons custom se place dans le **dernier** `.vds-controls-group` — ce qui marche en layout large mais PAS en `data-size="sm"`, où le dernier groupe est la **barre de progression** (l'ordre mobile est : [cc/menus/mute] · [play centré] · [temps+fullscreen] · [slider]). Le nouveau host cible donc le groupe **par contenu** (celui qui contient `.vds-play-button`), valable sur les deux layouts. En mobile ce groupe est `pointer-events:none` (seul le play réactive) et le play y est rond/40px/`translateY(25%)` → CSS dédiée pour que le bouton next soit cliquable et assorti.

**Rester en plein écran (le vrai sujet).** Le player est **keyé** par `{server}-{aniId}-{episode}-{sub|dub}` → changer d'épisode **démonte** `.vds-player`, et l'API Fullscreen lâche le plein écran dès que son élément quitte le DOM. L'ancien code assumait la sortie (SkipOverlay faisait un `exitFullscreen()` explicite avant `router.push`, sinon la page suivante chargeait *sous* une frame figée et le bouton semblait mort).

Fix = **handoff en 2 temps** autour de la navigation (`lib/player/episodeTransition.ts`) :
1. `beginEpisodeTransition()` (dans le geste, **avant** `router.push`, et **await** pour ne pas courir contre le démontage) donne le plein écran à un **host de niveau `_app`** (`components/shared/episodeTransitionOverlay.tsx`) qui survit à toute navigation. Il peint du noir + **la barre rose du site** (le `<NextNProgress>` de la page est invisible quand un autre élément possède l'écran) → l'utilisateur voit que ça charge.
2. `claimEpisodeTransition(el)` : le **nouveau** player récupère le plein écran dès que son élément existe (le plus tôt possible = geste encore récent → activation transitoire probablement encore valide).

**Pourquoi rendre le plein écran à `.vds-player` et pas garder un ancêtre plein écran** (ce qui aurait évité le 2ᵉ `requestFullscreen`) : Vidstack dérive son état de `isFullscreen(player.el)` = `fullscreenElement === el || el.matches(':fullscreen')`, et `:fullscreen` ne matche **QUE** l'élément demandé (pas ses descendants — la remontée du spec est inter-**documents**/iframes, pas inter-éléments). Un ancêtre plein écran laisserait donc Vidstack en état "fenêtré" → mauvaise icône, `[data-fullscreen]` absent (ratio 16:9 gardé → bandes noires) et surtout **menus portalisés vers `<body>`** donc invisibles en plein écran mobile. Vérifié aussi dans le dist Vidstack : son `FullscreenController.exit()` (appelé au dispose du player) **court-circuite** si son élément n'est pas l'élément plein écran → le démontage de l'ancien player ne casse pas notre handoff. 

### Le vrai verdict (2ᵉ test user) : **le handoff par re-demande est IMPOSSIBLE** → refonte, le plein écran passe sur `<html>`

Trace `?fsdebug` du user, sans ambiguïté :
```
begin: host owns the screen          ← étape 1 OK
claim → Failed to execute 'requestFullscreen' on 'Element':
        API can only be initiated by a user gesture.
```
Donc **Chrome exige une activation utilisateur pour re-demander le plein écran**, même document déjà en plein écran (mon hypothèse "déjà fullscreen ⇒ autorisé" était fausse). Et de toute façon l'activation transitoire (~5 s) est expirée quand la source du nouvel épisode finit de se résoudre.

**Nuance découverte en testant le mécanisme dans un vrai Chrome** (script Playwright + Chrome système, `scratchpad/fs-mechanism.html`) : une re-demande **sans geste est accordée si la cible est un DESCENDANT** de l'élément plein écran courant (plein écran imbriqué), et refusée sinon. Mon host vivait dans `_app`, donc **frère** du player, pas ancêtre → refus. C'est exactement ce que la console montrait.

**Refonte (design final).** L'élément plein écran doit être **stable depuis le début** : c'est `document.documentElement`, qu'aucune navigation ne démonte → **plus jamais de re-demande**. Le "player en plein écran" devient du **CSS** (`aniscroll-player-fs` : `position:fixed; inset:0; z-index:9999`) — c'est-à-dire le pseudo-fullscreen déjà éprouvé pour iOS, **généralisé à toutes les plateformes**, avec le vrai plein écran racine par-dessus pour faire disparaître la chrome du navigateur. Mesuré en vrai Chrome : démonter/remonter l'enfant **ne perd pas** `document.fullscreenElement` (= HTML). Nouveau module `lib/player/playerFullscreen.ts` (état hors React pour survivre au remount + `usePlayerFullscreen`), `episodeTransition.ts` réduit à l'overlay de chargement (plus aucun appel Fullscreen).

**Pourquoi la racine et pas un wrapper ancêtre du player** (les deux résolvent la persistance) : quand Vidstack ne se croit pas en plein écran, il **portalise ses menus vers `<body>`** sur layout mobile (`<Portal disabled="fullscreen">` — le portal n'est désactivé QUE s'il se croit fullscreen). Avec un wrapper ancêtre, `<body>` est **hors** du sous-arbre plein écran → menus invisibles en plein écran mobile. Avec `<html>` comme élément plein écran, tout le document est dedans → les menus s'affichent (leur `z-index:9999999` passe au-dessus de notre wrapper à 9999). C'est ce détail qui a tranché entre les deux.

**Le prix à payer, assumé et compensé** : l'état `fullscreen` de Vidstack reste faux. Donc (1) on **cache son bouton plein écran** (son icône/label viennent de son état → il afficherait "Entrer en plein écran" *en* plein écran) et on portale **le nôtre** juste après, ancré sur le bouton natif resté dans le DOM ; (2) on **pose `data-fullscreen` à la main** sur la racine du player → toutes les règles `[data-fullscreen]` existantes (thème Vidstack **et** nos globals : rayon, ratio, taille des boutons, échelle des sous-titres) continuent de marcher (Vidstack n'écrit cet attribut que sur changement de son état, qui n'arrive plus → il ne nous le reprend pas) ; (3) le geste **double-clic** `toggle:fullscreen` de Vidstack est **intercepté** en capture (il entrerait dans SON plein écran, que le changement d'épisode retuerait). `keyDisabled` fait que son raccourci `f` n'existe pas, donc pas d'autre porte d'entrée. Bonus : le pseudo-fullscreen iOS n'est plus un cas spécial, et le verrou d'orientation/scroll est étendu à tout appareil tactile.

**Dernier bug (3ᵉ test user) : "le 1er next marche, le 2ᵉ sort du plein écran".** Le relâchement du mode était branché sur le **démontage de UniversalPlayer** (gardé par "sauf si une transition est en cours"). Or le player est remonté **bien plus souvent** que "l'utilisateur est parti" : sa clé est `{serveur}-{aniId}-{épisode}-{dub}`, donc il remonte aussi sur un **repli de serveur** (l'épisode testé avait un flux en 403) et pendant un battement quand le **numéro d'épisode du router arrive avant les données du stream**. Ces remounts arrivent *après* le claim (donc `pending=false`) → le garde-fou les laissait relâcher l'écran. **Fix : c'est la PAGE watch qui relâche** (`useEffect(() => () => setPlayerFullscreen(false), [])`) — elle reste montée sur toute la route (tous les changements d'épisode) et ne se démonte qu'en partant vraiment. Plus aucun remount, dans aucun ordre, ne peut tuer le plein écran. **Leçon : ne pas confondre "le composant se démonte" et "l'utilisateur s'en va"** — sur une page dont un enfant est keyé, le démontage de l'enfant est un signal de *reconstruction*, pas de sortie.

**Validation (vrai Chrome, sur le preview déployé, pas en local)** : Playwright + Chrome système, clic réel sur notre bouton plein écran puis 3 `next` d'affilée → `document.fullscreenElement === HTML`, classe CSS et `data-fullscreen` présents, label "Quitter le plein écran", épisodes 1→2→3→4, zéro erreur console. Script : `scratchpad/live-test2.mjs` (le local ne résout pas les sources : inutile d'y tester le player).

**Leçon (la vraie) : ne jamais bâtir une feature sur un `requestFullscreen` qu'on ne peut pas garantir.** L'API n'est utilisable qu'au moment du geste ; tout ce qui doit survivre à une navigation doit être plein écran **avant** de naviguer, sur un élément que rien ne démonte.

**Bug intermédiaire — "sorti du plein écran de force" (1ère correction, gardée pour la leçon).** Cause : **changer d'élément plein écran n'est pas atomique**. Quand on demande le plein écran pour le host alors que `.vds-player` l'a, le navigateur **sort d'abord** (`fullscreenchange` avec `fullscreenElement === null`) **puis entre** sur le host (2ᵉ `fullscreenchange`). Ma détection d'Échap prenait le null intermédiaire pour un abandon utilisateur → `cancel()` → host repassé en `display:none` **alors qu'il devenait l'élément plein écran** → puis le garde-fou "host obsolète" voyait `fullscreenElement === host` avec `pending=false` → `exitFs()` → **sortie forcée**. Trois correctifs : (1) flag `swapping` posé autour de NOS `requestFullscreen` — on ignore tout `fullscreenchange` pendant un swap qu'on a initié, le verdict vient de la promesse ; (2) toute décision sur un `fullscreenchange` est **re-vérifiée après 300 ms** (`SETTLE_MS`) au lieu d'être prise sur le premier signal ; (3) le host n'est plus `display:none` mais `opacity:0 + pointer-events:none` — un élément non rendu peut recevoir le plein écran et s'afficher en noir sans la barre. Ajouté `?fsdebug` dans l'URL → trace chaque étape en console (begin/claim/refus/cancel) : un bug de plein écran est irreproductible sans savoir **quelle** étape le navigateur a refusée. **Leçon : ne jamais traiter un `fullscreenchange` isolé comme un fait — c'est un flux d'états transitoires.**

**Taille du bouton (retour user : "un poil trop petit").** Nos boutons custom codaient en dur `h-10 w-10` + icône `h-7 w-7` (28 px), alors que Vidstack dimensionne les siens via `.vds-button` = `--media-button-size` (40 px, **42 px en plein écran**) et l'icône via `.vds-icon` = **80 %** (32 px). D'où des glyphes visiblement plus petits que play/mute/fullscreen à côté. Fix : retirer les tailles fixes et ajouter la classe `vds-icon` aux `<svg>` → les 4 boutons custom (Download/Subs/Cast/Next) suivent exactement la métrique native, y compris le passage 40→42 px en plein écran. **Leçon : dans la chrome Vidstack, s'appuyer sur ses variables/classes plutôt que sur des tailles Tailwind figées** (ses règles sont en `:where()`, donc n'importe quel utilitaire Tailwind les écrase silencieusement).

**Garde-fous** : Échap pendant la transition (fullscreenchange → `fullscreenElement` null) → on annule et la page charge en fenêtré ; **watchdog 25 s** si personne ne réclame l'écran (source morte) → on sort du plein écran au lieu de bloquer sur un host noir ; si le 2ᵉ `requestFullscreen` est refusé (navigateur exigeant un nouveau geste) → on sort proprement = comportement d'avant, jamais de piège. iOS n'a pas de vrai plein écran (pseudo-FS CSS dans un state React que le remount perdait) → le flag est **mirroré hors de l'arbre** (`setPseudoFullscreenActive`) et restauré par le player suivant, nettoyé quand on quitte vraiment la page.

Tous les chemins de changement d'épisode du player passent maintenant par `navigateToEpisode()` : bouton de la barre, CTA "Next Episode" de SkipOverlay, **auto next episode**, raccourcis clavier next/prev. **Non couvert** (choix) : le changement d'épisode piloté par un pair en Watch-2gether (`router.push` dans la page watch) et le changement de **serveur**, qui démonte aussi le player.

**Bug trouvé en passant (bloquait tout `next build`)** : `lib/db/opedHostSkips.ts` avait `op_*/ed_*` dans un commentaire `/** */` — le `*/` **ferme le commentaire** → `Parsing error: ';' expected` à l'ESLint de build. Corrigé. Leçon : jamais de `*/` littéral dans un bloc de commentaire (et `next build` local échouait donc AVANT cette session — le lint de build est un gate réel).

**Note outillage** : `npx tsc --noEmit` sur tout le projet **OOM** (>8 Go, `allowJs` + `tools/` + `worker/` + toutes les pages dans un seul programme). Pour valider une modif : tsconfig scopé aux fichiers touchés (+ leurs imports) dans le scratchpad → 0 erreur ici ; `next lint --file …` marche normalement.

## 2026-07-30 (suite) — `tools/usage-monitor` : collecteur de diagnostic usage quotidien

Nouveau tool pour comprendre **d'où vient le volume** sans deviner. `node tools/usage-monitor/collect.mjs` écrit un snapshot daté + `LATEST.md`/`HISTORY.md` avec deltas jour/jour :
- **Census keyspace Redis** (REST, SCAN complet borné) → clés bucketées par préfixe (`src:`/`avail:`/`episode:`/`lock:`/W2G `room:`…). C'est l'attribution que le chiffre agrégé Upstash ne donne pas — si `src:` domine, le levier est le fan-out `/source`, pas les GET edge-cachés.
- **Daily requests Upstash** (management API, optionnel) → la courbe "Daily Commands" + **projection mensuelle vs cap 500K** + flag saturation. `databaseCount>1` = dev/prod déjà séparés.
- **Déploiements Vercel** (API, best-effort) → corréler un pic avec une release (Vercel n'expose pas d'API publique invocations/CPU par route sur Hobby).
- Section **Flags** en tête (projection cap, DB partagée, spike J/J, explosion de préfixe). Action GitHub `.github/workflows/usage-monitor.yml` (cron 06:20 UTC) commit le snapshot ; creds en secrets repo.

**Effet de bord trouvé en testant :** le `REDIS_URL` de `.env.local` pointe sur une **vieille DB Upstash supprimée** (`stable-tahr-110008`, NXDOMAIN) → le dev **local tourne sans Redis** (cache désactivé). La DB live est `aniscroll-cache` (creds seulement dans Vercel). Pour lancer le census sur la vraie DB : mettre `UPSTASH_REDIS_REST_URL`/`_TOKEN` de `aniscroll-cache`. Le tool a été validé de bout en bout (rendu rapport + flags + deltas + projection) sur snapshot synthétique.

## 2026-07-30 — Upstash toujours ~31k cmd/j après le fix edge-cache : le vrai volume = re-probe des `absent` sur `/source`

Constat user (captures Upstash + Vercel) : **le volume Upstash n'a PAS baissé** après le fix du 29/07 (Mer 31 673 cmd, à peine sous les ~35k d'avant). Le fix est pourtant bien en prod (`main` `97b732d` : availability edge-cachée + `/source` CDN + `LOCK_POLL=350`).

**Pourquoi le fix du 29 ne pouvait pas faire baisser la courbe :**
- Il a edge-caché **catalog / discover / episode / availability** = endpoints à **faible trafic** (bas du tableau Vercel : episode 406, availability 759 inv).
- L'edge-cache n'aide que si plusieurs visiteurs tapent la **même URL** dans la fenêtre TTL. Or le trafic est **long-tail par épisode** (`aniId:episode:sub` quasi unique en 10 min) → **taux de hit edge faible**. C'est structurel, pas un bug de config.

**Le vrai consommateur = `/api/v2/source`** (5,7K inv / ~12h, loin devant). C'est un **POST → jamais edge-cachable** : chaque probe traverse la fonction et fait ≥1 commande Upstash. La page watch tire un **fan-out ~17 probes/chargement**.

**L'amplificateur non traité :** les serveurs marqués `absent` dans le snapshot cross-visiteur étaient **re-probés à CHAQUE visite** ([watch/[...info].js] `hydrateFromServer` → `snapshotAbsent`), et `probe()` fait **2 tentatives** (gestion decoy anti-bot). Comme ~la moitié des ~17 serveurs sont absents → **~8 × 2 = ~16 GET Redis par visite d'un épisode déjà connu**, uniquement pour redécouvrir des absences déjà confirmées. Les serveurs `ok`, eux, étaient bien skippés.

**Fix appliqué (dev, choix user "1 tentative + proba 20%") :**
- **Re-probe probabiliste** des `snapshotAbsent` : `SNAPSHOT_ABSENT_REPROBE_P=0.2` — on ne re-probe un absent que ~1 visite/5 (drop dans le calcul de `remaining`). Un host récupéré est redécouvert en ~5 visiteurs, bien dans la fenêtre 6h.
- **1 seule tentative** pour un absent connu (pas le double-retry decoy, qui ne sert qu'aux inconnus froids).
- Effet attendu : coût `/source` d'un épisode connu ~16 GET → ~2 GET (÷~5-8). Seul levier qui fait réellement plonger Upstash (edge-cache impuissant sur un POST long-tail).

**Question tranchée (30/07) : dev (Preview) et Prod PARTAGENT la même DB Upstash** — et c'est la vraie explication du 31k qui ne bouge pas. Preuves : (1) une seule DB `aniscroll-cache` en console ; (2) une env var Vercel non scopée s'applique à TOUS les environnements. **Découverte clé en inspectant `main` :** la PROD n'a PAS le bug de volume — sur `main`, les serveurs `absent` du snapshot vont dans `cachedFailed` (jamais re-probés, 0 commande). C'est **`dev` qui a régressé** ça (absents → `snapshotAbsent` → re-probe ×2 à CHAQUE visite ≈ ×16 GET/visite watch). Donc le 31k de la DB partagée = prod (lean) **+ dev (glouton ×16)**. → **NE PAS porter le fix re-probe sur main** : main est déjà lean, ça ferait 0→20% de re-probe = régression usage. Décision user : **séparer les DB** (2ᵉ DB Upstash gratuite + `UPSTASH_REDIS_REST_URL`/`_TOKEN` — ou `REDIS_URL` — scopés *Preview*, + `.env.local` vers la DB dev). Aucun code à changer : `lib/redisRest.ts` `resolveConfig()` lit purement les env vars, zéro URL hardcodée. Le fix re-probe dev (`SNAPSHOT_ABSENT_REPROBE_P=0.2`) reste utile pour rendre dev lean en bonus.

**Leçon :** l'edge-cache HTTP ne réduit le volume Upstash que sur des **GET à URL partagée et chaude**. Sur du **POST** (ou du GET long-tail par-épisode), le seul levier est de **réduire le nombre de requêtes / commandes-par-requête** (ici : ne pas re-prober ce qu'un visiteur a déjà tranché). Toujours identifier l'endpoint qui DOMINE le volume (Vercel invocations × cmd-par-req) **avant** d'optimiser — le fix du 29 a optimisé le petit.

## 2026-07-29 — Explosion du Fluid Active CPU (Vercel) depuis le 18/07 : plafond Upstash gratuit

Le Fluid Active CPU a explosé (**6h24 / 4h**, pic isolé **1h20 le 18/07**, puis palier **×2‑3** vs. début juillet). Diagnostic + fix (commits `fcbd942`, `79d4632`, sur `dev`).

**Cause racine — plafond de commandes Upstash gratuit.** Upstash Free ≈ **500K commandes/mois** (~16k/j soutenable), mais volume réel **~35k/j** (~1M/mois, **~2× le cap**, lu dans la console : Sam 40k / Dim 28k / Lun 44k / Mar 34k). L'allocation mensuelle s'épuise **à mi‑mois** → Upstash throttle → le cache Redis ne sert plus de hits → **chaque requête recompute** (AniList/scrapes au lieu d'un GET) → le CPU déborde le plafond Hobby 4h.

⚠️ **Correction (piège d'analyse) :** j'avais d'abord attribué le pic du 18 au bump de clé `episode:v4→v5` du 17/07. **Faux pour prod** : `main` (prod) date du **5 juillet** et n'a jamais reçu ce commit (il est resté sur `dev`/preview). Le pic prod s'explique donc uniquement par le **volume vs cap**, pas par le bump. **Question ouverte clé : `dev` (preview, testé en continu) et prod partagent-ils la même DB Upstash gratuite ?** Si oui, le trafic de dev brûle le budget commun et tue aussi le cache de prod → à vérifier dans la console (une DB ou deux ?). Leçon : toujours vérifier `git log origin/main..origin/dev` **avant** de bâtir une timeline — prod ≠ dev.

**Ce que Redis fait vraiment (2 rôles) :** (1) **cache** (episode/catalog/discover/availability/recent/health…) = l'essentiel du volume, proportionnel au trafic ; (2) **état partagé** W2G rooms/présence/chat + merge availability + lock single-flight `/source` = besoin d'un KV, volume faible. → **Supprimer Upstash = mauvaise idée** (CPU haut en permanence + W2G cassé). Le bon move = **vider Redis de son rôle de cache** vers l'edge HTTP **gratuit** de Vercel (hors quota), Upstash ne garde que l'état.

**Fix appliqué (option B) :**
- `catalog/[sort]`, `discover/[page]` : fenêtre edge **60s → TTL Redis (1h / 30min)** via `CDN-Cache-Control`. Avant, `s-maxage=60` faisait re-traverser la fonction (et payer un GET) toutes les 60s.
- `episode/[id]` : edge **30min → 24h** pour séries **terminées** (liste immuable) ; **30min gardé** pour les en‑cours (nouvel épisode visible vite). + suppression de la **copie inutile par épisode** dans `filterData` (coût CPU réel sur One Piece/Conan, chemin cache‑hit).
- `availability` GET : edge **300 → 600s** (`CDN-Cache-Control`).
- `/source` : `LOCK_POLL_MS` **150 → 350ms** — le polling follower du single-flight = **amplificateur de GET** pendant les vagues (jusqu'à 40 GET/follower sur les 6s → ~17).
- `og` : header cache long — **mais runtime `edge`, PAS Fluid** → correctness, ne compte pas dans la métrique qui a explosé.

**Leçons/pièges :**
- **Ne jamais bumper une clé de cache « à sec ».** Invalidation totale = pic CPU + rafale de commandes garantis. Migrer/backfiller.
- Sur Upstash gratuit, un `redis.get` par requête sur un endpoint **identique pour tous** est du gaspillage → **edge cache HTTP** (gratuit, hors quota). `CDN-Cache-Control` (edge) ≠ `Cache-Control` (navigateur) : split pour un TTL edge long sans forcer le cache navigateur.
- `og` = runtime **edge** = pool compute distinct de **Fluid** ; optimiser og ne bouge PAS la métrique Fluid.

**Release prod (fait) :** `dev` était **117 commits devant `main`** (features non sorties : episode thumbs, éditeur raccourcis, notices, W2G, opening-detector). Donc **pas** de merge `dev→main` complet — **release perf uniquement** via une branche `perf-cpu-fix` partie de `main` : 2 cherry-picks du 29 (SSR résilient Redis + cut volume recent/translate) + réapplication à la main des 6 fixes edge-cache sur les versions `main` (l'edit `episode/[id]` s'appliquait proprement car main est en clé `v3` sans Simkl). Mergé dans `main` (`97b732d`), 10 fichiers, 0 code de feature. ⚠️ **Piège futur :** le prochain merge `dev→main` complet **conflictera sur `episode/[id].tsx`** (main = v3+perf, dev = v5+Simkl+perf) — résoudre en gardant la version dev + les 2 perf (no-clone `filterData`, `edgeSmaxage`).

**Reste à faire :**
- Soulagement CPU **immédiat** = dépend du cycle Upstash : reset le 1er du mois, ou **pay‑as‑you‑go ~2 $/mois** en attendant. Le fix code empêche surtout la **récidive** les mois suivants.
- **Vérifier si dev et prod partagent la même DB Upstash** (cf. cause racine) — si oui, séparer, sinon le budget prod restera pollué par les tests dev.
- Vérifier **Upstash → Usage mensuel** (saturation ~le 18 ?) et les headers `X-Cache` / `age` sur catalog/discover/episode en prod.

## 2026-07-14 — OP/ED : fin d'OP tronquée à 4:00 (fenêtre) + megaplay ED décalé (credited faible override audio)

Validation sur **JJK S1** (AniList 113415, mal 40748). Deux bugs distincts trouvés en vérifiant l'ép3 au pixel.

**Bug 1 — OP end tronqué à 4:00 pour tous les lecteurs anime-sama.** `OP_WINDOW=(0,240)` ne décode que les 4 premières min. L'OP de JJK (90s) démarre à 3:12 → finit à **4:42**, donc **à cheval** sur le bord 240s. Le match fenêtré en capturait ~48s (fill 0.53, juste au-dessus de `min_fill=0.5`) et renvoyait un hit **tronqué à 4:00**, ce qui **supprimait** le fallback épisode-complet (déclenché seulement si `hit is None`). ep2 (OP entièrement hors fenêtre à 5:45) marchait, lui, via ce fallback. Tous les hosts d'accord sur 4:00 = signal partagé (fenêtre), pas du bruit par lecteur.
- **Fix** : `_window_clipped(hit, win)` — détecte que `theme_t0 + ref_duration` déborde la plage décodée (marge 1s, un bord = fin d'épisode ne compte pas). Le fallback se déclenche alors **aussi sur troncature**, pas que sur `hit is None`, et garde le match qui couvre le plus de la réf (`r_end - r_start`).
- **Perf** : au lieu de re-décoder l'épisode entier (~24 min audio **et** keyframes vidéo → très lent), le fallback décode une **fenêtre élargie** `(theme_lo-12, theme_hi+12)` (~2 min) puisque l'audio a déjà localisé le thème. `video_win` dérivé de même pour ne jamais scanner les keyframes de tout l'épisode. Résultat ép3 : OP **3:12→4:40** (span 88s, 278 votes vs 197 avant).

**Bug 2 — megaplay ED à 21:20 au lieu de 21:15 (même contenu/durée que les autres).** Prouvé au pixel : megaplay@1362 == sibnet@1362 (frame « 制作 MAPPA » identique) → **même timeline**. megaplay = source `mewstream.buzz` (HLS, construite depuis le MAL id), keyframes clairsemées → match **credited faible (137 votes)** qui **overridait l'audio très fort (2616 votes)** et décalait le start de ~10s. L'ED ouvrant sur un **aplat cyan sans détail**, l'image ne peut pas y planter un bord.
- **Fix** : `CREDITED_OVERRIDE_AGREE_BAND_S=4.0` — un credited n'override un hit audio **fort** que si son `theme_t0` est à ≤4s de l'ancre audio. Désaccord large → on **garde l'alignement audio** (flag `video_disagreement`). Ne gate que l'audio fort ; audio faible/absent cède au credited comme avant. megaplay ép3 : ED **21:20→21:10** (audio, vrai ≈21:12). Fin encore ~6s tôt (22:38 vs ~22:44) : son credited HLS reste trop pauvre pour caler le fondu — plafond de la source.

Aussi : `diag_match.ms()` floor → **round-to-nearest** (le floor biaisait chaque timecode ~1s tôt).

**Constat clé** : les 3 lecteurs anime-sama (sendvid/sibnet/vidmoly) donnent un résultat **identique au dixième** (même source). Seuls **megaplay** (mewstream) et **vidmoly-va** (voir-anime) divergent = providers réellement différents (encodage/keyframes/intro). Les bords OP/ED étant des fondus/aplats, le calage image y est intrinsèquement ambigu.

**Prochaine piste (idée user)** : **ancrage sur image-repère** — repérer 1–2 frames *distinctives* (haute entropie) de la réf credited, les localiser (match unique) dans l'épisode, et **projeter** les bords via la géométrie connue du clip, au lieu de planter le bord sur un aplat/fondu. Devrait fixer megaplay (une seule keyframe repère suffit) et les fins en fondu. Plan à établir.

## 2026-07-10 — OP/ED : précision ~0.25s sur les 4 bords (refine image *credited* dense)

Problème : le détecteur OP/ED se trompait de plusieurs secondes, surtout sur la **dernière frame de l'ED**. Objectif user : que la « dernière frame » de notre timing soit à ~0.25s près de la vraie dernière frame dans le player, sur **les 4 bords**.

**Cause racine (3 cumuls)** :
1. Précision vidéo plafonnée à ~0.5–1s : `SAMPLE_FPS=2.0` + bins de vote arrondis à 1s entière (`best_match_video`).
2. Fin credited déléguée à l'audio (`_refine_hit(end_only=True)`) — or la dernière frame IMAGE d'un fondu au noir ne correspond à aucun cut audio.
3. API `opedRowToSkip` arrondissait à la **seconde entière**.

**Fix — refine dense ancré sur l'image credited** (décision user : précision d'abord, décodage dense OK) :
- `video_fingerprint.py` : nouveau `refine_edge_credited_video()` **pur** — re-décode ep + réf credited à `DENSE_FPS=12` sur une fenêtre ±3s autour du bord grossier, apparie chaque frame ep à sa frame réf alignée (`t_ref = t_ep - theme_t0`), et trouve la transition sub-seconde (start = 1er run soutenu matché ; end = dernière frame matchée — **robuste au fondu au noir** car ep+réf fondent ensemble et matchent jusqu'à la dernière frame credited). + `decode_dense_window()`.
- **Bug latent corrigé** : `extract_keyframe_hashes` ne mettait PAS `fps` dans la clé de cache → un décodage 12fps aurait renvoyé le `.vfp.npz` 2fps. Tag `.fps12` ajouté ; tag vide à 2fps → caches existants préservés.
- `theme_bank.py` : champ `ThemeHit.video_theme_t0` (ancre stable) ; `_refine_credited_dense()` OWN les 2 bords d'un hit credited (remplace le snap audio `end_only`) ; **sharpe aussi les hits audio** quand une réf credited existe, **gardé** par plancher de votes + bande de sanité ±2s (`DENSE_AUDIO_SHARPEN_BAND_S`) + flag `sharpen_audio_with_credited`. Sans réf credited → refine audio inchangé (fallback).
- Threading `resolve_video_dense` : `detect_op_ed` → `multi_host` (`detect_per_host`/`detect_op_ed_multi`, **sans** resserrer les tolérances d'outlier) → `batch_detect.py` + `detect_anime.py` (single + multi-host).
- API `pages/api/v2/skip` : arrondi 2 décimales au lieu d'entier (DB stocke déjà des floats). Fallbacks AniSkip/Anime-Skip laissés à la seconde.

**Vérif** : unit test pur (bords exacts, None si pas de match) ✓ ; test d'intégration `detect_op_ed` avec resolvers mock (fondu au noir) → erreur de fin **0.067s** ✓ ; tout compile, rétro-compatible (params optionnels).

**Leçon/piège** : le refine dense attend des `times` **window-relatifs** (comme `decode_dense_window` les produit) + `*_win_off` ; en full_fallback (audio None) `used_win=None` → `_abs_offset=0`, donc `resolve_video(None)` doit renvoyer des times **absolus**. **Reste à faire** : check visuel décisif sur vrai anime (JJK ED1 fondu au noir) via `detect_anime.py` + extraire la frame à `end` avec ffmpeg pour confirmer que c'est bien la dernière frame de l'ED.

## 2026-07-06 (suite 21) — toasts player : pile collapse sonner (max 3) + barre fine teintée + croix

Retours user : la barre était trop épaisse / mal placée / trop blanche « flashy », et en fullscreen les toasts s'empilaient à l'infini au lieu de se collapser comme sonner (max ~3 visibles derrière, + une croix).

- **Pile collapse (fullscreen)** : on ne rend que les **3 plus récents** (`slice(-3).reverse()`). Le plus récent est devant (bas-droite), pleine opacité ; les 2 derrière sont `translateY(-14px*depth) scale(1 - 0.05*depth)`, opacité 0.6, `transformOrigin: bottom right` — le look « collapsed » de sonner. Chaque toast a un **bouton ✕** (top-right) pour le fermer. Conteneur `height:0` comme ancre absolue.
- **Barre de temps** : réduite **3px → 2px**, et **teintée `color-mix(in srgb, currentColor 45%, transparent)`** au lieu de blanc — `currentColor` = le texte rouge du toast → la barre matche la carte au lieu d'un trait blanc criard. Appliqué à la réplique in-player ET aux toasts sonner (`[data-sonner-toast]::after`, `currentColor` = couleur de texte richColors par type).

## 2026-07-06 (suite 20) — toasts player : barre de compte à rebours + vraie pile en fullscreen

Retours user : (1) ajouter sous chaque notif une petite barre blanche indiquant le temps restant ; (2) en fullscreen les notifs doivent **s'empiler** comme en fenêtré (avant : 2 slots fixes subNotice/chatWarning → une nouvelle notif identique écrasait la précédente).

- **Pile réelle in-player** : remplacé les états `subNotice`/`chatWarning` par une **file** `playerToasts: {id,msg,dur}[]` (id auto-incrémenté). `pushPlayerToast(msg,dur)` ajoute + programme le retrait ; `dismissPlayerToast(id)` filtre. `showPlayerNotice(msg,dur)` route : fenêtré → `toast.error` (sonner), fullscreen/pseudo-FS iOS → `pushPlayerToast`. `showSubNotice` = wrapper 3500 ms ; chat = 2600 ms. Timers nettoyés à l'unmount.
- **Barre de compte à rebours** : keyframe `toastCountdown` (scaleX 1→0). Réplique in-player : `<span>` absolu en bas, `animation: toastCountdown {dur}ms linear forwards` (conteneur `overflow:hidden` + `position:relative`). Toasts sonner fenêtrés : `[data-sonner-toast]::after` (sonner 1.0.3 n'a pas de barre native) animé sur 4 s (durée par défaut), coins bas via `border-bottom-*-radius: inherit` (pas d'`overflow:hidden` pour ne pas rogner le closeButton). Masqué sur `[data-removed=true]`.

## 2026-07-06 (suite 19) — notices subs/chat : vrai toast sonner en fenêtré, réplique in-player en fullscreen

Retour user (suite de la suite 17) : il veut le **vrai toast sonner** du site (carte rouge richColors, bas-droite) en mode fenêtré, et **la même chose répliquée dans le player** en plein écran (où un toast sur `<body>` est masqué).

- `inFullscreenNow()` : helper qui teste `fullscreenElement || webkitFullscreenElement || iosPseudoFsRef.current` (le pseudo-fullscreen iOS CSS masque aussi les toasts `<body>`). `iosPseudoFsRef` = mirror de l'état `iosPseudoFs` (synced via effect).
- `showSubNotice` et le handler `partyChat` (pas de party) : **fenêtré → `toast.error(msg)`** (sonner, exactement le style du site) ; **fullscreen → `setSubNotice`/`setChatWarning`** qui alimentent la réplique in-player.
- Réplique in-player restylée aux **couleurs exactes de sonner 1.0.3 richColors "error" (dark)** : bg `hsl(358,76%,10%)`, bordure `hsl(357,89%,16%)`, texte `hsl(358,100%,81%)`, + icône cercle-exclamation rouge, gras 600 — identique au toast fenêtré. Toujours portalée dans `playerElState`, bas-droite (`right:16, bottom:88`), empile subs+chat.
- `toast.error` (rouge) et non `warning` (ambre) pour coller au SS fourni par le user.

## 2026-07-06 (suite 18) — Ctrl+R rotait la vidéo au lieu de recharger

Bug : `comboFromEvent` ne garde que le `event.code` physique (ex. `keyr`) et **ignore les modificateurs**. Donc `Ctrl+R` matchait le binding `rotate` (r) et `preventDefault()` tuait le reload navigateur. Idem pour tout chord OS (Cmd+L, Ctrl+T…).

Fix dans le dispatcher clavier (`UniversalPlayer`, `onKey`) : on **bail avant le lookup si `ctrlKey || metaKey` est actif**, sauf si la touche pressée EST elle-même un modificateur (`code` commence par `control`/`meta`) — pour ne pas casser un binding standalone sur Ctrl/Meta. L'éditeur ne peut de toute façon pas binder de combo Ctrl/Meta, donc un tel chord est toujours celui du navigateur.

## 2026-07-06 (suite 17) — notices player (subs incrustés / chat) au format toast du site (bas-droite, fullscreen-safe)

Retour user : les bannières in-player « sous-titres incrustés » (bas-centre) et « rejoins une party » (haut-centre) marchaient mais ne ressemblaient pas aux toasts sonner du reste du site (petite carte en bas-droite). On veut le même look **tout en restant visible en plein écran**.

- Un vrai `toast()` sonner rend dans `document.body` → invisible quand `.vds-player` est l'élément fullscreen. Donc on ne peut pas juste réutiliser sonner.
- Solution : une **pile de toasts in-player** unique, portalée dans `playerElState` (createPortal), stylée comme la carte sombre de sonner (rounded 12, `rgba(10,10,10,0.94)`, bordure blanche 12 %, blur, ombre), positionnée **bas-droite** (`right:16, bottom:88` pour passer au-dessus de la barre de contrôle). `pointer-events:none` sur le conteneur, `auto` sur chaque carte (clic = dismiss).
- `subNotice` et `chatWarning` (états existants) sont routés dans cette même pile et **empilés** (gap 8). Supprimé les deux anciens blocs (bas-centre + haut-centre). Timers d'auto-dismiss inchangés (3,5 s / 2,6 s).

## 2026-07-06 (suite 16) — countdown négatif + trads manquantes (schedule) + keys tooltip + onglet Découvrir

Retours user :
- **Compte à rebours "à ne pas manquer" affichait des valeurs négatives** (`-1 j / -3 h / -34 min / -53 s`) : quand l'heure de diffusion cible est déjà passée, `countDown` devient négatif et `Math.floor` propage le signe sur chaque unité. Corrigé dans `useCountdownSeconds` : `Math.max(0, rawCountDown)` en tête de `getReturnValues` → on affiche 0/0/0/0 jusqu'à ce que `update()` charge le prochain épisode.
- **"Don't miss out!" / "Coming Up Next!" en dur** dans `components/home/schedule.js` (jamais traduits). Extraits en `home.dontMissOut` / `home.comingUpNext` (en + fr : « À ne pas manquer ! » / « Prochainement »).
- **Tooltip de l'éditeur de raccourcis : noms de touches en dur en français** (`capGlyph` retournait « Espace », « Entrée », « Flèche gauche »…). Passe par `shortcuts.keys.*` (en+fr), `capGlyph(code, t)`. Les labels imprimés SUR les caps AZERTY (ù, *, ;) restent tels quels.
- **Onglet FR "Découverte" → "Découvrir"** (`nav.discover`).

## 2026-07-06 (suite 15) — layout raccourcis corrigé + icône chat + ghosts Entrée/Espace + chat non-fullscreen

Retours user (2e passe sur les raccourcis) :
- **Layout corrigé (v4→v5)** : `$`=frameFwd, `^`=frameBack, `p`=prevEp, `o`=PiP, `s`=stats, `d`=cast, `f`=fullscreen, `c`=subs, `v`=screenshot, `b`=lien, `n`=nextEp, `;`=rateDown, `:`=rateUp. `keym`/`keyg`/`keyi` deviennent libres. Bump storage sinon les maps v4 sauvegardées écrasent les nouveaux défauts.
- **Icône chat** = SVG Material "chat" fourni par le user (bulle + lignes de texte), remap `translate(0,24) scale(0.025)`.
- **Ghost de drag** : retiré le cap de largeur à 240px (l'Espace prend enfin sa vraie largeur ; Chrome snapshot les images larges tant que le ghost est opaque + on-screen). Enter = moitié haute de la case (rectangle large 1.5u × 1 rangée), pas le bounding box 2 rangées.
- **Chat non-fullscreen ne force plus le plein écran** : le handler `partyChat` dispatch juste `aniscroll:openPartyChat`. En fullscreen → `FullscreenChat` (gate `active`) ouvre + focus ; fenêtré → `WatchPartyPanel` (gate `!document.fullscreenElement`) focus son composer. Exactement un des deux réagit.
- **Message d'erreur "pas dans une party" visible en fullscreen** : `toast.error` rend dans `document.body` → invisible quand le player est l'élément fullscreen. Remplacé par une bannière éphémère (`chatWarning`) rendue DANS le player (z-60, auto-dismiss 2.6 s).

## 2026-07-06 (suite 14) — ghost Entrée trop petit + megaplay sous les menus + doublon seek ±5s

Retours user :
- **Ghost de drag de la touche Entrée trop petit** : `onDragStart` mesurait `e.currentTarget` (le cap intérieur) qui porte `transform: scale(0.9)` au survol — or une touche est TOUJOURS survolée au moment où on la saisit → rect 10 % trop petit. Corrigé : on mesure le **parent** (la case de grille, jamais scalée) et on retire l'inset `GAP_PX`. Pour l'ISO Enter (forme en L, `h:2`) le ghost prend la **moitié haute** (tuile 1 rangée large) plutôt que le bounding box 2 rangées — marqué via `data-enter="1"`.
- **Gros bouton play (megaplay) par-dessus les menus** : `CenterPlayButton` (z-index 15) couvrait chapitres/settings/sous-titres Vidstack. Il n'apparaît qu'avant le 1er play (`everStarted`), donc visible si position reprise mais jamais lancée. Corrigé : on lui passe `menuOpen={vdsMenuOpen}` (état déjà suivi via `data-open`) → `return null` quand un menu est ouvert, réapparaît à la fermeture.
- **Doublon raccourci seek ±5s** : `seekBackwardLong`/`seekForwardLong` (j/l) faisaient exactement le même ±5s que `seekBackward`/`seekForward` (flèches). Supprimé les deux actions "Long" (type union, catalog, defaults, switch, icônes, i18n en/fr).
- **cycleServer (z) suit l'ordre d'affichage** : le handler dans [...info].js itérait sur l'ordre brut de `lib/servers` filtré par confirmed only. Réécrit pour reproduire EXACTEMENT l'ordre du sélecteur : `[...multi, ...vo, ...vf]` (chaque groupe fastest-first via `getServersByLang`) filtré par la même règle `shouldShow` (actif toujours visible, failed masqué, iframe toujours visible, sinon confirmed). Dépend maintenant aussi de `failedServers`.
- **Nouveau layout de raccourcis par défaut** (SS user = source de vérité) : gros reshuffle de `DEFAULT_KEYBINDINGS`. Rangée haute : cycleServer=e, rotate=r, PiP=i, prevEp=o, frameBack=p, frameFwd=^. Home : partyChat=t, stats=d, cast=f, fullscreen=g, ambient=l, mute=m(semicolon), OP=ù(quote), ED=*(backslash) — **skipIntro/Outro quittent PgUp/PgDn**. Rangée basse : subs=x, screenshot=c, copyLink=v, nextEp=b, rateDown=,(keym), rateUp=;(comma), rateReset=!(slash). Volume reste sur flèches (confirmé user). **Bump storage v3→v4** sinon les maps sauvegardées (anciennes positions) écrasaient les nouveaux défauts au merge.
- **Nouveau raccourci "parler dans le chat" sur `t`** (`partyChat`) : action ajoutée (type/catalog/défaut/icône bulle/i18n en+fr). Handler : si pas de `party` → toast `party.chatNeedsParty` ; sinon entre en plein écran (le chat est fullscreen-only) puis dispatch `aniscroll:openPartyChat`. `FullscreenChat` écoute l'event (gate `active`), ouvre le panneau + focus le composer. Pas de re-trigger : le composer est `contentEditable`, le guard clavier ignore déjà `isContentEditable`.

## 2026-07-06 (suite 13) — w2g create 500 (zadd NX cassé dans le shim REST) + icônes ambient/reset + drag espace

Retours user (SS console : `/api/v2/watch2gether/create` → 500) :
- **Impossible de créer une room** : `createRoom` → `addMember` fait `redis.zadd(orderKey, "NX", ts, userId)` (syntaxe ioredis : flag NX en tête). Le shim REST (`lib/redisRest.ts`) faisait `const [score, member] = args` → `score = Number("NX") = NaN`, `member = ts`. Upstash REST **rejette un score NaN par un 500** → tout le create tombe. **Bug transverse** : cassait TOUS les `zadd` avec flag NX (ordre membres w2g, `touchPresence`, cache saison…). Corrigé : `zadd` du shim **épluche les flags de tête** (NX/XX/GT/LT/CH) en objet d'options Upstash avant de lire la paire score/member. `zrange` gère aussi `WITHSCORES` (passe `{withScores:true}`, sortie aplatie comme ioredis). Vérifié contre la signature `@upstash/redis@1.38` (`zadd(key, opts, {score,member})`).
- **Icône raccourci "Ambient lights"** = même glyphe que le toggle Settings > Ambient (Material `lightbulb_outline`), pour la cohérence.
- **Icône `rateReset`** = SVG fourni par le user : cadran Material "speed" complet avec **aiguille en haut-droite** (vitesse neutre), remap `translate(0,24) scale(0.025)`.
- **Drag de la barre espace enfin réparé** : le ghost de `setDragImage` était créé à la **taille réelle** de la touche (~500px pour l'espace) ET **hors écran** (`-9999px`) → Chrome **annule le drag** dans ce cas. Ghost repassé en **tuile fixe 44px** rendue **à l'écran** (`top:0;left:0;z-index:-1`) → toutes les touches (espace inclus) se glissent.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 12) — Raccourcis : action ambient, cap vitesse x2, ghost de drag opaque, icônes

Retours user :
- **Nouvelle action `toggleAmbient`** (activer/couper les ambient lights) : handler `setAmbientCtx(!ctxAmbient)`, catalogue (groupe view), default sur cap "p"/`keyp` (libre depuis le retrait de seekToEnd), i18n fr/en, icône ampoule+rayons. Catalogue = 37.
- **Vitesse plafonnée à x2** : `rateUp` `Math.min(2,…)` + clamp interne de `onRateChange` (4→2). (Note perf : à x2 le `<video>` décode/joue nativement 2× plus vite ; pas de « skip de frames » applicatif possible/pertinent — c'est le décodeur qui suit ou non. Rien à optimiser côté JS.)
- **Debug raccourci retiré** (le vrai fix était le garde `!event.request`, cf. suite 11).
- **rateReset** : aiguille **verticale centrée** (neutre) + arc demi-cercle symétrique + badge reset (au lieu du cadran Material asymétrique).
- **Ghost de drag = tuile opaque** construite (fond `#20242c` + icône) au lieu du clone de la touche : le clone était quasi-transparent (fill sur enfants absolus) → le navigateur en faisait un halo ovale flou. Rectangle net désormais, à la vraie taille de la touche.
- `tsc`/`lint`/JSON ok.

---

## 2026-07-06 (suite 11) — Raccourcis : FIX vitesse (garde !event.request), pavé num, icônes, hint

Retours user :
- **Vitesse ne faisait rien — CAUSE trouvée** : `onRateChange(next)` **retourne tôt si `!event?.request`** (ligne ~1562, pour ignorer les auto-resets de Vidstack). Les raccourcis l'appelaient **sans event** → no-op. FIX : les handlers `rateDown/rateUp/rateReset` posent `video.playbackRate` **directement** (effet immédiat) PUIS `onRateChange(r, { request: true })` (persistance + sync Vidstack).
- **Pavé numérique** : les touches émettent `event.code = "NumpadN"`, pas `DigitN` → aucun match. `comboFromEvent` **replie `numpadN` → `digitN`** (Num Lock requis pour émettre NumpadN).
- **Debug raccourcis** : log `[shortcut] {code, combo, action, hasVideo, rate}` derrière `localStorage.scDebug === "1"`.
- **Escape ferme** : listener déjà en place (suite 9), inchangé — capture sur window + stopPropagation.
- **rateReset** : remplace la roue-« soleil » du SVG par le **speedometer** (cadran de rateUp/Down) + badge flèche-reset en haut-droite.
- **frameBackward** : flèche décalée +1px à droite.
- **Hint du haut** : 2e phrase retirée (dragHint fr/en = juste « Glissez-déposez une icône sur la touche voulue. »).
- `tsc`/`lint`/JSON ok.

---

## 2026-07-06 (suite 10) — Raccourcis : tooltip en mots, cap "m" clair, retrait seekToEnd, icône reset-speed

Retours user :
- **Tooltip au survol = NOM de la touche en toutes lettres** (avant : symboles `↵ ⌫ ⇧`). `capGlyph` renvoie maintenant "Entrée", "Espace", "Échap", "Retour arrière", "Flèche gauche/droite/haut/bas", "Verr. Maj", "Maj gauche/droite", "AltGr", "Menu", etc.
- **Cap "m" trop foncé** : son code physique est `semicolon` (pas `key*`), donc `isMain` le classait "non-principal". Ajouté `semicolon` à `MAIN_PUNCT` → clair comme les autres lettres.
- **Retrait de l'action `seekToEnd`** ("Aller à la fin") : supprimée du type, catalogue, defaults (libère le cap "p"/`keyp`), handler, icône, i18n fr/en. Catalogue = 36 actions.
- **Icône `rateReset`** = SVG Material "speed + gear" fourni (compteur avec engrenage de réglage), remap `translate(0,24) scale(0.025)`.
- `tsc`/`lint`/JSON ok.

---

## 2026-07-06 (suite 9) — Raccourcis : FIX codes AZERTY rangée du bas, Escape ferme, icônes échangées

Retours user :
- **Vitesse (et `,`) ne marchaient toujours pas** — CAUSE : les `event.code` de la **rangée du bas** étaient faux. `event.code` nomme la position **physique QWERTY** ; sur AZERTY les caps `, ; : !` sont aux positions physiques **KeyM / Comma / Period / Slash**, pas `comma/period/slash/intlbackslash`. Corrigé : cap ","→`keym`, ";"→`comma`, ":"→`period`, "!"→`slash`. Defaults ajustés (rotate→`keym`, rateDown→`comma`, rateUp→`period`, rateReset→`slash`). Storage bump **v3**. (Les autres rangées étaient déjà correctes.)
- **Escape ferme l'éditeur** : `useEffect` keydown (capture) → `onClose()` sur `Escape`.
- **seek ±5 : icône = juste texte « −5 » / « +5 »** (plus de flèche circulaire).
- **Échange épisode ↔ frame** : les icônes cadre-photo + flèche vont sur `frameBackward/frameForward` (image préc./suiv.) ; `prevEpisode/nextEpisode` reprennent les chevrons |◄ / ►|.
- **Flèche du cadre frameBackward** décalée à droite (plus de superposition avec le bord).
- **Mute** : ✕ encore décalée à droite.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 8) — Raccourcis : FIX matching (event.code), rotate remplace mirror, seek ±5, nouvelles icônes

Retours user, dont un **bug fonctionnel majeur** :
- **« la plupart des boutons ne marchent pas » (chiffres rangée du haut, rateDown, …)** — CAUSE RACINE : le matching se faisait sur `event.key`. Sur **AZERTY**, la rangée des chiffres et une bonne part de la ponctuation (`; : ! ^ $ * ù`) n'émettent leur caractère qu'**avec Shift** ; une frappe simple donne `&é"'(-è_ç…`, donc le combo stocké (`"1"`, `";"`) ne matchait jamais. FIX : tout le système passe à **`event.code`** (position physique, indépendante du layout et de Shift). `comboFromEvent` = `e.code.toLowerCase()`. Les caps de l'éditeur portent maintenant leur `event.code` (`digit1`, `keyq`=cap "a", `semicolon`=cap "m", …) + un `label` d'affichage AZERTY. Defaults réécrits en codes. **Bump storage key → `aniscroll:keybindings:v2`** pour jeter les anciennes valeurs key-based.
- **`mirror` → `rotate` (rotation 90°)** : action, catalogue, handler (cycle 0/90/180/270 via `transform: rotate()`), i18n (fr/en), icône (SVG Material "rotate 90°" fourni). Plus d'action `mirror`.
- **seek ±10 → ±5** : `seekBackwardLong`/`seekForwardLong` passent à 5s ; icônes = flèche circulaire replay/forward avec un **« 5 »** au centre.
- **prevEpisode/nextEpisode** : nouvelle icône = cadre photo Material + montagnes, **flèche gauche (prev) / droite (next)**.
- **mute** : ✕ décalée plus à droite, détachée du haut-parleur.
- **rateUp** = miroir horizontal du cadran, badge `+` en haut-droite (inchangé depuis suite 7).
- Drag = clone de la vraie touche (suite 7) : devrait régler l'aperçu bizarre de l'espace ; à confirmer en interaction réelle.
- `tsc`/`lint`/JSON ok ; 37/37 defaults sur le board, aucun doublon.

---

## 2026-07-06 (suite 7) — Éditeur raccourcis : clavier ×1.5, icônes +, drag = vraie forme de touche, rateUp miroir

Retours user (SS) :
- **Clavier ×1.5 (pas 1.8)** : `max-w` `min(1400px,94vw)` → `min(1200px,92vw)`.
- **Icônes bien plus grandes** : `width/height` 17→26px.
- **Aperçu de drag = vraie forme/taille de la touche** : `onDragStart` clone maintenant `e.currentTarget` (l'élément touche réel) à sa `getBoundingClientRect()` et le passe à `setDragImage` — donc glisser la barre espace donne un ghost large, l'Enter ISO sa forme en L, etc. (avant : carré fixe 44px figé à l'ancienne taille). Retrait de l'`id="sc-icon-*"` et du ghost synthétique devenus inutiles.
- **rateUp = miroir horizontal (axe Y) de rateDown** : le cadran est mirroré (`translate(23,22.5) scale(-0.02,0.02)`) → aiguille sort à gauche ; le badge **+ reste en haut-droite** (non mirroré). rateDown inchangé (ouverture à droite + −).
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 6) — Éditeur raccourcis : gap uniforme px, clavier ×1.8, ghost de drag, Enter highlight opaque, icône vitesse pleine

Retours user (SS) :
- **Rendu bizarre au drag de l'espace** (aperçu étiré à la taille de la touche large) : `onDragStart` crée un **ghost custom** de taille fixe (44px) qui copie l'icône (via `id="sc-icon-<action>"` posé sur le `<svg>` de la touche) et le passe à `setDragImage`, puis le retire au tick suivant. Aperçu de drag identique quelle que soit la largeur de touche.
- **Rose du Enter bizarre au survol-drop** : le highlight `isDrop` passait par un rgba **0.35** → les 2 rects superposés de l'Enter ISO doublaient l'alpha (patch plus foncé au croisement). Passé en **couleur opaque** `#6f2338` → forme en L uniforme.
- **Espacement ×3 + gap uniforme** : le padding `%` n'était pas uniforme (grille 16×5 non carrée → colonnes très espacées, rangées serrées). Remplacé par un **inset px fixe** (`GAP_PX=6`) → gap identique sur les 4 côtés.
- **Clavier ×1.8** : `max-w` fixe → `min(1400px, 94vw)`.
- **Icône vitesse refaite** (aiguille non centrée / ouverture à gauche) : retour au **path Material "speed" complet** (cadran + aiguille centrée intégrée), scale 0.02, l'aiguille sort par l'**ouverture à droite** ; même cadran pour down/up, seul le badge −/+ change (coin haut-droite). Vérifié en zoom.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 5) — Éditeur raccourcis : espacement +, clavier +, badge vitesse en haut-droite

Retours user (SS) :
- **Espacement encore trop petit** : `GAP` inset 0.9→1.4.
- **Clavier un peu plus grand** : `max-w` 720→820px.
- **Badge −/+ des icônes vitesse illisible (superposé au cadran)** : cadran réduit (`scale(0.021)`) et décalé en bas-gauche (`translate(-1.5,25.5)`) pour libérer le coin haut-droite ; le badge y est placé, agrandi et arrondi (− = rect rx1, + = croix épaisse). Aiguille resserrée en conséquence. Vérifié en zoom : cadran + aiguille + badge distincts dès 18px.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 4) — Éditeur raccourcis : plus d'espacement, `- = ^ $ ù *` en clair, icônes vitesse "speedometer"

Retours user (2 SS) :
- **Touches encore trop serrées/collées** : `GAP` inset 0.45→0.9 (espacement franc entre touches, comme le 2e SS de réf).
- **`- = ^ $ ù *` ajoutés au groupe clair** : `isMain` = `[a-z0-9]` **plus** `MAIN_PUNCT` (Set `, ; : ! - = ^ $ ù *`) — passage regex→Set pour ne pas avoir à échapper `- $ ^ *`. Reste foncé : tab, entrée, espace, nav, modificateurs, capslock.
- **Icônes rateDown/rateUp refaites** d'après le SVG Material "speed" fourni : cadran (dial) commun + aiguille orientée (bas-gauche = ralentir, bas-droite = accélérer) + badge −/+. Le path Material est en viewBox `0 -960 960 960` → remis dans `0 0 24 24` via `<g transform="translate(0,24) scale(0.025)">` (piège : PAS de flip `-0.025`, sinon le cadran disparaît hors-cadre). Aiguille + badge dessinés directement en 24×24.
- `tsc`/`lint` ok ; vérif réplique (clavier + zoom des 2 icônes vitesse).

---

## 2026-07-06 (suite 3) — Éditeur raccourcis : clavier plus compact, teinte foncée constante, `,;:!` en clair

Retours user (screenshot) :
- **Clavier trop gros / touches collées** : `max-w` 860→720px et `GAP` inset 0.2→0.45 (touches à nouveau distinctes, board plus compact — sur le SS il débordait à ~1120px).
- **Teinte foncée indépendante de l'action** : le fond ne dépend plus de `action` — `isMain` (alphanumérique) → `#20242c`, tout le reste → `#181b21`, **avec ou sans action**. Une touche nav vide reste plus sombre qu'une touche lettre vide. La distinction assigné/vide se fait par la présence de l'icône, plus par la couleur.
- **`, ; : !` reclassés "main"** (couleur claire comme lettres/chiffres) : regex `isAlnum`→`isMain` = `[a-z0-9,;:!]`. (`^ $ ù *` restent dans le groupe foncé.)
- `tsc`/`lint` ok ; vérif réplique + screenshot.

---

## 2026-07-06 (suite 2) — Éditeur raccourcis : touches jointives, non-alphanum plus sombres, icônes OP/ED partagées

Retours user (screenshot) :
- **Espacement resserré** : `GAP` inset 0.55→0.2 (touches quasi jointives, comme la réf).
- **Touches non-lettres/chiffres plus sombres** : nouveau test `isAlnum` (`[a-z0-9ùç^$]`) — les touches alphanumériques gardent `#20242c` (assigné) / `#131519` (vide un peu foncé), tout le reste (nav, modificateurs, ponctuation, espace, entrée…) prend `#181b21` quand assigné, même vide sinon — lisible comme un vrai clavier où la zone de frappe se distingue du reste.
- **skipIntro/skipOutro réutilisent l'icône du menu Settings > Automation** (badge cadre arrondi + monogramme "OP"/"ED", `SettingsToggleRow` dans `UniversalPlayer.tsx`) au lieu d'un chevron générique — même glyphe aux deux endroits où l'action apparaît.
- `tsc`/`lint` propres ; vérif visuelle via réplique + screenshot headless.

---

## 2026-07-06 (suite) — Éditeur raccourcis : tout assignable, Enter ISO, fond flou, header minimal

Retours user (5 points) :
- **Toutes les touches assignables** (plus de touches « mortes » plus foncées) : les modificateurs ont maintenant un code = `event.code` minuscule (`shiftleft`, `shiftright`, `controlleft`, `metaleft`, `altleft`, `altright`, `capslock`, `contextmenu`) — ça distingue les 2 Shift (même `event.key`). `comboFromEvent` retourne désormais le code seul pour un modificateur pressé (sans se préfixer lui-même) ; le handler inline d'UniversalPlayer (qui ignorait les modificateurs et dupliquait la normalisation) est remplacé par `comboFromEvent` — source unique.
- **Enter en vraie forme ISO** : deux rects arrondis superposés (moitié haute pleine largeur 1.5u, moitié basse 1.25u alignée droite) — tous les coins convexes restent arrondis (un `clip-path` aurait donné des coins vifs). Capslock rétabli à 1.75u, ghost 1.25u. Icône centrée sur la moitié haute.
- **Toutes les actions assignées par défaut, aucune désassignation possible** : `skipIntro`=pageup, `skipOutro`=pagedown (37/37 liées, plus de `null`). Tray supprimée. `getKeybindings()` **purge les valeurs null/vides** du localStorage (anciennes versions permettaient l'unbind) pour que le défaut reprenne la main.
- **Header minimal juste au-dessus du clavier** : texte raccourcis à gauche, Réinitialiser + croix à droite. Hint bas + `keyboardHint` (locales) supprimés. Tooltip pill = absolute au-dessus du board (plus de rangée réservée).
- **Fond = flou** (`backdrop-filter: blur(20px)` + noir 45 %), plus de sheet noire ; **clavier réduit** (max-w 1040→860, icônes 19→17px, bezel p-3/r-18, touches r-8).
- `tsc`/`lint`/JSON ok ; réplique + screenshot headless conformes.

---

## 2026-07-06 — Éditeur raccourcis : clavier AZERTY 75 % (nav en ligne), fix icône espace

Retours SS (2e screenshot) : ordre de touches exact demandé, style laptop 75 %. Le commit `507b782` (fait entre deux sessions) avait déjà l'AZERTY mais avec un **pavé nav détaché** à droite (trou au milieu) — pas conforme à l'ordre donné. Corrections :
- **Layout 75 %** : les touches nav sont **en ligne** en bout de rangée — `delete` (fin R1), `home` (après Enter, R2), `pageup` (fin R3), `↑`+`pagedown` (fin R4), `←↓→` (fin R5). Plus de cluster `NAV` séparé ; chaque rangée totalise exactement **16 unités**.
- **Enter ISO sur 2 rangées** (w1.5, h2) ; capslock réduit à 1.5u pour que la moitié basse du Enter ne chevauche pas `*`. Nouvelle notion `ghost` dans `Key` = cellule sous le Enter, **non rendue** (sinon elle se dessinerait par-dessus).
- **Fix bug icône espace au drag** : icône SVG en taille fixe (19px) centrée en absolu — ne s'étire plus avec la touche large (déjà dans `507b782`, confirmé avec le nouveau layout).
- Coordonnées toujours **calculées** (walk gauche→droite par rangée) — zéro x manuel, zéro collision.
- Vérif : réplique HTML générée depuis les sources + screenshot Edge headless (rangées alignées, Enter tall OK, espace OK). `tsc`/`lint` propres ; les 35 defaults pointent tous vers des touches présentes.
- Piège local (nouvelle machine, chemin OneDrive) : Edge headless ne résout pas les chemins courts `LUC~1.DEL` en URL `file:///` — utiliser le chemin long complet.

---

## 2026-07-05 (suite 4) — Éditeur raccourcis : polish visuel SS + retrait 2 actions

Retours SS : le clavier ne collait toujours pas. Corrections :
- **Fond noir pur, zéro bordure** partout (bezel `#0b0c0f` arrondi 22px sur `#000`, touches `#20242c`/`#15171c` **sans bordure**). Couleurs alignées sur le SS.
- **Toutes les touches** animent au hover (rétract `scale(0.9)`), y compris les vides (avant : seules les assignées).
- **Plus de désassignation** : suppression du double-clic-pour-libérer et de la tray « drop to unbind ». Déposer une action sur une touche occupée **échange** les deux (aucune action perdue). Les actions hors board vivent dans une tray fine ; les y déposer évince le résident vers la tray.
- **Retrait de `cycleAspect` (ratio d'image) et `toggleTheater` (mode cinéma)** (demande user). L'event `aniscroll:toggleTheater` n'est plus émis.
- **Icônes refaites** (jugées moches/cassées) : `rateDown/Up` (triangle + badge −/+), `seekBackwardLong/Long` (double-chevron replay/forward-10, distinct des ±5s), `mirror` (2 triangles autour d'un axe), `skipIntro/Outro` nettoyés.
- Vérif visuelle : réplique HTML statique générée depuis les sources (ROWS/defaults/icons) + screenshot headless Edge (le dev server Next ne build pas en local — `@upstash/redis`/`ably` absents, cf. entrées précédentes ; ne PAS `npm install` ces paquets, ça prune des deps hors-lockfile). Rendu conforme au SS.
- Catalogue = **39 actions**. `tsc`/`lint`/JSON propres, defaults sans collision.

---

## 2026-07-05 (suite 3) — Éditeur raccourcis refait « keyboard-only » (design SS) + 4 actions

Retour user : le two-pane (liste à gauche + clavier) ne correspondait pas au SS. Il veut **QUE le clavier**, centré, sans encadré ni liste latérale ; **hover d'une touche = tooltip « Touche : Action »** + la touche **rétrécit** (anim `scale(0.9)`) ; **defaults = exactement ceux du SS** (mêmes icônes sur mêmes touches).

### Refonte [ShortcutEditor.tsx](components/watch/primary/ShortcutEditor.tsx)
- Plein écran, **clavier seul centré** (plus de carte/bordure autour, plus de colonne d'actions à gauche). Barre du haut = titre + Réinitialiser + fermer.
- **Tooltip flottant** au survol (pill noire au-dessus du clavier), **key retract** au hover.
- Drag & drop **touche → touche** pour déplacer une icône ; **double-clic** = libérer. Les actions **non placées** vivent dans une **tray fine sous le clavier** (se cache quand tout est placé ; déposer une icône dedans = retirer). C'est le seul « réservoir » pour rebinder une action absente du board, tout en gardant la vue principale = clavier pur.
- Defaults **calqués sur le SS** (icône par touche : ↺ en fin de row1, theater/subs/PiP/jump/link/loop en row2, brightness/flip/cast/fullscreen/frame-step en row3, screenshot/aspect/prev/next/mute/vol en row4, play sur Espace + rewind/vol/ffwd autour). `skipIntro/skipOutro` **non bindés par défaut** (le SS n'en a pas), draggables depuis la tray.

### 4 actions de plus (demande user)
- **Aller à % (1–9)** : 9 actions `seekPct10…90` → saute à N×10 % de la durée (façon YouTube). Number-row 1–9 par défaut. Icône = barre de progression + digit.
- **Miroir horizontal** (`mirror`) : toggle `transform: scaleX(-1)` sur le `<video>` (indépendant de `cycleAspect` qui, lui, joue sur `objectFit`).
- (rappel itération précédente : `cycleServer`, `copyTimestamp`.) Catalogue = **41 actions**.
- Vérifs : `tsc` propre (hors préexistants), `next lint` 0 warning, JSON valides, pas de collision de touche dans les defaults (script de check).

---

## 2026-07-05 (suite 2) — Raccourcis : éditeur drag&drop, fix décalage menu, 2 actions de plus

Itération sur la feature raccourcis (retours SS du user).

### Éditeur repensé en drag & drop ([ShortcutEditor.tsx](components/watch/primary/ShortcutEditor.tsx))
- Nouveau modèle (demande user, inspiré d'une réf de clavier) : **glisser une action** de la liste **sur une touche** pour l'assigner (avant : clic-action puis appuie-touche). Déposer sur la liste = désassigner ; **double-clic** sur une touche = libérer ; on peut aussi soulever l'icône d'une touche pour la déplacer.
- **Clavier épuré** : plus AUCUNE lettre imprimée sur les touches. Une touche assignée affiche l'icône de son action, sinon vide. Le **nom de la touche s'affiche seulement au survol** (tooltip). Style aligné sur la réf (bezel quasi-noir, touches plates).
- Defaults redistribués sur le clavier à la manière de la réf (icônes éparpillées) dans [keybindings.ts](lib/prefs/keybindings.ts).

### Fix décalage « Lumières d'ambiance » (et toutes les lignes injectées)
- Les rows `.as-menu-row` avaient `padding: 0 12px` alors que Vidstack natif utilise `--media-menu-item-padding: 10px` (vérifié dans `node_modules/@vidstack/.../menus.css` L315) → icône+label poussés ~2px trop à droite vs Speed/Qualité. Corrigé : `padding: var(--media-menu-item-padding, 10px)` dans [globals.css](styles/globals.css).

### Retrait du toggle « Statistiques vidéo » du menu (demande user)
- Plus de ligne stats dans le menu du lecteur ; l'overlay stats s'ouvre uniquement via son **raccourci clavier** (`toggleStats`). La ligne « Configurer les raccourcis » reste.

### 2 actions ajoutées (+ propositions)
- **`cycleServer`** (changer de lecteur) : le player n'a pas la liste des serveurs → il émet un CustomEvent `aniscroll:cycleServer` ; la watch page ([watch/[...info].js](pages/en/anime/watch/[...info].js)) écoute et avance vers le **prochain serveur confirmé** (fallback = liste complète), wrap-around, toast `player.switchedTo`. Même pattern que `toggleTheater`.
- **`copyTimestamp`** (copier le lien horodaté) : copie l'URL courante avec `?t=<sec>` + toast « à 12:34 ». Le player **honore `?t=` au chargement** (prioritaire sur le resume sauvegardé, consommé une fois puis retiré de l'URL via `replaceState`).
- Catalogue = **30 actions** désormais. i18n fr/en (`shortcuts.actions.cycleServer/copyTimestamp`, `stats.timestampCopied/Failed`, `player.switchedTo`).
- Vérifs : `tsc` propre (hors `ably`/`@upstash/redis` préexistants), `next lint` 0 warning, JSON valides.

---

## 2026-07-05 (suite) — Raccourcis clavier configurables + clavier visuel + stats vidéo

Demande user (screenshot d'un clavier physique avec icônes sur les touches) : assigner des touches aux actions du lecteur, même design que le SS, réglable dans le lecteur ET les settings globaux.

### Système de raccourcis (data-driven)
- [lib/prefs/keybindings.ts](lib/prefs/keybindings.ts) : catalogue de **28 actions** (`ShortcutAction`), map `action -> combo` en localStorage (`aniscroll:keybindings`), même pattern que `playerPrefs.ts` (CustomEvent + hook `useKeybindings`). Combos normalisés (`"shift+s"`, `"arrowright"`), helpers `comboFromEvent`/`comboLabel`/`comboToAction`. Defaults sensés (k=play, ←/→=±5s, ↑/↓=volume, m=mute, f=fullscreen, n/p=ep suiv/préc, s/d=skip intro/outro, etc.).
- **Handler central** dans [UniversalPlayer.tsx](components/watch/primary/UniversalPlayer.tsx) : un seul `keydown` en **capture phase** (gagne sur les hotkeys natifs Vidstack → `preventDefault`+`stopPropagation` quand on possède la touche). Ignore les champs de saisie + le blocage watch-party. Dispatcher `runAction(action)` → op impérative sur le `<video>`/player/hls.
- **Piège hooks** : le dispatcher a besoin de helpers définis tard (`subtitleTracks`, `selectSubtitleTrack`, `togglePip`…) donc `runAction` vit après les early-returns iframe. Mais `useRef`/`useEffect` ne peuvent PAS être après un early return (rules-of-hooks). Fix : ref `runActionRef` + `useEffect` déclarés **en haut** (avant tout return), le dispatcher est **publié** dans la ref plus bas (simple assignation, pas un hook). Sur le chemin iframe l'assignation ne s'exécute jamais → ref null → handler no-op (correct : pas de `<video>` à piloter).

### Clavier visuel (overlay) — [ShortcutEditor.tsx](components/watch/primary/ShortcutEditor.tsx)
- Reproduit le SS : bezel quasi-noir, touches sombres, **icône de l'action peinte sur la touche assignée**, tooltip flottant « S : Skip Intro ». Layout QWERTY en data (`ROWS`), touches mortes (Shift/Ctrl) non assignables.
- Modèle d'édition retenu (question au user) : **clic action → appuie une touche**. Liste d'actions groupée à gauche ; cliquer une action « écoute » puis capture la 1re touche (window keydown capture, ignore les modificateurs seuls, Esc annule). Une touche = une seule action (retire le combo des autres actions). Chip du combo + bouton clear + reset global.
- Chargé en **`next/dynamic` ssr:false** (overlay lourd, rare) depuis le lecteur ET les settings. Icônes SVG dans [shortcutIcons.tsx](components/watch/primary/shortcutIcons.tsx).

### Stats vidéo — [VideoStats.tsx](components/watch/primary/VideoStats.tsx)
- Panneau « stats for nerds » : lit le `<video>` + l'instance hls.js (résolution, FPS, bitrate, bande passante estimée, buffer, frames perdues, serveur). Poll ~2 Hz via rAF (pas de `useMediaState` → ne re-rend pas le player). Sibling overlay (survit au fullscreen).
- **Screenshot → presse-papiers** : `captureScreenshot()` dessine la frame sur un canvas → `ClipboardItem` (fallback download si pas de support clipboard-image ; toast d'erreur si canvas tainted = source noCors).

### Entrées + divers
- Bouton « Configurer les raccourcis » dans le menu Settings du lecteur **et** dans Settings globaux (section Lecteur) → même overlay. + ligne toggle « Stats vidéo » dans le menu lecteur.
- Ajout **`prevEpisodeHref`** (le lecteur n'avait que `nextEpisodeHref`) — dérivé de `episodeNavigation.prev` dans [watch/[...info].js](pages/en/anime/watch/[...info].js), passé aux 2 usages `UniversalPlayer` (HLS + iframe).
- Actions directes-only (seek/volume/screenshot/skip) = no-op gracieux sur embeds iframe (megaplay) : pas de `<video>` accessible.
- i18n fr+en (`shortcuts.*`, `stats.*`). Vérifs : `tsc` propre sur les fichiers touchés (seules erreurs = `ably`/`@upstash/redis` manquants, préexistantes), `next lint` 0 warning, JSON valides.

### Graphify (méta)
- Le user avait installé **Graphify** (graphe de connaissance du repo, `graphify query "..."`) pour réduire la conso de tokens. Je ne l'utilisais pas car le hook PreToolUse ne se déclenche que sur `Bash` grep/find, pas sur mes tools `Grep`/`Glob`. → **Mémoire durable ajoutée** ([[graphify]] dans MEMORY.md) : consulter `graphify query` en premier pour localiser du code. CLI v0.8.27, output `graphify-out/` (gitignored).

---

## 2026-07-05 — Onglet Découverte (feed swipe façon TikTok) + panneau « For You »

Documentation rétroactive de l'onglet **Découverte** (`nav.discover`, présent dans [NavBar.tsx](components/shared/NavBar.tsx) et [MobileNav.tsx](components/shared/MobileNav.tsx) → `/en/discover`), jamais journalisé jusqu'ici. Portage du projet de référence AniScroll (MAUI, `Index.razor` + `SwipeSettings.cs`) vers Next/React.

### Feed vertical plein écran ([discover.tsx](pages/en/discover.tsx))
- Cartes plein-viewport empilées, navigation **verticale** (molette/drag = épisode suivant/précédent, seuil `cardHeight * 0.06`) et **horizontale** (swipe = action de liste). Gesture unifiée dans [useCardDrag.ts](components/discover/useCardDrag.ts).
- **Perf** : `RENDER_WINDOW=5` (on ne rend que ±5 cartes autour de l'index), `ScrollCard` **memoïsé** (un re-render parent — ex. une traduction qui se résout — ne doit pas re-rendre toutes les cartes en plein swipe, ça faisait stuttrer). Hauteur de carte = `window.innerHeight` re-mesurée au resize.
- **Pagination** : fetch serveur via `/api/v2/discover/<page>` (Redis-cached côté serveur → les visiteurs concurrents partagent un seul appel AniList amont). Préchargement de la page suivante quand l'index arrive à `PRELOAD_THRESHOLD=6` de la fin ; dédup via `seenIds`.
- **Traductions** : `prefetchTranslations` réchauffe le cache de synopsis dans la langue active dès le chargement de la page → pas de flash anglais quand on swipe jusqu'à la carte (no-op si UI en anglais).

### Swipe = action de liste AniList ([swipeSettings.ts](lib/discover/swipeSettings.ts))
- Swipe **droite/gauche** assigne un **statut AniList** à l'anime actif (`SaveMediaListEntry`). Défauts : droite = `COMPLETED`, gauche = `PLANNING`. Réglable dans [ScrollerSettingsPanel.tsx](components/discover/ScrollerSettingsPanel.tsx) parmi 6 statuts (CURRENT/REPEATING/COMPLETED/PLANNING/PAUSED/DROPPED), persisté en `localStorage` (`discover_swipe_settings`).
- **Pas de custom lists** : le projet de réf avait un backend de listes maison ; ici on n'expose que le set de statuts AniList.
- **Hints de swipe** : pills icône+label aux bords de la carte active + « feathers » (dégradés construits inline depuis la couleur hex du statut, `featherGradient`). Couleurs statut = miroir des tokens `as-*` de `tailwind.config.js`. Glyphes SVG portés verbatim de `GetSwipeHintIcon`.
- **Undo** : chaque swipe est mémorisé (`swiped` map) ; revenir sur une carte déjà swipée affiche un **badge Undo** qui `DeleteMediaListEntry` (connecté) ou retire l'entrée locale (déconnecté). Déconnecté → les choix sont stockés dans `localStorage` (`discover_swipes`) pour ne pas être perdus.

### Boutons d'action sur la carte ([ScrollCard.tsx](components/discover/ScrollCard.tsx))
- Row **Info + Watch** en bas de la carte. Info → `/en/anime/<id>` ; Watch → deep-link direct dans le player megaplay (`.../watch/<id>/megaplay?...num=1`).
- Le clic sur le poster/titre honore la préférence « click target » (Settings → Browsing) : `info` (page info) ou `watch` (player direct) via `animeHref`.
- Badge épisodes : même logique que le Hero de la page info (`7/12` en cours, `1208+` si total inconnu, sinon total ou `N/A`).

### Panneau « For You » (recommandations) ([ForYouPanel.tsx](components/discover/ForYouPanel.tsx))
- Bouton **Sparkles** (haut-droite du feed) ouvre un overlay de recommandations personnalisées basées sur la **liste AniList** de l'utilisateur (`/api/v2/recommend`, moteur dans [lib/recommend/engine.ts](lib/recommend/engine.ts)).
- Deux modes : **all** / **planning**. Chaque carte affiche le **« pourquoi »** (raisons de la reco via `reasonsToProse`), tags, stats.
- **Regenerate/reroll** : `shownRef` traque tous les ids déjà montrés + `round` counter → chaque régénération demande 10 fresh jamais retournés. À la fin du batch → bouton Regenerate ; « start over » repart d'une ardoise propre. Nécessite d'être connecté (sinon `signin` hint).

### Leçons / pièges
- La memoïsation de `ScrollCard` est **essentielle**, pas cosmétique : sans elle, la résolution async d'une traduction re-rendait toutes les cartes et se battait avec les écritures DOM inline du hook de drag → swipe saccadé.
- Bien distinguer ces « openings/boutons Découverte » des **boutons OP/ED de la page info** (entrée 2026-07-02) : sujets sans rapport malgré le vocabulaire proche.

---

## 2026-07-03 (suite 2) — Section Épisodes : perf, badges, harmonisation ; rating décimal ; fixes saison

Série de fixes sur la page info (section Épisodes) + la popup de rating, guidée par screenshots du user.

### Perf : liste d'épisodes virtualisée (One Piece 1168 ep)
- **Symptôme** : revenir sur l'onglet ONE PIECE depuis Films / OP-ED laggait (montage de 1168 lignes DOM d'un coup).
- **Fix** : hook `useWindowedSlice` (dans [Episodes.tsx](components/anime/v2/Episodes.tsx)) — fenêtrage maison sans dépendance. Les 3 vues (détaillée/compacte/grille) ne rendent que les lignes visibles (~15) + overscan, avec un spacer de hauteur totale (scrollbar juste). Hauteurs de ligne fixes par vue (98 / 46 / pitch grille mesuré depuis la largeur du conteneur). Le `scrollTop` du conteneur partagé est remonté dans `Episodes` et passé aux vues. Validé en isolation (haut/milieu/bas/grille/petite-liste). Grille : `perRow` mesuré via `clientWidth`.

### Badge nombre d'épisodes sur l'onglet
- L'onglet « Épisodes » n'avait pas de badge (comme Personnages/Illustrations) car `info.episodes` est **null** pour les anime en cours (One Piece). Callback `onEpisodeCount` : `Episodes` remonte la vraie longueur chargée vers `Tabs`/`InfoPageMobile`. Fallback avant chargement : `info.episodes` → `nextAiringEpisode - 1` (diffusés). Bouton saison ONE PIECE : affiche juste le **nombre** (retrait de « EP » et « · Xmin »).

### Harmonisation des pills saison / Films / OP-ED
- **Problème** (screenshot) : chaque pill était dans son propre wrapper `seasonTabs` bordé (boîte-dans-boîte) + la pill saison était atténuée à `opacity 0.7` → les 3 semblaient dépareillées.
- **Fix** : wrapper `seasonTabs` rendu transparent (juste layout) ; les 3 partagent un style unique (fond accent + bordure accent si actif, `bg-3` + `line-2` sinon, hauteur 46px uniforme). Plus d'atténuation.

### Bug « Films » multi-saison + titre page-film
- **Films actif global** : `filmsActive = activeKind === "films"` allumait la ligne Films de **toutes** les saisons. Corrigé en **par-saison** : `films.some((v) => v.id === activeSeasonId)` (en mode films, `activeSeasonId` = premier film id de la saison choisie).
- **Titre pill sur page-film ré-ancrée** (Phantom Rouge) : affichait le titre du film au lieu de la série. Quand `active.id !== info.id` (cas `selfIsBonusFilm`), on affiche `pickTitle(active.title)` (la série, ex. « Hunter x Hunter (2011) »). `active.label` est toujours « Season N », donc il fallait le vrai titre depuis `SeasonEntry.title`.

### Rating décimal (demi-étoiles)
- La popup de fin d'anime ([RateModal.tsx](components/shared/RateModal.tsx)) n'avait que des étoiles entières (1-10) → impossible de mettre 8,5. Chaque étoile = **deux demi-zones cliquables** (gauche = X.5, droite = X.0) + overlay de demi-remplissage (clip width 50%). Score en POINT_10_DECIMAL, `score*10` reste entier pour AniList (multiples de 0.5). Ligne de score formatée selon la locale (`toLocaleString` → « 8,5/10 » en FR).

### Bug saison : film-préquelle compté comme saison (Jujutsu Kaisen 0)
- **Symptôme** (screenshot) : JJK 0 (id 131573, **MOVIE** 2021, PREQUEL de S1) apparaissait comme « Season 2 » dans le picker, coincé entre S1 (2020) et la vraie S2 (2023).
- **Cause** : `resolveFranchiseSeasons` ([resolveSeason.ts](lib/anilist/resolveSeason.ts)) comptait **tout** MOVIE non-exclu comme saison (ligne `isSeasonLike(m) || format==="MOVIE"`). `findBonusFilms` n'excluait que **SIDE_STORY**, pas les **PREQUEL** movies. Intention (commentaire) : seul un MOVIE **SEQUEL** (nouveau contenu, ex. Chainsaw Man: Reze-hen) = vraie saison.
- **Fix** : `findBonusFilms` capte aussi les **PREQUEL** MOVIE → JJK 0 est exclu du décompte saison (via `excludedFilmIds`) ET listé comme film bonus. `format === "MOVIE"` garantit qu'un PREQUEL vers une vraie saison TV n'est jamais capté. Caches bumpés `seasonList:v13→v14`, `bonusFilms:v7→v8`.
- **Vérifié live** : JJK → S1/S2/S3 seulement + JJK 0 en film bonus ; HxH Phantom Rouge / Last Mission toujours films bonus (pas de régression).

### Bug : film-recompilation classé « film » et non « compilation » (JJK: Execution)
- **Symptôme** : « JUJUTSU KAISEN: Execution » (re-montage de l'arc Shibuya S2 + début Culling Game S3, 2025) apparaissait comme film normal dans la section Films, pas en **Compilations**. Il est atteint via PREQUEL (depuis S3) donc `findBonusFilms` le prenait en `kind:"movie"`.
- **Fausse piste** : un edge **PARENT → TV** ne distingue pas — **tout** film de franchise en a un (Phantom Rouge a un PARENT vers la série HxH). L'utiliser reclassait à tort les vrais films en compilation.
- **Signal fiable = le titre** : ces recompilations portent le marqueur japonais « Tokubetsu Henshuu-ban » / « …Henshuu-ban » (特別編集版 = édition spécialement re-montée). Élargi `RECAP_TITLE_RE` ([helpers.ts](components/anime/v2/helpers.ts)) : `henshuu-?ban | soushuuhen | 特別編集版 | 編集版`. `resolveFranchiseBonusFilms` reclasse un film chargé en `kind:"compilation"` quand `isRecapTitle(film)` matche (le film est chargé pour l'enrichissement, on a donc son titre complet).
- **Vérifié live** : JJK Execution → compilation ; JJK 0 + HxH Phantom Rouge / Last Mission restent `movie`. Cache `bonusFilms:v8→v9`.

### Bug : popup de rating persistante entre animes
- **Symptôme** : ne pas remplir la popup de fin d'anime, quitter, ouvrir un AUTRE anime → la popup réapparaît avec le nouvel anime.
- **Cause** : `ratingModalState` vit dans `WatchPageProvider` (app-wide, survit à la nav SPA). `isOpen` restait `true` et se re-liait au `dataMedia` du nouvel anime.
- **Fix** : effet dans [watch/[...info].js](pages/en/anime/watch/[...info].js) qui remet `isOpen:false` au changement de `info?.id`.

### Cohérence liste locale / AniList (fixes connexes plus tôt dans la session)
- **Statut fantôme** : Hero montrait un statut local (« Re-visionnage ») absent d'AniList → `fullSyncFromAniList` devient **miroir strict** (drop des entrées local-only quand sync ON). Barre « vu » des épisodes ([episodeLists.tsx](components/watch/secondary/episodeLists.tsx)) : suit la source d'autorité (local si sync off, AniList si on) au lieu de lire `mediaListEntry` en dur.

---

## 2026-07-03 (suite) — Megaplay routé via Worker + synchro AniList ON par défaut avec choix de sens

Deux chantiers indépendants dans la même session.

### Fix : « Megaplay manque souvent alors que la vidéo existe »
- **Cause racine** : `extractMegaplay` ([lib/extractors.js](lib/extractors.js)) fetchait `megaplay.buzz` **en direct**. Or megaplay est **derrière Cloudflare** (vérifié : `Server: cloudflare`, `CF-RAY`), qui 403/challenge les **IP datacenter AWS de Vercel**. → marche en local (IP résidentielle) mais échoue souvent en prod → le chip disparaît. **Exactement la même classe de bug qu'anime-sama**, déjà réglée en passant par le Worker CF.
- **Fix** : helper `fetchMegaplay()` qui route la page embed **et** `getSources` via `fetchViaWorker` (requête depuis le réseau Cloudflare → passe), avec **fallback fetch direct** si le Worker est absent/injoignable (dev local). Le Worker met déjà le bon Referer `megaplay.buzz` ([worker/src/index.js](worker/src/index.js) `detectReferer`) et repasse le JSON verbatim — pas besoin de `X-Requested-With` ni de Referer par-requête (vérifié en live à travers le Worker).
- **Commentaires périmés corrigés** : (1) la route `/stream/ani/<aniListId>` n'est **pas** morte (répond en <0,5 s, vrai fallback — testé Frieren ani/154587) ; (2) la page ne **410 plus** sans Referer (renvoie 200). Le « file not found » de megaplay est un **200 avec `<title>Error - MegaPlay</title>`** → le check HTML existant le rattrape même à travers le Worker (le Worker ne wrappe pas ce cas en erreur).
- **Rien d'autre en cause** : routage MAL→AniList, regex `data-id`, `episode`/`aniId` par-entrée envoyés par le client = tous corrects. Aucun changement serveur/client nécessaire. **Le Worker doit être déployé** (il l'était déjà) pour que le fix prenne effet en prod.
- Vérifié end-to-end en forçant le chemin Worker : routes MAL + AniList résolvent (1 stream + 9 pistes de sous-titres), épisode inexistant → `file not found`, fallback direct OK.

### Feature : synchro AniList activée par défaut + choix de sens (au lieu du message d'écrasement)
- **Demande** : (1) sync ON par défaut quand l'utilisateur se connecte, (2) remplacer le message « votre liste va être écrasée » par un **choix de sens** — soit AniList écrase le local, soit **le local est poussé vers AniList** (ajoute les anime du site), (3) **toast** de confirmation à la connexion (style « Entrée de liste enregistrée »).
- **Nouveau sens `local → AniList`** : `fullSyncToAniList()` ([lib/list/syncEngine.ts](lib/list/syncEngine.ts)) pousse chaque entrée locale via `SaveMediaListEntry` (ajoute OU met à jour). **Ne supprime jamais** rien côté AniList (les entrées présentes seulement sur AniList sont laissées telles quelles) — c'est bien « ajouter ma liste du site », pas un remplacement. Séquentiel (1 mutation à la fois) pour rester sous la limite AniList (90 req/min), best-effort par entrée, patch du cache client au fil de l'eau.
- **Popup au 1er login** (choix retenu via question) : composant réutilisable [SyncDirectionModal](components/shared/SyncDirectionModal.tsx) à 2 boutons (« Utiliser ma liste AniList » = hard-override / « Utiliser ma liste AniScroll » = push). Piloté par `SyncBootstrap` dans [_app.tsx](pages/_app.tsx), **placé DANS `<SessionProvider>`** (sinon pas de `useSession()` — `MyApp` est au-dessus du provider).
- **Garde anti-nag** : nouveau flag `directionChosen` dans [syncPrefs.ts](lib/prefs/syncPrefs.ts). `enabled` passe à `true` par défaut (inoffensif pour les invités : `getAniListSession` renvoie `null` sans token). **Piège évité** : le resync de fond de `_app` (pull AniList→local, non-destructif mais overriding) est **gaté sur `directionChosen`** — sinon un nouvel utilisateur avec une liste locale la perdrait avant d'avoir pu choisir « pousser vers AniList ». `cancel` compte comme répondu (sync reste ON, aucun reconcile) pour ne pas rouvrir à chaque navigation.
- **Toast** : `toast.success` avec `description` (supporté par sonner 1.0.3) — titre « Synchronisation AniList activée » + sous-ligne. Même style que le screenshot fourni.
- **Settings** : le toggle master ouvre désormais le même `SyncDirectionModal` (au lieu du confirm à sens unique). Clés i18n `confirmTitle/Body/Enable` supprimées, ajout de `pushed/enabledToast/enabledToastDesc/directionTitle/directionBody/dir{From,To}{Title,Desc}` (fr + en).
- Vérifs : `tsc --noEmit` OK, `next lint` OK sur les fichiers touchés, JSON fr/en valides. Flux runtime non piloté (gated derrière l'auth AniList réelle) — logique/types/lint validés.

### Itération 2 — miroir strict, 3ᵉ option, popup = activation, déconnexion (retours user)
- **Bug du statut fantôme** (screenshots user) : le Hero affichait « Re-visionnage » (liste **locale**) alors que l'éditeur affichait « Pas dans la liste » (cache **AniList**). **Cause racine** : `fullSyncFromAniList` (resync de fond non-destructif) **conservait les entrées local-only** (absentes d'AniList) — une entrée `REPEATING` locale périmée survivait et contredisait AniList.
- **Fix « miroir strict »** (choix retenu via question) : quand sync est ON, AniList est **la seule source de vérité**. Les entrées local-only sont désormais **abandonnées** au resync (plus de carry-over lignes 155-158). La progression locale en avance reste défendue via `reconcileEntry` **mais uniquement** pour les anime présents aussi sur AniList (pas de « progression hors-ligne » pour un anime jamais sur AniList). L'entrée fantôme existante est purgée au prochain resync de fond. On **garde** le local comme cache résilient (offline) — il ne peut simplement plus contredire AniList.
- **3ᵉ option « Ne pas synchroniser »** : `SyncDirection` devient `"fromAniList" | "toAniList" | "off"`. Bouton dans le modal + gestion dans `_app` et `settings`.
- **Revirement : la popup EST l'activation** (avant : auto-`enabled:true` + toast dès la connexion, puis popup). Désormais le 1er login **ouvre la popup sans rien activer** ; choisir un sens active la sync (+ toast), « Ne pas synchroniser » la laisse off. → `DEFAULT_SYNC_PREFS.enabled` repasse à **`false`** (avant `true`) : plus aucune sync silencieuse pour un invité/indécis, et « off » devient un choix collant. Le `directionChosen` est ce qui gate le resync de fond (inchangé).
- **Déconnexion → sync OFF** : l'effet de `SyncBootstrap` détecte `!isConnected` et remet `enabled:false` **+ `directionChosen:false`** (reset) → une reconnexion re-pose la question. Écriture gardée (`if p.enabled || p.directionChosen`) pour ne pas spammer un `storage` event à chaque render, et no-op pour un invité pur.
- **Piège** : `SyncBootstrap` vit **dans** `<SessionProvider>` (déjà le cas) et l'effet ne dépend plus de `t` (retiré des deps une fois le toast déplacé hors de l'effet).
- Vérifs : `tsc --noEmit` OK, `next lint` OK, JSON valides.

---

## 2026-07-03 — Player : autoplay fiable (multi-lecteurs) + bouton play one-shot + icônes OP/ED + menu uniformisé

Session de debug guidée par les logs console du user (captures d'écran successives). Le fond `UniversalPlayer.tsx`.

### Autoplay — la bonne stratégie et les vrais pièges
- **Merge distant conflictuel** au départ : `origin/dev` avait déjà `e4f1025`/`138a59e` (autoplay unmuted-first + fallback muted + gros bouton play). Résolu en **gardant la stratégie distante** + y greffant le fix remount (résolution live de `playerEl`, jamais capturé une fois).
- **Ordre CRUCIAL = muted-first, PUIS unmute** (pas l'inverse). Le piège : sans user-activation, Chrome n'émet **pas** de `NotAllowedError` sur un unmuted-first — il **résout `play()` puis PAUSE** l'élément (message console *« Unmuting failed and the element was paused because the user didn't interact… »*). Donc le `catch(NotAllowedError)` ne fire jamais → on croit jouer alors que c'est en pause. → On joue **muté** (toujours accepté, jamais pausé), puis on tente `muted=false`, et si `video.paused` repasse à true (mitigation, **asynchrone** — vérifier après 2 `requestAnimationFrame`), on re-mute + relance + `unmutePending` (unmute au 1er geste).
- **Bug « change de lecteur → pas d'autoplay »** : l'effet marquait `started=true` dès `!video.paused`. Or un `play()` en vol sur un élément `readyState:0` reporte `paused=false` un instant → faux positif → l'`AbortError` (« play() interrupted by a new load », swap de source hls.js sur fallback Sibnet) n'était jamais rejoué. **Fix** : ne latch `started` que si `!paused && readyState>=2` (frame réelle). L'`AbortError` ne latch rien → le poll/events rejouent sur la nouvelle source.
- **Bug « activer l'autoplay en cours ne lance rien »** : la garde `currentTime>1 → return` bloquait une vidéo **en pause** que le user venait d'activer. **Fix** : la garde ne s'applique plus qu'à une vidéo **qui joue déjà** (`currentTime>1 && !video.paused`). Une vidéo en pause au-delà de 1s = demande de lancement légitime.
- **Poll auto-réparant** : un seul `setInterval` (100ms, plafond ~10s) qui, à chaque tick, (re)bind les events `canplay/loadeddata/loadstart` sur le **`<video>` courant** (pas le conteneur Vidstack, recréé au switch) et rappelle `tryPlay`. Guard `inFlight` pour ne pas chevaucher les `play()`. Court-circuit des sources **iframe/embed** (`streamData.iframe` sans clientExtract vidmoly) : pas de `<video>` à piloter, l'autoplay dépend du `allow` de l'iframe (megaplay marche seul).
- **Diagnostic** : `NEXT_PUBLIC_DEBUG_SOURCE=1` dans `.env.local` (gitignored) active `dwarn`. Pour du debug ponctuel j'ai utilisé des `console.log` inconditionnels colorés `[AP]` — **retirés avant push**. Les `dwarn` sont client-side (console navigateur), pas dans le log du dev server.
- **« Ne marche pas pour tous les lecteurs »** : diagnostic par logs = ce n'est PAS l'autoplay. vidmoly → `play() OK` avec son ✅. Certains (mewstream/sibnet) → **flux 403 / hlsError** = le CDN refuse le stream, pas de vidéo à lancer. **Chantier séparé** (extraction de source), hors autoplay.

### Bouton play central — one-shot
- Ne s'affiche QUE si **autoplay OFF** (`if (autoplay) return null`) — avec autoplay ON la vidéo part seule.
- **One-shot** : latch `everStarted` (via `useEffect` sur `!paused`) → une fois la lecture commencée, le gros bouton disparaît **définitivement** ; les pauses suivantes utilisent le petit play/pause en bas à gauche. (Avant : réapparaissait à chaque pause.)

### Icônes OP / ED (menu Automatisation)
- Les lignes « Passer l'intro/outro » partageaient l'icône `fast_forward`. Remplacées par des **badges OP / ED** (concept #3 choisi par le user via artifact de 5 propositions) : `<rect>` arrondi outline + `<text>` monogramme, `currentColor` (passe accent quand actif).
- `SettingsToggleRow` gagne une prop optionnelle **`iconNode`** (SVG multi-éléments) en plus de `iconPath` (single path). `iconNode` prime. **Labels inchangés** (demande explicite du user).

### Menu Settings — uniformisation + fix ambient
- **Lignes injectées trop petites/serrées** vs items natifs (Vitesse/Qualité) : le `style` inline ne reprenait pas la hauteur/padding/font-size natifs. **Fix CSS** : classe `.as-menu-row` (globals.css) pinnant `min-height: var(--media-menu-item-height,40px)`, `padding: 0 12px`, `font-size: var(--media-menu-font-size,15px)`, appliquée à `SettingsToggleRow`/`SettingsActionRow`/`SettingsSubmenuRow`/`SettingsSubmenuHeader`.
- **« Lumières d'ambiance » disparaissait en sous-menu Automatisation** : il n'était rendu que dans la branche `else` (menu principal), et le sous-panneau remplace toute la liste. **Fix** : « Lumières d'ambiance » désormais **épinglé en tête du sous-panneau** aussi (rendu dans la branche `automationOpen` avant le header retour).

---

## 2026-07-02 (suite 3) — Player : gros bouton play central + autoplay

- **Bouton play central** (`CenterPlayButton` dans `UniversalPlayer.tsx`) : visible quand
  `paused && canPlay`, sibling du `<MediaPlayer>` (comme `SkipOverlay`), z-index 15, container
  pointer-events-none / bouton pointer-events-auto. Clic = **démarre AVEC son** (unmute sauf mute
  intentionnel). Style : 56px, fond accent `#E94560` + glow (comme les boutons play de l'app) —
  1re version (80px, cercle noir translucide) jugée hors-style + trop grosse par le user.
- **Autoplay — itérations** :
  - v1 : `muted=true` puis `play()` → toujours OK mais « play et mute » (rejeté).
  - v2 : unmuted-first, **pas de fallback muted** → sur navigateur qui bloque, la vidéo **ne
    démarrait pas du tout** (rejeté : « ne lit pas la vidéo automatiquement »).
  - **v3 (retenu)** : unmuted-first → si `NotAllowedError`, **fallback MUTED** (toujours autorisé,
    la vidéo démarre) → **unmute au 1er geste** utilisateur (pointerdown/keydown/touchstart, capture
    +passive, ne perturbe pas le toggle Vidstack). Mute intentionnel respecté. Latch `started` pour
    ne pas relancer à chaque re-buffer.
- **Pourquoi pas l'attribut HTML `autoplay` ?** (question user) : même politique navigateur (bloqué
  ou muet sans geste/MEI, exactement comme `play()`), et il fire avant que hls.js n'ait attaché la
  source → déclenche la mitigation « Unmuting failed » de Chrome qui laisse le player en pause (déjà
  documenté ligne ~3199 : on ne passe PAS `autoplay` à Vidstack). L'approche JS fait strictement
  mieux (muted-fallback + unmute-au-geste, impossible avec l'attribut seul).

---

## 2026-07-02 (suite 2) — Polish Films/OP-ED : miniatures clip, Chronicle, retour saison, perf

Retours SS user (6 points). Tous vérifiés sur données AniList live avant/après.

### 1 — Bouton "OP / ED" → **"Opening / Ending"** (+ trads)
- `locales/{en,fr}.json` clé `anime.opEd` → "Opening / Ending", `defaultValue` maj dans `Episodes.tsx`.

### 2 — `FilmsPanel` : **Compilations AVANT Films**
- Ordre des sections inversé (le user veut les recaps d'abord). Un seul reorder JSX.

### 3 — One Piece : **retour saison cassé** depuis Films/OP-ED
- Bug : `SeasonPicker` n'ouvrait le dropdown QUE si `hasMany` et ne remettait jamais `panel="episodes"`.
  Mono-saison (One Piece, variantes supprimées v12) → `hasMany` faux → clic mort, coincé dans Films.
- Fix : nouvelle prop `onActivate` ; le clic sur la pilule fait `if (!highlight) onActivate()` (revient
  aux épisodes) **puis** ouvre le menu si `hasMany`. Curseur pointer quand `!highlight`.

### 4 — Miniatures OP/ED = **frame du clip lui-même** (plus le label sur l'image)
- `ThemeThumb` : la cover saison peint dessous (placeholder instantané), puis un `<video muted
  preload=metadata>` attaché **seulement à l'entrée dans le viewport** (IntersectionObserver,
  rootMargin 300px) et seeké ~⅓ pour éviter le noir → fond over via opacity. Fallback = cover si
  le clip ne charge pas. Badge OP/ED retiré de l'image → petit chip texte à côté du titre.
- Lazy = une longue liste (One Piece 70+ thèmes) ne fetch pas 70 métadonnées d'un coup.

### 5 — Perf OP/ED (« arrive après toute la page / charge pas parfois »)
- Cause : 2 appels AnimeThemes séquentiels (resolveSlug → fetchThemes) à chaque cold start sans CDN.
- Fix : **cache Turso** (réutilise `season_cache` via `seasonCacheGet/Set`, clé `themes:v1:…`) dans
  `pages/api/v2/themes/[id].ts`. Warm reads instantanés, plus de round-trip upstream. On ne cache
  PAS un échec upstream (récupère à la vue suivante) ; on cache une liste vide légitime.

### 6 — Page **Chronicle** (digest multi-saisons) : dropdown saisons + panneau Films
- Chronicle (119113) = MOVIE avec **4 edges PARENT** vers les saisons SnK, aucune chaîne
  PREQUEL/SEQUEL → le walk s'effondrait sur lui-même (pas de dropdown, doublon).
- Nouveau `franchiseAnchorId` : si le start est un MOVIE avec **≥2 PARENT** saisons de la même
  franchise → ré-ancre sur la saison la plus ancienne (16498). Utilisé par `resolveFranchiseSeasons`
  ET `resolveFranchiseBonusFilms`. Seuil ≥2 = cible les digests entiers, épargne les sequels-film
  (1 PARENT) et les recaps mono-saison (Roar of Awakening → S2 seule).
- `Episodes.tsx` : `selfIsBonusFilm` = info.id ∈ bonusFilms → `panel` démarre sur **"films"** (on
  atterrit sur le digest qu'on est venu voir, pas sa liste 1-épisode).
- Caches bumpés : `seasonList:v12→v13`, `bonusFilms:v6→v7`.
- Vérif live : anchor(119113)=16498 ; SnK seasons S1..S4 ; digests=[Chronicle]. ✓

### 7 — Retours suite (même session)
- **Pilule Chronicle affichait le titre du film** au lieu de "Season 1" : la source active
  restait `info.id` (119113, absent de la seasonList). Fix `Episodes.tsx` : `defaultEpisodeId` =
  `seasonList[0].id` quand `selfIsBonusFilm` → la pilule lit "Season 1" et les liens épisodes
  pointent une vraie saison. Suffixe durée `· {info.duration}min` masqué si `activeSeasonId !== info.id`
  (évitait "25 EP · 120min", la durée du film sur une saison TV).
- **Filtres manquants dans Films / Opening-Ending** : la barre recherche était gated
  `panel === "episodes"`. Sortie du gate → visible partout ; sub/dub + vues restent épisodes-only.
  Placeholder adapté par panneau. `FilmsPanel`/`OpEdPanel` prennent `filter` (match label/année ;
  song/artiste/slug) + état "aucun résultat". Filtre **remis à zéro au changement de panneau**.
- **Miniatures vidéo OP/ED peu fiables** ("marchent moins bien / se chargent pas") : le seek d'un
  frame dans des dizaines de webm (range requests) échouait souvent ET les chargements concurrents
  rendaient la lecture du clip elle-même instable. **Rollback → miniature = cover saison** (statique,
  fiable). Le chip OP/ED reste à côté du titre (pas sur l'image). Leçon : pas de still par thème sur
  l'API AnimeThemes ; le frame-vidéo comme vignette coûte trop cher en fiabilité.

### 8 — Vues (détaillé / compact / grille) pour Films & Opening-Ending
- Le sélecteur de vue était épisodes-only → sorti du gate (sub/dub reste épisodes-only). `view`
  passé à `FilmsPanel`/`OpEdPanel`. Tooltip grille générique (`gridView`) hors épisodes (« Grille de
  numéros » n'a de sens que pour les épisodes).
- `FilmsPanel` : `FilmRow` gagne `compact` (ligne dense num·titre·meta·chevron) ; nouveau `FilmTile`
  (grille de posters 2:3, tag RÉSUMÉ en overlay). Helpers `useFilmText`/`coverEl` partagés.
- `OpEdPanel` : `ThemeRow` gagne `compact` ; nouveau `ThemeTile` (grille 16:9 cover + chip + play
  overlay + song/artiste dessous). `chipStyle()` partagé.

---

## 2026-07-02 (suite) — Films/OP-ED en onglets (remplacent la liste) + section Compilations

Retours user sur l'itération précédente (2 demandes).

### 1 — Films & OP/ED : dropdowns → **boutons-onglets** qui remplacent la liste
- Décision (question au user) : cliquer bascule le **panneau principal** (à la place des
  épisodes), onglets **mutuellement exclusifs** (pas d'accordéon). La saison reste un dropdown.
- `Episodes.tsx` : nouvel état `panel: "episodes" | "films" | "oped"`. `SeasonPicker` gagne
  `highlight` (dim quand un onglet Films/OP-ED est actif) et remet `panel="episodes"` au pick.
  Nouveau `TabButton` (même pilule que la saison, toggle). Barre recherche/dub/vues cachée hors
  panneau épisodes.
- Supprimé : `FilmsPicker` (dead) + `OpEdPicker.tsx` (remplacé). Nouveaux panneaux inline :
  [FilmsPanel.tsx](components/anime/v2/FilmsPanel.tsx), [OpEdPanel.tsx](components/anime/v2/OpEdPanel.tsx)
  (hook `useOpEdThemes` extrait → le bouton affiche le compteur, le panneau rend sans refetch).
  Rendu **façon épisodes** (rows cover/titre/meta ; OP-ED groupé par saison, clic = modal clip NC).

### 2 — différencier vrais films vs **compilations d'arc** (section séparée)
- **Signal vérifié sur données brutes AniList** (One Piece id 21) : `SIDE_STORY`=vrai film
  standalone (15), `SUMMARY`/`COMPILATION`=recap d'un arc (2 : Alabasta 2007, Chopper 2008 —
  pile les 2 du SS user). C'est **le `relationType`** qui tranche, rien d'autre.
- `resolveSeason.ts` : `FilmVariant.kind` = `"movie" | "compilation"`. `findBonusFilms`→`movie`,
  `findMultiSeasonDigestFilms`→`compilation`, nouveau **`findCompilationFilms`** (tout recap
  MOVIE d'arc, dédup vs films déjà classés — attrape les recaps mono-arc que le digest multi-
  saison ratait). `resolveFranchiseBonusFilms` concatène + trie films avant compils.
- Cache **bumpé `bonusFilms:v3→v4`** (shape changée : `kind` + compils incluses) → évince l'ancien.
- UX : `FilmsPanel` rend 2 sections **Films** / **Compilations** (intitulé gardé, tag `RÉSUMÉ`).
  i18n en/fr (`anime.compilations`, `compilationsHint`, `compilationTag`).
- **Piège évité** : les 2 SUMMARY apparaissent AUSSI en dual-format de la saison (dropdown saison
  « Films ») ET dans Compilations — **volontaire** (mêmes films, 2 accès légitimes), pas un doublon-bug.
- Type-check + ESLint propres (hors Prisma préexistant). Mobile OK (composant `Episodes` partagé).

---

## 2026-07-02 — Dropdown OP/ED (clips AnimeThemes) + fix détecteur multi-lecteur [commit ceeffe5]

Deux chantiers **indépendants** demandés dans le même prompt.

### Partie 1 — nouveau dropdown OP/ED sur la page info (joue les clips NC AnimeThemes)
- Demande : à côté du dropdown Film, un 3e dropdown **au rendu identique** au dropdown Saison,
  mais listant openings/endings — compteur OP/ED + liste, **groupé PAR SAISON** (« Saison → OP/ED,
  Saison → OP/ED »). Clic = joue le clip.
- **Source tranchée (question au user)** : clip **NC AnimeThemes** (`v.animethemes.moe/*.webm`),
  PAS un saut intra-épisode via timecodes. C'est donc distinct du détecteur de skip (offline).
- [lib/animethemes/themes.ts](lib/animethemes/themes.ts) : client **runtime** (jumeau JS du
  client python offline `tools/opening-detector/oped/animethemes.py`). id→slug (`/resource`)→
  themes (`/anime/{slug}`), garde la meilleure vidéo par thème (NC puis résolution).
- [pages/api/v2/themes/[id].ts](pages/api/v2/themes/[id].ts) : `GET /api/v2/themes/{anilistId}?malId=` ,
  cache long (métadonnée statique), **fail-soft** (jamais de 500 sur la page info).
- [components/anime/v2/OpEdPicker.tsx](components/anime/v2/OpEdPicker.tsx) : le picker (chrome
  copié 1:1 sur `SeasonPicker` de `Episodes.tsx`) + modal `<video>` NC. Fetch des thèmes **par
  saison** (chaque `SeasonEntry` a `id`/`idMal`), s'auto-cache si loading ou 0 thème.
- Câblé dans [Episodes.tsx](components/anime/v2/Episodes.tsx) après saison+films → couvre
  **desktop ET mobile** (composant partagé, `InfoPageMobile` réutilise `Episodes`). i18n en/fr.
- **Vérifié live** : MAL 16498 → slug `shingeki_no_kyojin` → OP1/OP2/ED1/ED2 + vidéos NC 1080p.

### Partie 2 — détecteur de skip robuste aux durées vidéo différentes selon le lecteur
- Demande : « faire l'opération sur plusieurs lecteurs car en fonction du lecteur la durée
  vidéo n'est pas la même ». Tranché : **pipeline offline** `tools/opening-detector` (pas runtime).
- **Le cœur du problème** : même épisode, hosts différents = encodes différents = **durée totale
  différente** (cold-open trimmé, ad-cards, padding). Un timecode détecté sur host A est faux sur
  host B — **pire pour l'ED** qui est ancré depuis la fin (`-sseof`) : un delta de durée décale
  tout le start absolu.
- **Décision clé** : réconcilier l'ED sur **secondes-depuis-la-fin** (`duration - start`),
  quantité **indépendante de la durée**. L'OP se réconcilie sur le start absolu.
  [oped/multi_host.py](tools/opening-detector/oped/multi_host.py) : détecte par host (durée
  propre à chacun) puis consensus (médiane, drop outliers >±4s, pondéré par votes). Émet
  `from_end_start/end`, `canonical_duration`, `hosts_agree/total`, `spread`.
- `resolve_episodes_multi()` ([adapter_aniscroll.py](tools/opening-detector/oped/adapter_aniscroll.py))
  résout l'épisode sur CHAQUE host (sibnet,embed4me,lpayer,sendvid,uqload), groupé par ep.
- `batch_detect.py --multi-host` : branche **opt-in** (coûte N hosts/ep) émettant les champs robustes.
  `probe_multihost.py` + section README.
- **Testé unitairement (synthétique)** : 3 hosts 1420/1440/1435s → **ED from_end=90.0s spread=0.0**
  (immunité durée prouvée) ; OP outlier +40s **correctement rejeté** (agree=3/4).

### Piège / restant
- **Piège here-string PowerShell** : `@'…'@` a collé un `@` parasite sur le sujet du commit (2×) →
  amend via `git commit -F fichier` (heredoc bash) pour un sujet propre avant push.
- **TODO couplé** : l'importeur JSONL→DB doit **propager** `from_end_*`/`canonical_duration` en mode
  multi-host ; et `SkipOverlay` devra **re-dériver l'ED** depuis `from_end` vs la durée réelle du
  `<video>` actif (elle la connaît déjà) pour boucler la robustesse au runtime.
- Type-check + ESLint propres (hors erreurs Prisma préexistantes = `npx prisma generate`).

---

## 2026-07-01 (suite 2) — Diag résolution vidéo + fix panels fusionnés + films bonus SIDE_STORY

Question de départ : « faut-il une API anime-sama externe (type TMCooper/AnimeSamaApi) pour
fixer les mauvaises vidéos/saisons ? » → **Non.** On a déjà mieux (scraping via CF Worker,
extraction m3u8, `player_map` vérifié). Une API externe se prend un 403 Cloudflare et fait
perdre l'infra. Les erreurs sont dans le **mapping** (ID AniList → slug/saison/offset), pas
dans le scraping.

### Diagnostic (audit borné)
- `scripts/audit-players.mjs --min-popularity=20000 --rate=40` sur dev (2395 titres).
  **Le mapping marche bien** : ~1% de `wrong-season` réels sur animesama. Le gros des
  « flagged » = `missing-player` (absence, pas mauvais contenu) — **voiranime quasi mort**
  (~5-10% résolus), animesama VF a bcp de trous.
- **Piège** : `flagged=98%` trompeur ; c'est le breakdown par TYPE qui compte
  (`wrong-season` vs `missing-player`), pas le compteur brut.

### Fix 1 — panels fusionnés (Gintama & co) [commit 0074778]
- Cause : `resolveMergedOffset` ([pages/api/v2/source/index.js](pages/api/v2/source/index.js))
  n'offsettait QUE si `somme(prequels)+ownEps == panelLen` (panel se **terminant** à la saison).
  Les long-runners (Gintama 365ep = S1..S4 concaténés) ont un panel **plus long** → test échoue
  → S2 servait l'ep 1 de S1.
- Fix : ancrer sur `fullChain`, accepter que le panel **continue** au-delà de la saison tant que
  `fullChain+ownEps <= panelLen`. Gardes conservées (tokyo-ghoul-re reste refusé).
  **Ne corrige PAS DBZ Kai** (chaîne PREQUEL AniList cassée : seul prequel = SPECIAL 1ép) →
  override nécessaire.

### Fix 2 — films bonus SIDE_STORY vs saisons [commit fababa4]
- Cause : tout MOVIE de franchise comptait comme saison sauf compilation re-cut. Un film
  side-story (HxH: Phantom Rouge) passait en « Saison 2 ».
- **Signal directeur = `relationType`** : `SEQUEL`→vraie saison (Reze S2, inchangé) ·
  `SIDE_STORY`→film bonus (Phantom Rouge, exclu) · `COMPILATION/ALTERNATIVE/PARENT`→dual-format
  re-cut (Mugen Train, inchangé).
- `findBonusFilms()` collecte les SIDE_STORY→MOVIE ; ids exclus de `resolveFranchiseSeasons`
  **et** `numberByChronology` (badge « ·S2 » ne peut plus diverger). `resolveBonusFilms()`
  (cache Redis `bonusFilms:v1:`) → SSR → InfoPage/Mobile → Tabs → Episodes → nouveau
  **`FilmsPicker`** (2e dropdown, caché si pas de film bonus).
- **Piège évité** : Reze n'est JAMAIS SIDE_STORY (vérifié) → pas de faux-exclu. Pire cas
  résiduel = film-suite rare dans le dropdown Films au lieu d'une saison (dégradation douce).

### Restant
- DBZ Kai (chaîne cassée) → `season_override` manuel.
- Mauvais slugs (Tokyo Ghoul √A → tokyo-24-ku) → bug `findAnimeSamaSlug`.
- voiranime quasi mort → à creuser.

### Env / piège
- **Redis/Upstash injoignable en DNS localement** (`ENOTFOUND ...upstash.io`) → walk AniList
  non-caché → endpoint inspect **inutilisable en dev local** (timeout). Validé par simulation +
  push sur dev, pas end-to-end local.

---

## 2026-07-01 (suite) — Saisons : unification liste/label, franchise canonique, films numérotés, anime « sans saison »

Suite aux captures : 3 régressions post-livraison corrigées + gestion des animes sans vraie saison.

### Décisions
- **Cause racine** : deux constructions de franchise divergentes — le moteur `resolveSeason.ts`
  (`buildFranchise` + Fribb, alimentait `seasonInfo`/le label) et le walk legacy
  `resolveSeasonListUncached` (sans Fribb, alimentait le **sélecteur** et la **carte**). D'où
  label vs sélecteur incohérents. **Fix = unifier le sélecteur sur le moteur.**
- **Nouvelle fonction** `resolveFranchiseSeasons(startId)` ([lib/anilist/resolveSeason.ts](lib/anilist/resolveSeason.ts))
  produit la liste `SeasonEntry[]` canonique. `resolveSeasonList` la consomme (fallback legacy
  si exception). Bump `seasonList:v6→v7`.
- **Canonicité (P3, contenu manquant)** : `buildFranchise` **rebase sur la racine** (remonte tous
  les PREQUEL puis descend en SEQUEL). Résultat : la liste est identique quelle que soit la page.
  Vérifié : SNK depuis S1 (16498) et S3 (99147) → **même liste de 6 entrées**.
- **Restriction TMDB (P2, remakes)** : quand Fribb est cohérent, `buildFranchise` retire les
  nœuds du walk dont `tmdb.tv` diffère du start → un remake sort de la timeline de l'original.
  ⚠️ Fribb inactif en local (pas de Turso) — mais le **rebasage canonique corrige déjà** le cas
  transverse : page film Zeta 1967 montre désormais la vraie timeline UC (1979→1985→1986→…) SANS
  Origin 2019 (avant : [1979 S1, Origin 2019 S2], inversion). Fribb en prod affinera la séparation.
- **Films numérotés (P1)** : `findFilmVariants` (déplacé dans resolveSeason.ts pour éviter un cycle
  d'import) dédoublonne par id + numérote (`index` 1-based, trié par année) → « Film 1/2/3 ».
  Vérifié : Zeta a bien Film 1/2/3 (A New Translation I/II/III).
- **UX sous-section groupée** ([components/anime/v2/Episodes.tsx](components/anime/v2/Episodes.tsx))
  : une saison avec films rend un en-tête de saison non répété + sous-lignes indentées « Épisodes »
  / « Film N ». i18n `formatFilmNumbered` (« Film {{n}} »).
- **Anime « sans saison »** (Gundam Origin, films/OVA isolés) : détecté par `seasonList.length <= 1`.
  Label du sélecteur = **titre de l'anime** (pas « Season 1 » trompeur) ; badge « · S1 » du bouton
  REGARDER supprimé quand `seasonInfo.total <= 1` ([components/anime/v2/Hero.tsx](components/anime/v2/Hero.tsx)).

### Leçons / pièges
- **Ne PAS conclure trop vite d'une capture** : « Gundam cassé (S6) » = en réalité du **cache Redis
  prod obsolète**. Vérifié en local (sans cache) : Origin=1 entrée, 1979=S1→S2→S3, tous corrects.
  Le seul vrai bug était sur les pages transverses (film 1967). ⇒ purger `seasonChain:*`/`seasonList:*`
  en prod après déploiement.
- **Le garde-fou d'année seul ne suffit pas pour les remakes** : 1979→Origin(2019) en SEQUEL passe
  (une suite peut être plus récente). C'est la **canonicité + Fribb** qui règle ça, pas le seuil d'année.
- Cycle d'import évité : `findFilmVariants` vit dans resolveSeason.ts, seasonChain l'importe (pas l'inverse).
- **À déployer en prod** : purger le cache Redis saisons + peupler Fribb (`node scripts/refresh-fribb.mjs`
  avec Turso) pour activer la restriction TMDB fine.

## 2026-07-01 — Mapping des saisons : moteur multi-signaux + carte des relations + dual-format

Refonte de la numérotation des saisons pour corriger l'ordre faux (Gundam : le remake *The Origin* 2019 s'affichait comme S1 en chaînant l'original 1979 en S2 ; SNK S1 diffusait des épisodes de la S2), + ajout d'une carte des relations et du dual-format épisodes/film.

### Décisions
- **Aucune source n'est fiable seule** (mesuré sur les vraies données) : Fribb se trompe (Bungo Stray Dogs : `season.tmdb` = 1,1,2,3,3 → collisions, TMDB fusionne des saisons), AniList mislabellise les relations (le Gundam 1979 est tagué `SEQUEL` du remake 2019), les titres ne sont pas toujours numérotés. → **moteur multi-signaux arbitré par les DATES** ([lib/anilist/resolveSeason.ts](lib/anilist/resolveSeason.ts)) : cascade override manuel → Fribb validé → numéro du titre → compteur chronologique ; l'**année de diffusion est l'arbitre d'ordre** (un numéro final ne peut jamais violer l'ordre des années).
- **Garde-fous partagés** dans [lib/anilist/seasonDetection.ts](lib/anilist/seasonDetection.ts) (réexportés depuis [components/anime/v2/helpers.ts](components/anime/v2/helpers.ts) pour éviter un cycle d'import) : `edgeYearMonotonic` (rejette un `SEQUEL` vers une année antérieure / `PREQUEL` vers une année postérieure), `isChainableRelation` (ne chaîne QUE `PREQUEL`/`SEQUEL` — jamais `ALTERNATIVE`/`PARENT`, ce qui garde original et remake séparés : Gundam original vs Origin, HxH 1999 vs 2011 = deux « Saison 1 »), `isRecapTitle` (un recap ne compte jamais comme une saison).
- **Fribb = un signal validé, pas autoritaire** : [lib/fribb/fribbMap.ts](lib/fribb/fribbMap.ts) ingère `anime-list-mini.json` (5,8 Mo) dans la table `fribb_map` ; `isFribbGroupConsistent()` rejette un groupe avec collision de `season.tmdb`, fusion (moins de saisons TMDB que d'entrées AniList) ou `tmdb.tv` divergent. Refresh via [scripts/refresh-fribb.mjs](scripts/refresh-fribb.mjs) (ETag/304, hebdo). Table `season_override` = dernier mot manuel.
- **Streaming** : `detectSeasonNumber` ([pages/api/v2/source/index.js](pages/api/v2/source/index.js)) passe par le moteur → le sélecteur de panneau anime-sama utilise le même numéro que la fiche (corrige le mauvais épisode SNK). Offsets `computeSeasonSizes`/`resolveMergedOffset` durcis (exclusion des recaps, plage de tolérance élargie).
- **Carte des relations** : [components/anime/v2/RelationsGraph.tsx](components/anime/v2/RelationsGraph.tsx), overlay pannable/zoomable maison (pas de lib graphe), réutilise `relations`+`seasonList` (aucune requête en plus). Bouton sur la section Relations (desktop + mobile), i18n en/fr.
- **Dual-format** : `SeasonEntry.variants` apparie le film de compilation à sa saison via les relations AniList `COMPILATION`/`ALTERNATIVE`/`PARENT` de format MOVIE (pas via Fribb, dont l'appariement film↔saison n'est pas 1:1). Le sélecteur d'épisodes affiche « · Épisodes » + « · Film » ; choisir le film charge son id AniList MOVIE, déjà géré par le chemin `isMovie`/`filmSeason` existant.

### Leçons / pièges
- **`getServerSideProps` ne sérialise pas `undefined`** : `findFilmVariants()` renvoyait `undefined` quand pas de film → erreur 500 « Error serializing `.seasonList[0].variants` ». Corrigé en renvoyant `null` (et type `variants?: […] | null`).
- **Ne pas surinterpréter une capture d'écran** : le champ Fribb `season=12` de BSD n'était PAS un numéro de saison mais l'artefact d'une entrée sur une fiche TMDB divergente ; une capture TMDB (« 1 saison de 60 ép ») m'avait fait croire à tort à un regroupement total. Toujours vérifier les données brutes.
- **Invalidation `player_map`** : colonne `algo_version` + constante `SEASON_ALGO_VERSION=2` → les lignes `heuristic` héritées (calculées avec l'ancienne logique) sont ignorées à la lecture et recalculées. Migration défensive `ALTER TABLE ADD COLUMN` idempotente pour les DB existantes.
- **Cycle d'import évité** : `seasonDetection.ts` réexporte les garde-fous depuis `helpers.ts` (source pure), pas l'inverse.
- **Vérifié en dev** : Gundam 108039 → `{number:1,total:1}` (S1 autonome) ; Gundam 80 → S1 + suites 2/3 ; SNK 16498 → S1/total:4 ; HxH 136 → S1 autonome ; Demon Slayer 101922 → une saison porte `variants:[{id:112151,MOVIE,"…Mugen Train"}]`. Type-check propre (hors erreurs Prisma préexistantes = client non généré en local). `npm install` échoue sur le build natif `@tensorflow/tfjs-node` (outils C++ absents) → utiliser `npm install --ignore-scripts` en local.
- **Fribb pas actif sans Turso** : en local sans DB, le moteur retombe sur le garde-fou d'année du walker — ce qui suffit déjà à corriger Gundam. Pour activer Fribb en prod : lancer `node scripts/refresh-fribb.mjs` avec les variables Turso, puis le planifier.
