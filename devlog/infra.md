# DEVLOG — Infra, cout, cache & releases

Ce que le site coute et comment il tient : cache Upstash/CDN, Fluid CPU,
crons de rafraichissement, usage-monitor, analytics, et les releases
`dev` -> `main`.

Le plus recent en premier. L'index general est dans `../DEVLOG.md`.

## 2026-08-22 — Relevé usage : le seul trou de cache restant, et pourquoi le monitor ne verra jamais Vercel

**Ce que le monitor dit.** Upstash n'est plus le sujet : 4 412 cmd le 21/08,
moyenne 7 jours 7 445, **projection 45 % du cap** gratuit — contre 146 % le
04/08. En revanche `DBSIZE` monte de ~500 clés/jour (14 251, dont `anime:v5`
= 82 %), donc le SCAN du census coûtera de plus en plus cher à terme.

**Le côté Vercel du monitor est aveugle, et c'est définitif.** Sorti le token du
CLI (`%APPDATA%/xdg.data/com.vercel.cli/auth.json`) pour interroger
`api.vercel.com/v1/usage` : `plan_upgrade_required` — **Pro/Enterprise
uniquement**. Il n'existe aucun chemin programmatique vers les
invocations ou le Fluid CPU en Hobby. Le screenshot du dashboard reste
obligatoire ; inutile de re-chercher une API.

**Ce qui marche, avec son piège.** `vercel logs --json` : rétention **1 h**
(`--since 24h` renvoie exactement les mêmes lignes). Sur l'heure sondée : 8
invocations, 100 % `/en/anime/[id]`, 8 ids distincts, toutes `MISS`. **Ne pas en
conclure que le cache edge est cassé** : une invocation *est* par définition un
MISS, un HIT n'atteint jamais la fonction et n'apparaît donc pas dans ces logs.
Mesuré au curl à la place — deuxième appel = `HIT` sur les trois ids testés, le
cache marche. Le vrai constat est ailleurs : **11 592 anime en cache pour ~8
vues/h**, chaque vue tombe sur un id neuf. Monter le TTL au-delà des 6 h
actuelles n'achètera rien, et l'ISR non plus. Le levier est de rendre le MISS
moins cher, pas d'espérer plus de HIT.

**Le seul trou de cache du site.** Sondé les en-têtes de dix routes `/api/v2` en
prod : `characters`, `themes`, `changelog`, `episode-scores`, `relations`,
`discover`, `catalog`, `etc/recent` repassent toutes en `HIT` au deuxième appel.
**`/api/v2/media/[id]` est la seule à rester `MISS`** — elle fusionnait le
`mediaListEntry` du visiteur connecté dans ses ~30 ko de métadonnées, ce qui
rendait toute la réponse personnelle et donc `private, no-store`. Découpée : le
champ par utilisateur part dans `GET /api/v2/list-entry/[id]` (~100 octets,
`private, no-store`), la moitié lourde devient identique pour tout le monde et
part au CDN (s-maxage 30 min + 24 h de SWR, la fenêtre du SSR de la page watch).
Même décision que celle déjà prise pour le cœur et la progression sur la page
anime. Les 404 se cachent 60 s au passage.

**Une vague série en moins sur la page anime.** `resolveHeroBanner` s'attendait
seul entre deux `Promise.all` dans le SSR : il ne dépend que de `tmdb.backdrop`,
déjà résolu à ce stade, et son verdict `bannerSize` est une lecture Turso — ça
faisait une troisième vague série sur chaque MISS de la page la plus visitée. Il
rejoint le lot des saisons. Sa position tenait à l'idée d'émettre son header de
preload « en avance », mais `getServerSideProps` ne flush pas les headers avant
la réponse : les deux partaient ensemble de toute façon.

**Fausse piste, notée pour ne pas y retomber.** `/api/v2/seasons/[id]` répondait
404 avec 13,8 ko de corps et `max-age=0, must-revalidate` — pas un bug : la
route n'est pas sur `main`, prod renvoyait simplement sa page 404. **Tout
sondage de prod mesure `main`**, qui accusait 161 commits de retard sur `dev` ce
jour-là. Vérifier `git ls-tree origin/main <chemin>` avant de qualifier une
anomalie prod.

**Reste ouvert.** `/en/schedule` sert **419 ko de HTML** (contre 180 ko pour
l'accueil, 105 ko pour une fiche anime) — poste de Fast Origin Transfer à
élaguer. Et le collecteur n'échantillonne `vercel logs` qu'une fois par jour à
7 h UTC, heure creuse : avec 1 h de rétention, il faudrait plusieurs tirages
pour un mix de routes crédible.

## 2026-08-16 — Le cron ne rattrapait rien, et une panne AniList l'aurait prouvé trop tard

**La question posée** : si AniList tombe plusieurs jours, a-t-on un repli pour ne
rien perdre ? **Réponse** : rien de stocké ne peut être perdu (que des upsert,
et le SSR sert la base quand AniList ne répond pas), mais il n'y avait aucun
rattrapage — et il manquait déjà des choses **sans panne**.

**Le delta sweep n'a jamais rien remonté.** Son repère était
`MAX(anilist_updated_at)` sur toute la table. Or cette colonne est repoussée par
le Job 1, qui tourne *avant* et réécrit les animes qu'AniList édite le plus, et
par chaque visiteur du site via `upsertAnime`. Le repère lisait donc toujours
« il y a quelques minutes » au lieu de « où le dernier balayage s'est arrêté ».
Sur tous les runs du 08 au 16/08, sans exception : `page 1: 0/50 newer than
baseline`. Et sous une panne de trois jours, c'était exactement la perte que le
job était censé éviter : à la reprise, le Job 1 remonte le repère à maintenant
et la fenêtre est sautée pour de bon.

**Un vrai curseur ne l'aurait pas sauvé**, et c'est ce qui a changé la
correction prévue. Sondé le 16/08 : les pages 4 à 20 de `UPDATED_AT_DESC`
portent **la même seconde** (15:07:57) — des centaines de médias touchés par un
lot côté AniList — et 55 ids sur 345 reviennent en double sur huit pages, ce que
fait une pagination instable sur des clés de tri ex æquo. Ce qu'elle fait aux
entrées qu'elle saute à la place, on ne le voit pas. Le flux est donc du bruit
majoritaire, une journée n'entre pas dans le plafond de 100 pages de l'API, et
sa complétude n'est de toute façon pas garantie.

**Ce qui remplace** : un balayage par TTL (`expires_at < now`, les plus consultés
d'abord, budget en lignes **et** en minutes). Il n'a pas de curseur du tout — la
file de travail *est* l'état de la table — donc un run manqué, échoué ou coupé
en plein milieu laisse les lignes non traitées exactement où elles étaient. Une
panne coûte de la fraîcheur, elle ne peut plus coûter de la donnée.

**Ce qui manquait, mesuré** : 8 965 lignes hors TTL sur 22 592, dont 7 353
jamais re-fetchées depuis plus de 90 jours ; 718 des 737 `NOT_YET_RELEASED`
périmées ; et **24 animes encore « à paraître » dont la date de sortie était
passée**, jusqu'à trois mois (206819 *Kimi to Hanabi to Yakusoku to*, dû le
17/07). Cause : le Job 1 ne prenait que `RELEASING`, or c'est lui qui décide qui
est re-fetché — un anime pas encore sorti le jour de son ingestion ne pouvait
donc jamais entrer dans la liste. Le Job 1 prend maintenant les deux statuts
(+15 requêtes, 30 s). Après passage : 700 à paraître, 0 périmé, 0 date passée.

**Deux autres pièges de la même famille** :

- l'échec était **vert**. Chaque job était dans un `try/catch` et le process
  sortait en 0 : trois jours de panne AniList auraient affiché trois coches
  vertes. Le script sort maintenant en 1 et émet `::error::` ;
- `refresh-fanarts` avançait son curseur **même quand l'amont avait échoué** :
  si `/latest` levait, il traitait 0 id et écrivait quand même
  `last_check = now`. `/latest?date=` est une *fenêtre*, pas une file : une
  panne fanart.tv creusait un trou définitif. Le curseur ne bouge plus que si
  les deux appels ont réussi ; les ré-ingestions sont `INSERT OR IGNORE`, donc
  repasser sur le même terrain est gratuit.

**Attention au déploiement** : les workflows planifiés ne tournent que depuis la
branche par défaut. Tant que ceci n'est pas sur `main`, le cron continue de
tourner avec l'ancien script. Voir [[prod-is-main-not-dev]].


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
