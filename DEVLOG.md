# DEVLOG

Journal des modifs de dev, pour garder le contexte entre les sessions (survit aux `/clear`).
Ordre anti-chronologique (le plus récent en haut). Une entrée = une session/sujet, avec **décisions** et **leçons/pièges**, pas juste les commits (git les a déjà).

> Convention : dates absolues. Branche de travail = `dev` (push auto, voir mémoire). Le Worker Cloudflare se déploie **à la main** (`cd worker && npx wrangler deploy`) — un `git push` ne le déploie pas.

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
