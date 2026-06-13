# DEVLOG

Journal des modifs de dev, pour garder le contexte entre les sessions (survit aux `/clear`).
Ordre anti-chronologique (le plus récent en haut). Une entrée = une session/sujet, avec **décisions** et **leçons/pièges**, pas juste les commits (git les a déjà).

> Convention : dates absolues. Branche de travail = `dev` (push auto, voir mémoire). Le Worker Cloudflare se déploie **à la main** (`cd worker && npx wrangler deploy`) — un `git push` ne le déploie pas.

---

## 2026-06-13 — Verrou réglages AniList hors-ligne + auto-skip/auto-next lecteur

### Contexte
Deux demandes : (1) rendre les réglages liés à AniList **non modifiables si non connecté** (ils ne font que pousser vers AniList) et renommer la section. (2) Ajouter au lecteur 3 toggles : **auto-skip intro**, **auto-skip outro**, **épisode suivant auto** — regroupés dans une nouvelle section des réglages (trop de toggles sinon).

### Décisions prises
1. **Réglages sync grisés pour les invités** (`settings.tsx`) : tous les toggles de la section sync passent `disabled={!isLoggedIn}` (master + autoProgress/autoWatching/autoPause + le champ `autoPauseDays` → `!isLoggedIn || !syncPrefs.autoPause`). Le composant `Toggle` gérait déjà le greyed-out. Le branchement guest dans `handleMasterToggle` (ligne ~202) devient mort mais reste inoffensif.
2. **Renommage section** : clé `settings.sync.title` → FR « Liste et Synchronisation AniList » / EN « List & AniList Sync ».
3. **Nouveau module `lib/prefs/playerPrefs.ts`** (copie exacte du pattern `syncPrefs` : 1 clé localStorage `aniscroll:playerPrefs`, CustomEvent, hook `usePlayerPrefs`) : `autoSkipIntro`/`autoSkipOutro`/`autoNextEpisode`, **tous OFF par défaut** (l'expérience par défaut reste manuelle, comme les boutons Skip/Next existants).
4. **Section « Lecteur vidéo »** dans `settings.tsx` (clés `settings.player.*`), placée entre Interface language et la section sync.
5. **Auto-skip dans `SkipOverlay.tsx`** : un `useEffect([active, prefs])` saute le segment (`skipTo(active.end)`) dès qu'il devient actif si le pref correspondant est ON.
6. **Auto-next** : `useEffect([currentTime, duration, …])` navigue via `goToNextEpisode()` dans la **dernière seconde** (pas via l'event `ended`, que certains serveurs avalent / rembobinent à 0), gardé par un ref `autoAdvancedRef` (1 seul tir/épisode, reset sur `nextEpisodeHref`).

### Leçons / pièges
- **Anti-re-skip après rewind** (exigence clé) : `autoSkippedRef = useRef<Set<string>>`. Chaque segment auto-sauté est enregistré par une clé stable `type:start-end`. Si l'utilisateur **revient en arrière** dans le segment, sa clé est déjà dans le Set → pas de re-skip (il veut clairement le regarder). Le Set est **réinitialisé par épisode** via `useEffect([skips])` (les `skips` changent à chaque nouvel épisode/serveur).
- Les effets auto sont placés **avant** le `if (!skips.length && !showNext) return null;` pour ne jamais être appelés conditionnellement (règle des hooks), et `skipTo`/`goToNextEpisode` sont définis plus haut dans le render scope → accessibles.
- Chaînage voulu : l'auto-skip outro atterrit ~1 s avant la fin, puis l'auto-next se déclenche → enchaînement fluide.
- Dépend des données **AniSkip** (comme les boutons manuels) : pas de timing = pas d'auto-skip sur l'épisode. Précisé dans la note de la section.

### État déployé / à faire
- Branche `dev` (commits `7d93044`, `1e6b1b9`). `tsc --noEmit` clean, JSON locales validés.
- ⏳ **À tester** : invité → toggles sync grisés/non cliquables ; activer auto-skip intro et revenir en arrière dans l'intro → ne re-saute pas ; auto-next en fin d'épisode.

---

## 2026-06-13 — Modèle « liste locale = miroir résilient » + resync AniList

### Contexte
Suite de la session sync. Nouveau modèle voulu par l'utilisateur : **la liste locale est TOUJOURS la copie affichée/résiliente**, AniList est la vérité quand la sync est active.

### Décisions prises
1. **Sync OFF** = liste locale autonome, rien n'est poussé sur AniList (édition manuelle incluse — voir commit `5f70c26` : `isLocal = !token || !syncEnabled` dans `listEditor`, et la page info lit le local quand sync off).
2. **Sync ON** : à l'**activation**, AniList **écrase intégralement** la liste locale (`importEntries(..., "replace")`) — derrière une **confirmation** explicite (modale dans `settings.tsx`, clé `settings.sync.confirm*`). Édition = **AniList d'abord, puis recopie en local** (le `listEditor` et `onEpisodeFinished` font `upsertLocalEntry` avec la réponse AniList autoritaire ; les suppressions font `removeLocalEntry`).
3. **Resync** : `fullSyncFromAniList()` (nouveau, dans `syncEngine.ts`) tente un pull AniList→local. Déclenché (a) au **chargement** dans `_app.tsx` (idle, avant l'auto-pause sweep) et (b) via un **bouton « Resynchroniser maintenant »** dans les Réglages.
4. **Résilience** : si le pull échoue (AniList down/offline), on **ne touche pas** au local (return `{ok:false}`), donc la liste reste utilisable ; au prochain pull réussi tout se recopie.

### Leçons / pièges
- `fullSyncFromAniList` lit la `MediaListCollection` du **viewer connecté** (token), pas le username public — inclut les entrées privées, et récupère title/cover/episodes pour le rendu offline de `/en/my-list`.
- Ordre dans `_app.tsx` : **resync PUIS auto-pause** (la sweep doit opérer sur le local fraîchement pull).
- `replace` à l'activation = les entrées locales absentes d'AniList sont perdues → c'est pour ça que l'avertissement insiste sur « exportez d'abord ».

### État déployé / à faire
- `tsc` + `next lint` clean. ⏳ Tester : activer sync (voir la modale + toast « N entrées synchronisées »), couper le réseau et recharger (local conservé, toast d'échec), bouton resync.

---

## 2026-06-13 — Sync AniList configurable + liste locale complète (sans login)

### Contexte
Le site était **AniList-account-only** pour les listes ; un visiteur non connecté n'avait que la progression de lecture par épisode (`lib/watch/progress.ts`). `useAnilist.markProgress` existait mais n'était **jamais branché** sur la fin d'épisode du player. Demande utilisateur : section de réglages sync AniList (toggle maître + 3 sous-toggles), MAJ auto épisode, auto-watching, auto-pause, et **liste locale complète** (statut/score/épisodes) avec import (MAL XML / pseudo AniList / JSON) + export, utilisable sans compte.

### Décisions prises
1. **Liste locale = localStorage seul** (`lib/list/localList.ts`), clé `aniscroll:localList`, même pattern que `titlePref` (event + hook `useLocalList`). Identité = AniList id pour pousser tel quel vers AniList.
2. **Une seule logique, deux cibles** (`lib/list/syncEngine.ts`) : `onEpisodeFinished` met **toujours** à jour le local ; si master `enabled` + session AniList → pousse aussi (mutations plain dans `lib/list/anilistPush.ts`, hors React car appelé depuis un event handler). Auto-pause = `runAutoPauseSweep` lancé en `requestIdleCallback` dans `_app.tsx`, délai configurable (défaut 30 j), **ne bump pas `updatedAt`** en pausant (sinon re-actif aussitôt).
3. **Réglages** (`lib/prefs/syncPrefs.ts`) : `enabled` (master, défaut OFF/opt-in) + `autoProgress`/`autoWatching`/`autoPause`/`autoPauseDays`. Section ajoutée dans `pages/en/settings.tsx` (composant `Toggle` inline).
4. **Player → page** : `UniversalPlayer` reçoit `onEpisodeComplete` (via un ref pour éviter le re-bind), appelé dans `onEnded` **à côté** de `markComplete` (jamais à la place). La page watch (`[...info].js`) fournit `info` (total/title/cover) au syncEngine.
5. **Éditeur de liste sans login** : `components/listEditor.tsx` détecte l'absence de `session.user.token` (`isLocal`) → seed/save/remove via `localList` au lieu d'AniList ; bouton favori caché (AniList-only). Sur la page info (`[...id].tsx`) l'éditeur s'ouvre désormais pour **tout le monde** (l'ancienne modale « login pour éditer » a été retirée). Fallback de statut local pour les guests via un effect qui écoute `LOCAL_LIST_EVENT`.
6. **Nouvelle page `pages/en/my-list.tsx`** (client-only, `useLocalList`) plutôt que de toucher au SSR de `profile/[user].tsx`. NavBar : lien « My List » → `/en/my-list` pour les guests, `/en/profile/<name>` pour les connectés.
7. **Import/export** (`lib/list/importExport.ts`) : export JSON ; import JSON maison, pseudo AniList public (même requête `MediaListCollection`), et **MAL XML** (parse DOMParser + gunzip optionnel via `DecompressionStream`, mapping MAL→AniList par batches de 25 via `Media(idMal:)` aliasé, throttle 750 ms — quota AniList).

### Leçons / pièges
- `useSession()` est typé sans `user.token` (token AniList custom) → convention du repo = `const { data: session }: any = useSession();`. Sinon TS2339.
- Le player **re-bind** son listener `ended` par épisode/serveur → garde anti-doublon (`recentlyFinished` clé `aniId:episode`, fenêtre 60 s) dans le syncEngine, et `onEpisodeComplete` passé par **ref** pour ne pas re-bind à chaque render du parent.
- Auto-pause : surtout **ne pas** rafraîchir `updatedAt` en pausant (passer l'ancien), sinon l'entrée redevient « active ».
- Tout le local est client-only (`typeof window` partout) — pas de mismatch SSR.

### État déployé / à faire
- Branche `dev`. `tsc --noEmit` clean, `next lint` sur les fichiers touchés clean (2 warnings pré-existants non liés : custom-font sur id.tsx, aria sur UniversalPlayer:901).
- ⏳ **À tester manuellement** (voir plan) : finir un ep non connecté → apparaît CURRENT dans `/en/my-list` ; connecté + sync ON → poussé sur anilist.co ; import MAL XML / pseudo AniList ; auto-pause en forçant un `updatedAt` ancien.
- Le push AniList réutilise une mutation `SaveMediaListEntry` allégée (pas de customLists/notes) — volontaire pour l'automatisation ; l'éditeur garde la mutation complète.

---

## 2026-06-13 — Lecteur : VidNest, fix Megaplay, warm-up du Worker

### Contexte
Parti de « ajouter le lecteur VidNest (vidnest.fun) », fini sur un fix Megaplay + une optimisation du cache Worker. Plusieurs allers-retours parce que mes mesures locales étaient trompeuses (voir Leçons).

### Décisions prises
1. **VidNest ajouté puis RETIRÉ.** VidNest est un agrégateur qui sert la **même source MegaCloud** (`cdn.mewstream.buzz`) que Megaplay : sur 12 titres testés, 9 renvoyaient le **m3u8 identique**. Quelques cas marginaux où VidNest avait plus de sous-titres (Dandadan : 43 vs 5) n'ont pas justifié un 2ᵉ chip qui sert le même flux. → retiré (extracteur + serveur + dispatch + preconnects).
2. **Megaplay corrigé** : il expose `/stream/mal/<malId>/` **et** `/stream/ani/<anilistId>/` (les deux vérifiés live). On essaie MAL d'abord, **fallback AniList** — ça récupère les titres sans MAL id mappé. Avant, un MAL id manquant → « no MAL id » et échec.
3. **Worker : pré-chauffe des playlists** (pas des segments). À chaque résolution m3u8, le Worker fait un `ctx.waitUntil` (non bloquant) qui fetch les playlists enfants (master → variantes, petits fichiers texte) pour les mettre dans `caches.default` sous la **même clé** que la requête du player. Supprime le pic de résolution du manifest sans concurrencer les segments.

### Leçons / pièges (IMPORTANT pour les futures sessions)
- ⚠️ **Mesurer la latence CDN depuis la machine locale MENT.** Le **même segment** a donné **73 000 ms en direct CDN vs 836 ms via le Worker prod**. La connexion locale (FR) → CDN `mewstream` est lente/erratique (0,3 s à 70+ s). **Seul juge fiable = le Worker déployé / le navigateur sur dev.aniscroll.com.** Ne pas conclure « c'est lent » sur des chiffres `localhost → Worker → CDN`.
- ⚠️ **1re version du warm = régression.** Elle warmait 2 niveaux (master → variante → **segments**), soit ~12 fetch multi-MB en parallèle → saturait l'I/O du Worker et **étranglait** la vraie requête du player sur les titres froids. Corrigé : **playlists only, depth 1, séquentiel**. Si on retouche le warm, ne JAMAIS warmer les segments binaires.
- Le **cache edge existait déjà** (`caches.default` côté Worker + `Cache-Control: s-maxage=86400, immutable`). 1er viewer paie le CDN, suivants → HIT ~300 ms. Vérifié `cf-cache-status: HIT`, `age` qui monte.
- Megaplay/VidNest tapent le même écosystème CDN : `cdn.mewstream.buzz`, `s1.streamzone1.site`, `s2.cinewave2.site`, sous-titres sur `*.lostproject.club`. **Tous exigent `Referer: https://megaplay.buzz/`** (vérifié : les autres referers → 403). C'est passé via `streams[].referer` → proxy `&referer=`.
- VidNest (si jamais on le réintègre) : API `https://new.vidnest.fun/hianime/anime/{anilistId}/{ep}/{sub|dub}` et `/anitaku/{id}/{ep}/{sub|dub}/hd-2`. Réponse `{encrypted, data}` où `data` = **Base64 à alphabet permuté** (`RB0fpH8ZEy…+/=`) → UTF-8 → JSON. Pas du vrai chiffrement. (Code retiré, mais l'algo est ici si besoin.)
- **Bug console bénin** : `AbortError: play() interrupted by pause()` au changement de serveur (course Vidstack/hls.js). Pas lié à la lenteur, pas corrigé.

### État déployé / à faire
- Branche `dev` : commits `0e559f8` (hover Watch&More) → `c293a70` (warm playlists).
- **Worker prod déployé** = version `d0548957` (warm playlists only). Code commité = `c293a70`, cohérent avec le déployé.
- ⏳ **À valider par l'utilisateur sur dev.aniscroll.com** (pas en local) : fluidité JJK + un titre moins populaire (Steins;Gate). Si encore lent EN PROD → c'est le CDN source sur ce titre, seule vraie option = changer de serveur/source pour ces titres (aucun cache ne sauve un CDN à 24 s/segment au 1er hit).

### Aussi fait cette session (sans rapport)
- **Anim hover « Watch & More »** restaurée sur la page info (desktop) : classe `.siteBtn` dans `components/anime/v2/styles.module.css` (translateX au hover + scale à l'active), portée depuis le `.platform-row` du projet de référence. Les styles inline ne permettant pas `:hover`. Commit `0e559f8`.

---

<!-- Modèle pour une nouvelle entrée :

## YYYY-MM-DD — Titre court

### Contexte
### Décisions prises
### Leçons / pièges
### État déployé / à faire
-->
