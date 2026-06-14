# DEVLOG

Journal des modifs de dev, pour garder le contexte entre les sessions (survit aux `/clear`).
Ordre anti-chronologique (le plus récent en haut). Une entrée = une session/sujet, avec **décisions** et **leçons/pièges**, pas juste les commits (git les a déjà).

> Convention : dates absolues. Branche de travail = `dev` (push auto, voir mémoire). Le Worker Cloudflare se déploie **à la main** (`cd worker && npx wrangler deploy`) — un `git push` ne le déploie pas.

---

## 2026-06-14 (suite 3) — Refonte settings (rail fixe), suppression liste, toggles notifs, override liste à la connexion, Sync Threshold, fix popup rating, Browsing (watch/info + hide spoilers)

### Contexte
Gros lot de réglages + refonte de la page settings. Demandes successives dans une même session.

### Décisions prises
1. **Suppression de la liste locale** : déplacée de la page My List **vers les Paramètres** (section « Ma liste »), bouton rouge + **modale de confirmation** (même style que la confirm sync), appelle `clearLocalList()` existant. Pas de bouton sur My List.
2. **Notifications de suites = COMPLETED uniquement** : c'était **déjà le cas** (`computeNotifications.ts` filtre `status === "COMPLETED"`). Aucun changement. L'utilisateur a confirmé « statut COMPLETED suffit » (pas besoin de progress = total).
3. **Override de la liste locale à la connexion** : `fullSyncFromAniList({ replace })`. `replace:true` = **hard override** (jette tout le local, écrit AniList verbatim) utilisé quand on **active** le toggle sync (`enableSync`). `replace:false` (défaut) = réconciliation non-destructive (resync de fond dans `_app.tsx` + bouton « Resync now »). Déclencheur = activation du toggle, **pas** la simple connexion (choix user « seulement si sync activé »). `signOut` ne touche jamais `aniscroll:localList`.
4. **Refonte UI settings** : rail latéral gauche **`position: fixed`** pleine hauteur (style doc Jikan), scroll-spy `IntersectionObserver` + smooth-scroll au clic. Itérations de style : pas de fond/bordure (discret), positionné `top-44` près du contenu centré (offset calculé `calc((100vw-48rem)/2 - …)`), texte actif en **rose** (`text-action`, sans ring/bg), label « Liste et Synchronisation AniList » en entier (rail élargi 260px + wrap). **Séparateurs entre les SECTIONS de contenu** (`divide-y` sur le wrapper, `py-10` par section), pas dans le rail. Titre centré, `pt-28`.
5. **Toggles de notifications** : nouveau `lib/prefs/notifPrefs.ts` (newEpisode / nextSeason / resume, défaut on). `computeNotifications` gate chaque type sur son toggle (et évite les fetch réseau quand off) ; `useNotifications` recalcule sur `NOTIF_PREFS_EVENT`. Section « Notifications » (icône cloche).
6. **Sync Threshold** : `syncPrefs.syncThreshold` (0–100%, défaut 80%, clampé). Slider compact à droite dans la section sync, placé juste sous « Mettre à jour la progression » (définit *quand* la progression compte). Dans `UniversalPlayer`, `onTimeUpdate` déclenche `onEpisodeComplete` (progress +1 / push AniList) dès que `currentTime/duration >= threshold`, **une seule fois** par montage (flag `completeFired` partagé avec `onEnded`).
7. **Fix popup de rating trop tôt** (`SkipOverlay.tsx`) : passage d'un seuil **%** (88%/95%) à un **temps restant fixe** : ~90s (séries) / ~45s (films/OVA), avec plancher 85% pour les clips très courts. Uniforme quel que soit le runtime (15min / 24min / film 2h).
8. **Toggles sync utilisables hors connexion** : auto-progress / auto-watching / auto-pause + délai ne sont **plus grisés** quand déconnecté (ils agissent sur la liste LOCALE ; seul le PUSH AniList est gated). Seul le master toggle « Activer la sync AniList » reste `disabled={!isLoggedIn}`.
9. **Section Browsing** (du tableau de réglages fourni) :
   - **Watch or Info Page** : `lib/prefs/clickTarget.ts` (`info` défaut | `watch`), helper `animeHref(id, target)`. `watch` → URL megaplay ep1 (`/en/anime/watch/{id}/megaplay?id=megaplay-{id}-1&num=1`). Branché partout où une card mène à un anime : `AnimeCard` (orphelin, inutilisé en fait), home `content.tsx`, trending/popular/recent, **page schedule** (`pages/en/schedule/index.tsx`, PAS le widget `components/home/schedule.js`), Related/Recommendations (page info), my-list + **QueueSection**, profil, search/saison. Liens manga inchangés.
   - **Hide Spoilers** : `lib/prefs/spoilerPrefs.ts`. Floute vignettes + remplace titres/descriptions d'épisodes par « Episode N ». Câblé dans les `viewMode/*` ET surtout **`components/anime/v2/Episodes.tsx`** (le vrai rendu de la page info : detailed/compact/grid) + `episodeLists.tsx` (lecteur).

### Suivi (mêmes session) — extension du click-target + hook DEVLOG
- **Watch/Info étendu** à tous les points d'entrée restants : page schedule (`pages/en/schedule/index.tsx`), barre de recherche / palette (`components/searchPalette.tsx`, `handleChange`), **notifications** (`NotificationBell.tsx` — toutes les notifs suivent la pref via `animeHref`), QueueSection. `animeHref(id)` sans 2ᵉ arg lit `getClickTarget()` à l'appel → OK dans les handlers d'événement (pas besoin du hook).
- **Hook DEVLOG** ajouté dans `.claude/settings.json` (event `Stop`, commande `echo` d'un `systemMessage`) : rappel automatique en fin de tour de mettre à jour le DEVLOG. Indépendant de la mémoire → survit au `/clear`. Mémoire [[devlog-pointer]] durcie en plus (avertissement « miss récurrent » en tête).

### Suivi — Default Provider (serveur par défaut)
- **Le « serveur préféré » existait déjà** : la page watch lit/écrit `localStorage["preferred_server"]` (clic serveur dans le player → mémorisé, réappliqué au montage si l'anime l'offre, sinon repli sur un serveur confirmé). Choix : **exposer ce réglage existant** plutôt que d'inventer un nouveau système (et **pas** de réglage langue séparé — chaque id de serveur encode déjà sa langue : `animesama-sibnet` = VF, `animesama-sibnet-vo` = VOSTFR).
- `lib/prefs/serverPref.ts` enveloppe la **même clé** `preferred_server` (vide = Auto/megaplay). Select « Serveur par défaut » dans la section Lecteur (Auto + liste depuis `lib/servers.js`, label langue VF/VOSTFR/Multi). Aucun changement côté player nécessaire.

### Suivi — paire 4/4 du tableau (lecteur + maintenance) + fix select
- **Select serveur illisible** : `<select>` natif → dropdown au thème OS (fond blanc, options grisées). Fix : `bg-secondary text-white` + `[color-scheme:dark]` sur le select ET `bg-secondary text-white` sur chaque `<option>`.
- **Force Maximum Quality** (`playerPrefs.forceMaxQuality`) : dans `onProviderSetup`, si on, on épingle `hls.currentLevel = levels.length-1` (fixer un index désactive l'ABR auto), re-appliqué sur `hlsManifestParsed`/`hlsLevelsUpdated` (events castés `any` — types littéraux non exportés).
- **Default Muted** (`playerPrefs.defaultMuted`) : dans le bloc `apply()` du restore volume/muted, force `player.muted = true` au start (jamais d'auto-unmute). Distinct de `aniscroll:muted` (souvenir d'un mute intentionnel).
- **Clear Watch History** : `clearAllProgress()` dans `lib/watch/progress.ts` → `removeItem("aniscroll:progress")`. Local only (l'historique serveur/Prisma des connectés n'est pas touché — la demande disait « locally »).
- **Restore Default Settings** : `lib/prefs/resetSettings.ts` balaie toutes les clés `aniscroll:*` + clés legacy (`preferred_server`, `view`, `artplayer_settings`, volume/muted). **Garde `aniscroll:localList`** (KEEP set) — réinitialiser les réglages ne doit PAS effacer la liste (le bouton dédié « Supprimer la liste » possède cette action). Reload après pour refléter.
- Nouvelle section **Avancé** (icône clé) avec les deux actions, chacune derrière une modale de confirmation (même style que la confirm sync/clear-list).

### Suivi — fix clear-history (mauvaise clé) + fusion de sections
- **Clear history n'effaçait rien** : l'historique « recently-watched » est stocké dans **`artplayer_settings`** (localStorage anonyme + miroir local) et en Prisma pour les connectés — PAS dans `aniscroll:progress` (qui ne contient que les positions de reprise). `clearAllProgress` vide maintenant **les deux** clés. Reste local (l'historique serveur des connectés revient au prochain fetch — conforme à « locally »).
- **Trop de sections → fusion** : (1) « Langue des titres » + « Langue de l'interface » → une seule section **`#language`** (icône `LanguageIcon` gardée, deux sous-blocs). (2) « Économie de données » repliée dans la carte **Lecteur** (c'est un toggle de bande passante/GPU de lecture). 11 → 9 sections. Icônes `GlobeAltIcon`/`BoltIcon` retirées des imports.

### Suivi — fix badge notif qui réapparaît + highlight dernière section
- **Badge de notif réapparaît au changement d'onglet** : le hook `useNotifications` **prunait** les `readIds` qui ne correspondaient plus à une notif live. Mais un `refresh()` au retour d'onglet rappelle AniList ; sur un échec réseau transitoire `computeNotifications` renvoie une liste **partielle** (la notif `resume` locale reste, donc liste non vide → la garde `length===0` ne suffit pas) → les ids new-episode/next-season lues sont prunées → au fetch suivant réussi elles reviennent **non-lues** → badge. Fix : **supprimer le pruning par liveness**, juste **plafonner** le set (`MAX_READ_IDS = 200`, FIFO) dans `markAllRead`. Une id lue n'est plus jamais oubliée à cause d'un fetch raté.
- **Scroll-spy dernière section** : la dernière section (courte, en bas) n'atteint jamais la zone active IO (`-20%/-70%`) → jamais surlignée. Ajout d'une garde `scroll` « bas de page » qui force la dernière section active.

### Suivi — changelog v0.0.3
- Écrit le changelog **v0.0.3** (« Paramètres repensés & nouveaux réglages », daté 2026-06-14) à partir de tout le DEVLOG de cette session, dans les **4 fichiers** `changelog/{full,popup}.{fr,en}.md`, en suivant le format v0.0.2 (full = sections Ajouté/Modifié/Corrigé orientées utilisateur ; popup = 3 lignes emoji). La popup se ré-affiche automatiquement (trigger = hash du contenu, pas la version) ; aucune version figée ailleurs (les endpoints lisent les .md).

### Suivi — lien « watch » reprend à l'épisode en cours
- `animeHref(id, "watch")` visait toujours `megaplay ep1`. Désormais il lit la **progression locale** (`peekLocalEntry(id).progress`) et vise `progress + 1` (borné au `total` connu ; anime terminé → ep1 = rewatch ; pas de progression → ep1). Centralisé dans `lib/prefs/clickTarget.ts`, donc TOUS les points d'entrée watch en profitent (reco accueil, cartes, recherche, notifs). Provider reste megaplay (URL générique qui marche pour n'importe quel épisode). Note SSR : `peekLocalEntry` renvoie vide côté serveur → lien initial = ep1, corrigé après hydratation (re-render via `useClickTarget`) ; pour searchPalette/NotificationBell c'est calculé au clic donc toujours correct.

### Leçons / pièges
- **Pruning d'état « lu » dangereux quand la source est réseau** : ne jamais invalider un état persistant (read-ids) en se basant sur un recompute qui peut échouer/être partiel. Plafonner la taille plutôt que pruner par « plus présent ».
- **Historique de visionnage = `artplayer_settings`** (pas `aniscroll:progress`) : la page recently-watched lit cette clé (+ Prisma pour les connectés). Ne pas confondre avec les positions de reprise.
- **Pas de dossier `pages/fr/`** : `/fr/...` et `/en/...` rendent les **mêmes fichiers** `pages/en/*` (rewrite i18n). Un bug « sur /fr » se corrige dans le fichier `/en` correspondant.
- **`<select>` natif sombre** : forcer `[color-scheme:dark]` + bg/texte sur le select ET les options, sinon le dropdown hérite du thème clair de l'OS (illisible).
- **Le serveur encode la langue** (suffixe `-vo`) — il n'y a pas d'état « dub » persistant indépendant (`dub` vient de la query string). Un « provider préféré » suffit à fixer la langue ; pas besoin d'un réglage Sub/Dub séparé.
- **Barre de recherche = `components/searchPalette.tsx`** (Ctrl+K), distincte de la page `pages/en/search/[...param].tsx`. Le clic sur un résultat passe par `handleChange(id)` → `router.push`, pas un `<Link>`.
- **Deux composants « schedule »** : `components/home/schedule.js` = widget d'accueil ; `pages/en/schedule/index.tsx` = la page `/schedule`. Modifier le bon.
- **Page info = `Episodes.tsx` v2**, pas les `viewMode/*` (ceux-ci servent ailleurs). Toujours vérifier quel composant rend réellement avant de câbler une pref.
- `fullSyncFromAniList` était **non-destructif par design** (garde progress local en avance + entrées local-only) ; l'override « vrai » nécessitait un flag explicite, ne pas confondre avec le resync.
- `AnimeCard.tsx` est un composant **orphelin** (grep : utilisé nulle part) — les cards réelles sont dans `content.tsx` etc.

---

## 2026-06-14 (suite 2) — OG net (2×) + cache-bust, z-index bannière profil, « locked » → « indisponible »

### Décisions prises
1. **OG net** : `@vercel/og` rendait à 1200×630, downscalé par Discord/X sur écrans hi-DPI → perçu flou. Maintenant rendu à **2×** (2400×1260, toutes les dimensions doublées dans le JSX). La balise meta reste un ratio 1.9:1, les consommateurs downscalent un asset net.
2. **Discord cachait l'ancienne image** (« ANISCROLL » majuscule) car il indexe l'OG par URL. Ajout d'un param **cache-buster** `v=3` dans l'URL OG (`pages/en/anime/[...id].tsx`) → nouvelle URL → refetch. À ré-incrémenter à chaque refonte de la carte.
3. **Bannière profil par-dessus le contenu** : `next/image fill` est `position:absolute` et repeignait par-dessus le contenu remonté en marge négative. Fix : bannière `relative z-0`, bloc avatar/nom `relative z-10`.
4. **« Locked » → « indisponible »** : les épisodes pas encore sortis étaient libellés « Verrouillé » + cadenas, ce qui suggère un blocage d'accès. Changé le texte (`anime.locked` = « Indisponible » / « Not available », + nouvelle clé `anime.notReleased`) et l'icône cadenas → **horloge** dans `Episodes.tsx` (détaillé + compact). La variable `locked` (logique) reste, seul le libellé/visuel change.

---

## 2026-06-14 (suite) — Thème sur toute la page info, profil = my-list + bannière, OG « AniScroll » + moins flou

### Contexte
Retours sur les correctifs précédents : (1) la page info ignorait encore le thème à plein d'endroits (barre d'onglets/compteurs, tags, bouton play des recommandations, épisode « à suivre », panneau saisons, texte perso PRINCIPAL, bouton file d'attente), (2) la page profil devait être **identique à `/my-list`** (juste bannière + avatar en haut, sans description), (3) l'embed OG : remplacer « ANISCROLL » par « AniScroll » et réduire le flou.

### Décisions prises
1. **Cause racine du thème sur la page info** : `components/anime/v2/styles.module.css` définissait ses PROPRES tokens `--accent: #ff3b5c` / `--accent-2` / `--accent-soft` en dur, indépendants de `--brand-primary`. Toute la page V2 (`.root`) lit ces tokens. Fix : les 3 pointent maintenant sur `var(--brand-primary)` (+ `color-mix` pour soft/2). **Un seul changement reskinne onglets, tags, saisons, recommandations, perso, etc.** Restait quelques hex en dur hors tokens, corrigés : `Tabs` (compteur actif), `CharactersTab` (MAIN), `Episodes` (bordures/fond « à suivre » → `color-mix(var(--accent))`), `Overview` (tagFill gradient, official link, popularity, toggle spoilers, bigPlay), `QueueButton` (état actif). La palette catégorielle de `Related` (relations) est laissée telle quelle (légende, pas chrome de marque).
2. **Profil = my-list** : `pages/en/profile/[user].tsx` réécrit pour reproduire la mise en page de `/my-list` (chips de filtre par statut + sections groupées avec lignes arrondies `bg-white/[0.03] ring-1`). Données : on **aplatit** `MediaListCollection.lists[].entries` puis on re-groupe par `entry.status` dans l'ordre canonique (`STATUS_ORDER`) avec dé-dup par mediaId (les custom lists répètent des entrées). **Header en plus** : bannière utilisateur (`fill`, gradient vers `primary`) + avatar arrondi qui chevauche + nom + ligne de stats (anime · ep · jours). **Pas de description** (about AniList). Garde-fou privé + `getServerSideProps` inchangés. Supprimé : table HTML, toggle custom-list, `UnixTimeConverter`, sidebar 30/70.
3. **OG** : « ANISCROLL » → « AniScroll » (casse + `letterSpacing` réduit), blur de fond 18→12px. Le « flou » perçu vient surtout du downscale de Discord (l'image 1200×630 est nette en plein écran) — rien à corriger côté image elle-même.

### Leçons / pièges
- Un module CSS scopé qui **redéfinit** des tokens d'accent en dur shunte tout le système de thème global pour son sous-arbre. Toujours faire pointer les tokens locaux sur `--brand-primary` plutôt que de recopier l'hex.
- `color-mix(in srgb, var(--accent) X%, transparent)` est le remplacement direct d'un `rgba(hex, a)` quand la couleur devient une variable — supporté partout (navigateurs 2023+).

---

## 2026-06-14 — Thème live partout, fix /schedule, carte de partage en embed OG, historique refait, suppression « Surprends-moi »

### Contexte
Retours utilisateur post-lot : (1) la couleur de thème ne s'appliquait pas partout (badge tendance, ombre bouton watch, page info, barre de préchargement du player), (2) `/fr/schedule` affichait page blanche, (3) remplacer le bouton « partager une carte » par un **lien dont l'embed (OG) EST la carte** (avec cover à gauche), (4) historique de visionnage trop basique, (5) retirer « Surprends-moi » + code.

### Décisions prises
1. **Thème live** :
   - Home hero (`pages/en/index.tsx`) : `bg-[#E94560]` codé en dur → tokens Tailwind `action` (badge tendance bg/bordure, ombre+hover du bouton watch, bordure hover des vignettes). `action` lit `var(--brand-primary)`.
   - Page info (`Hero.tsx`) : bouton watch (gradient + glow) et chips genres passés en `color-mix(in srgb, var(--brand-primary) …)`. Cœur favori laissé rouge (sémantique « favori », pas accent).
   - **Barre de préchargement du player** : la cause était que `applyAccent()` ne posait QUE `--brand-primary`. Vidstack lit `--brand-glow` pour la piste *buffered*. Fix dans `lib/prefs/accentColor.ts` : `applyAccent` pose maintenant aussi `--brand-glow` (`${hex}59` ≈ 35% alpha) et `--brand-secondary`. Ordre garanti dans `_app.tsx` (asCssVars défaut PUIS applyAccent override).
2. **`/schedule` blanc — vraie cause** : sur échec transitoire AniList (429/timeout), la 1ʳᵉ page renvoie `null` → boucle cassée → `scheduleByDay = {}` → **et ce `{}` était caché dans Redis jusqu'à minuit Japon**. Chaque visite suivante lisait le cache vide. Fix `pages/en/schedule/index.tsx` : (a) ne cacher QUE si non-vide, (b) traiter un cache vide comme un miss (re-fetch), (c) `safeParse`, (d) rendu durci contre `media`/`coverImage`/`type` null.
3. **Carte de partage → embed OG** :
   - `pages/api/og.tsx` (Edge `@vercel/og`) réécrit : carte 1200×630 avec **cover à gauche**, banner flouté en fond, titre/méta/genres/score à droite, couleur d'accent en param. Params : `title, cover, banner, score, year, format, episodes, genres, accent` (alias `image` conservé pour rétro-compat).
   - `pages/en/anime/[...id].tsx` : OG meta complets (`og:image/title/url/type` + `twitter:image`) pointant la route avec tous les params. **URL absolue** dérivée des headers SSR (`x-forwarded-proto/host`) → `baseUrl` en prop, ajouté aux DEUX returns de `getServerSideProps` (+ `initialUA` qui manquait au 2ᵉ). Les unfurlers lisent le HTML SSR sans JS → URL relative inutilisable, d'où l'absolue. `domainUrl` (state client) supprimé.
   - Bouton « partager une carte » retiré (`Hero.tsx` desktop + `MActions` mobile). `ShareCardButton.tsx` supprimé. Le bouton « Partager » simple donne le lien (share natif / copie presse-papier) ⇒ l'embed affiche la carte. Clés `shareCard.*` supprimées.
4. **Historique refait** (`pages/en/anime/recently-watched.js`) : logique fetch/remove/SSR **inchangée** (robuste). UI refaite : header héros avec wash d'accent + 3 stats (épisodes / animes uniques / temps de visionnage = somme des `timeWatched`), recherche, **groupement par récence** (Aujourd'hui / Hier / cette semaine / ce mois / plus ancien via `createdDate`), cartes 16:9 (badge terminé/temps restant, play au hover, barre de progression en accent, CTA Reprendre). Nouvelles clés i18n EN+FR sous `home.*`.
5. **« Surprends-moi » retiré** : `SurpriseButton` retiré de `my-list.tsx` et `profile/[user].tsx`, composant `components/list/SurpriseButton.tsx` supprimé, clés `surprise.*` supprimées (EN+FR). `QueueSection` (file d'attente) conservée.

### Leçons / pièges
- **Cache empoisonné** : ne jamais cacher un résultat vide issu d'un fetch potentiellement en échec avec un long TTL — un seul 429 bloque la page pour la journée. Toujours : « cache seulement si données » + « cache vide = miss ».
- **OG/unfurl** : les crawlers lisent le HTML SSR brut, jamais le JS client. Une `og:image` doit être une URL **absolue** présente dès le SSR — un state posé dans un `useEffect` arrive trop tard.
- `--brand-primary` ne suffit pas pour reskinner tout Vidstack : la piste *buffered* lit `--brand-glow`. Garder les dérivés en phase dans `applyAccent`.

---

## 2026-06-14 — Lot features (9/9) : partage de carte « anime du moment »

### Contexte
Feature #8, dernière de la liste. Choix utilisateur : carte de **l'anime de la page courante**, génération **canvas → téléchargement PNG + Web Share natif**.

### Décisions prises
1. **`components/anime/v2/ShareCardButton.tsx`** : auto-contenu, zéro dépendance. `buildCard(info, accent)` dessine sur un `<canvas>` 1200×630 (ratio OG) : fond banner/cover flouté + gradient, poster arrondi avec ombre, tag « ANISCROLL » en couleur d'accent, titre wrap (3 lignes max, ellipsis), méta (année · format · ep), chips genres, badge score /10. `toBlob` → `File` PNG. Partage : `navigator.canShare({files})` → share sheet natif (mobile) ; sinon download + toast.
2. **Placement** : bouton pleine largeur sous favori/partage dans `Hero.tsx` (desktop) et `MActions` de `InfoPageMobile.tsx` (mobile, prop `info`+`accent` ajoutés). Couleur d'accent live via `useAccent()`. Clés i18n `shareCard.*`.

### Leçons / pièges
- Canvas + `toBlob` exige des images **CORS-clean** : AniList (s4.anilist.co) envoie les en-têtes CORS, et `img.crossOrigin="anonymous"` → pas de taint. Chaque `loadImage` est en try/catch : une image qui échoue est simplement omise (pas de canvas taint).
- La carte utilise la couleur d'accent custom (#10) → cohérence avec le thème choisi.

### État déployé / à faire
- Branche `dev`. `tsc` clean ; `next lint` clean sur les fichiers neufs (warnings `<img>` de InfoPageMobile préexistants).
- ⏳ Tester : bouton « Partager une carte » sur une page anime → PNG (desktop) / share sheet (mobile).
- ✅ **LISTE DE 12 FEATURES TERMINÉE.** (#2 volume, #11 subs, #12 historique étaient déjà présents ; tout le reste livré.)

---

## 2026-06-14 — Lot features (8/n) : thème custom + #11/#12 déjà faits

### Contexte
Feature #10 (thème custom). Découvert que #11 (taille subs mémorisée) et #12 (historique) **existaient déjà**.

### Décisions prises
1. **Thème custom** (`lib/prefs/accentColor.ts`) : tout l'UI lit déjà `--brand-primary` (Tailwind `action`/`accent` + chrome Vidstack). Le thème = juste cette variable sur `:root`. Store localStorage (`aniscroll:accent`), `applyAccent` pose la var, hook `useAccent`. Appliqué au boot dans `_app.tsx` (après les vars par défaut). Réglages : section « Thème » avec **8 presets** (roue conique + presets ronds) + **color picker libre** (`<input type=color>`) + bouton reset. Clés i18n `settings.theme.*`.
2. **#11 déjà fait** : `SubtitleSettings.tsx` persiste DÉJÀ taille/position/couleur/police dans `subtitle_settings_v2` (hydrate au mount, save à chaque changement) → rien à faire.
3. **#12 déjà fait** : `pages/en/anime/recently-watched.js` est une vraie page d'historique (merge Prisma + localStorage `artplayer_settings`, vignettes, barre de progression, supprimer/lire-suivant, état vide), liée depuis l'accueil (section Recently Watched) → rien à faire.

### Leçons / pièges
- Vérifier l'existant AVANT de coder : 2 des features demandées étaient déjà là (subs persistés, historique). Le système `--brand-primary` rendait le thème trivial (une seule var).

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` + JSON clean.
- ⏳ Tester : changer la couleur d'accent → tout le site + lecteur suit, persiste au reload.
- ⏭️ Reste : #8 partage de carte « anime du moment » (le plus gros). #11/#12 clos (déjà présents).

---

## 2026-06-14 — Lot features (7/n) : mode données réduites

### Contexte
Feature #9 : toggle « économie de données ».

### Décisions prises
1. **`lib/prefs/dataSaver.ts`** : store localStorage (`aniscroll:dataSaver`), event + hook `useDataSaver` (même pattern que les autres prefs).
2. **Réglages** : nouvelle section « Économie de données » dans `settings.tsx` avec le toggle. Clés i18n `settings.dataSaver.*`.
3. **Application** : `UniversalPlayer` lit `useDataSaver()` et **désactive l'ambient-light** (`ambientEnabled = … && !dataSaver`) — c'est le travail visuel le plus lourd (lecture canvas continue + blur). Description du toggle honnête (ne promet que l'ambient pour l'instant).

### Leçons / pièges
- La partie « images plus légères » touche beaucoup de composants (risqué) → livré le gain à fort impact / faible risque (ambient off) ; libellé adapté pour ne pas survendre.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` + JSON clean.
- ⏳ Tester : activer économie de données → plus d'effet de lumière d'ambiance dans le lecteur.
- ⏭️ Suite : partage de carte, thème custom, taille subs mémorisée, historique. (Option future : étendre data-saver aux tailles d'images.)

---

## 2026-06-14 — Lot features (6/n) : roulette « Surprends-moi »

### Contexte
Feature #7 : un bouton qui pioche un anime au hasard à regarder.

### Décisions prises
1. **`components/list/SurpriseButton.tsx`** : auto-contenu, client-only. Pool = ids de la **file d'attente** d'abord (choix délibérés) puis les **PLANNING** du local, dédupliqués. Pioche aléatoire → `router.push(/en/anime/<id>)`. Toast si pool vide.
2. **Placement** : sur `/my-list` (si liste non vide) et sur la page profil **propriétaire** (`isOwner`), à côté de `QueueSection`. Clés i18n `surprise.*`.

### Leçons / pièges
- Pas de filtre durée/genre pour l'instant (file + Planning suffisent comme pool ciblé) — extensible plus tard si besoin.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` + JSON clean.
- ⏳ Tester : bouton « Surprends-moi » → ouvre un anime de la file/Planning au hasard ; pool vide → toast.
- ⏭️ Suite : partage de carte, mode données réduites, thème custom, taille subs mémorisée, historique.

---

## 2026-06-14 — Saison suivante : fraîche vs ancienne + file visible (profil)

### Contexte
Retours : (1) la notif saison suivante doit distinguer **suite qui sort** (notif directe) vs **suite ancienne** (mention occasionnelle, paced, comme le rappel reprise) ; (2) la file d'attente n'apparaissait pas dans « My List » — parce que les connectés vont sur `/profile/<nom>`, pas `/my-list`.

### Décisions prises
1. **Next-season fraîche vs ancienne** (`computeNotifications.ts`) : `fetchSequels` récupère aussi `status` + `startDate`. `isFresh` = `RELEASING`/`NOT_YET_RELEASED` OU démarrée < 60 j. Les **fraîches** sont toujours affichées (comme new-episode). Les **anciennes** passent par un **gate paced** (`SEQUEL_GATE_KEY`, 3 j, pick persisté façon resume) → une seule mention « il existe une suite » à la fois, qui tourne. Flag `fresh` sur la notif → 2 textes (`nextSeasonFreshBody`/`nextSeasonOldBody`).
2. **File visible pour les connectés** : la file (et le bug) venait du routage NavBar (connecté → `/profile/<nom>`). Extrait l'UI dans `components/list/QueueSection.tsx` (client-only, rien si vide) ; monté sur `/my-list` ET sur la page profil **pour le propriétaire** (`isOwner` = session.name == user.name, insensible casse). La file est en localStorage donc app-wide.

### Leçons / pièges
- Toujours vérifier le **routage** avant de conclure à un bug d'affichage : la file marchait, elle n'était juste pas sur la page où atterrissent les connectés.
- `QueueSection` partagé évite la duplication entre my-list et profil.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` + JSON clean.
- ⏳ Tester : suite en cours de diffusion → notif directe ; suite ancienne non possédée → mention occasionnelle (1 à la fois, pas avant 3 j) ; file visible sur profil (connecté) et my-list (invité).
- ⏭️ Suite : roulette, partage de carte, mode données réduites, thème custom, taille subs mémorisée, historique.

---

## 2026-06-14 — Lot features (5/n) : détection saison suivante (notif)

### Contexte
Feature #6 : signaler qu'une suite existe pour un anime terminé.

### Décisions prises
1. **Intégré aux notifications** (`computeNotifications.ts`) plutôt qu'une nouvelle surface : nouveau kind `next-season`. Pour chaque entrée **COMPLETED** du local, `fetchSequels` (batch AniList `Page.media.relations.edges`, 1ère arête `SEQUEL` de format TV/TV_SHORT/ONA) ; on émet la notif **seulement si la suite n'est PAS déjà dans la liste** (`ownedIds`). La notif pointe directement vers la suite (`mediaId = seq.id`). Cache par id (`sequelCache`, durée session — les suites apparaissent rarement).
2. **Rendu** (`NotificationBell.tsx`) : `bodyFor` gère `next-season` → `notifications.nextSeasonBody`. Clés i18n FR+EN.
3. **Réutilisation** : on ne touche PAS au `resolveSeasonList` SSR/Redis lourd (walk de franchise) — overkill pour une notif ; un simple edge SEQUEL direct suffit.

### Leçons / pièges
- Filtrer le SEQUEL sur le format TV-like évite de notifier un film récap / OVA comme « saison suivante ».
- Garde anti-bruit : ne notifier que si la suite n'est pas déjà possédée (sinon l'utilisateur le sait déjà).

### État déployé / à faire
- Branche `dev`. `tsc` + JSON + lint clean.
- ⏳ Tester : avoir un anime COMPLETED dont la S2 n'est pas dans la liste → notif « suite disponible » qui linke la S2.
- ⏭️ Suite : roulette, partage de carte, mode données réduites, thème custom, taille subs mémorisée, historique.

---

## 2026-06-14 — Lot features (4/n) : file d'attente « à regarder ensuite »

### Contexte
Feature #5 : une file ordonnée « à regarder ensuite », indépendante du statut de liste.

### Décisions prises
1. **`lib/list/queue.ts`** : store localStorage (`aniscroll:queue` = `QueueItem[]` ordonné), event + hooks `useQueue`/`useIsQueued`. API `addToQueue`/`removeFromQueue`/`toggleQueue`/`moveInQueue(dir)`. Items cachent title+cover pour rendu sans fetch.
2. **`components/anime/v2/QueueButton.tsx`** : bouton toggle **auto-contenu** (lit/écrit le store directement → pas de plumbing à travers Hero/InfoPage). Prop `size` (56 desktop / 44 mobile). Posé à côté de favori/partage dans `Hero.tsx` (desktop) et `MActions` de `InfoPageMobile.tsx` (mobile, props `mediaId/mediaTitle/mediaCover` ajoutées + threadées depuis le caller qui a `info`).
3. **Affichage** : section « À regarder ensuite » en tête de `/my-list` (numérotée, monter/descendre/retirer), au-dessus du streak/listes. Clés i18n `queue.*`.

### Leçons / pièges
- Bouton auto-contenu = zéro prop plumbing : il consomme `useIsQueued(mediaId)` et appelle `toggleQueue` lui-même ; seul le `mediaId/title/cover` doit venir du parent (déjà dans `info`).
- Warnings `<img>` de `InfoPageMobile` préexistants (non liés), non bloquants.

### État déployé / à faire
- Branche `dev`. `tsc` + JSON clean ; lint OK sur les fichiers neufs.
- ⏳ Tester : bouton file sur page anime (desktop+mobile) → toast ; `/my-list` montre la file, réordonner/retirer.
- ⏭️ Suite : détection saison suivante, roulette, partage de carte, mode données réduites, thème custom, taille subs mémorisée, historique.

---

## 2026-06-14 — Vitesse : restauration via `remote.changePlaybackRate` (menu enfin synchro)

### Contexte
Le prop contrôlé `playbackRate={rate}` mettait bien la vitesse sur le `<video>` mais **le menu Speed restait sur « Normale »** : le prop met à jour le `<video>` (et React ne re-render pas quand `rate` est inchangé après un reset interne), mais PAS le `$state` que le menu radio lit. Idem pour `player.playbackRate =`.

### Décisions prises
1. **Restauration via le REMOTE** (`UniversalPlayer.tsx`) : `player.remote.changePlaybackRate(rate)` est le **seul canal qui met à jour le `$state`** (donc le label du menu) en plus du `<video>`. Nouveau modèle :
   - `rateTargetRef` = vitesse voulue (storage puis choix user).
   - `onRateChange(detail, event)` : si `event.request` (vrai changement user via menu) → adopte + persiste la cible ; sinon (reset auto Vidstack) → ignore.
   - Effet sur `[playbackRateState, streamData]` : si `playbackRateState ≠ cible` → `remote.changePlaybackRate(cible)`. Ça resync menu + video + state, puis `playbackRateState === cible` → effet silencieux (pas d'oscillation). Les changements user ayant déjà bougé la cible, on ne les combat jamais.
   - **Prop `playbackRate={rate}` retiré** (contrôlé ne synchronisait pas le menu) ; on garde juste `onRateChange`.

### Leçons / pièges
- 3 itérations ratées car j'attaquais le mauvais canal : `video.playbackRate` / prop contrôlé mettent la valeur mais PAS le `$state` du menu Vidstack. **`remote.changePlaybackRate` est le bon** — il passe par le pipeline de requête qui met à jour le store. Pour tout réglage reflété par un menu Vidstack, utiliser le `remote`.
- `MediaRateChangeEvent.request` distingue user vs reset (déjà acquis) ; combiné au remote, ça donne une restauration stable.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` clean.
- ⏳ Tester (le test décisif) : 1.75× → changer de SERVEUR → **le menu affiche 1.75×** (pas Normale) ; changer d'anime idem ; changer au menu persiste.

---

## 2026-06-14 — Vitesse : ignorer le reset Vidstack au changement de serveur

### Contexte
Le prop contrôlé corrigeait le changement d'anime, mais **changer de lecteur (serveur)** remettait le menu sur « Normale ». Cause : au reload, Vidstack émet `rate-change` à 1× (son reset), ce qui appelait `onRateChange(1)` → `setRate(1)` → persistait 1×.

### Décisions prises
1. **Filtrer sur `event.request`** (`UniversalPlayer.tsx`) : `MediaRateChangeEvent` porte un `request?` présent **uniquement** pour une vraie action utilisateur (menu/remote). Le reset auto de Vidstack n'en a pas. `onRateChange(detail, event)` ignore désormais tout event **sans `request`** → on ne persiste/maj `rate` que sur action user ; le reset silencieux est ignoré et le prop contrôlé `playbackRate={rate}` ré-impose notre valeur (menu correct).
2. **Signature handler confirmée** : le code compilé `@vidstack/react` invoque les callbacks en `[event.detail, event]` quand l'event a un `detail` → le 2e arg EST l'event complet, donc `event.request` est lisible.

### Leçons / pièges
- Vidstack émet `rate-change` pour DEUX raisons (user vs reset interne) — toujours distinguer via `event.request` sinon le reset pollue l'état persistant.
- Quand le 1er param d'un handler Vidstack-React est le `detail`, le 2e est l'event natif (`args = !isUndefined(detail) ? [detail, event] : [event]`).

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` clean.
- ⏳ Tester : changer de SERVEUR en 1.5× → menu reste 1.5× ; changer d'anime idem ; changer la vitesse au menu → persiste.

---

## 2026-06-14 — Vitesse : prop contrôlé Vidstack (fix menu « Normale » définitif)

### Contexte
Les approches impératives (`player.playbackRate = x` sur can-play / timeouts / watcher) laissaient toujours le menu Vidstack sur « Normale » entre animes, ou oscillaient. Inspection des types Vidstack 1.9.8 : `playbackRate` est un **prop contrôlable** de `<MediaPlayer>` (`MediaPlayerProps`), et l'event React `onRateChange` (détail = `number`) remonte les changements.

### Décisions prises
1. **Vitesse = prop contrôlé** (`UniversalPlayer.tsx`) : state `rate` (seedé depuis `aniscroll:playbackRate`, clampé 0.25–4) passé en `<MediaPlayer playbackRate={rate} onRateChange={...}>`. Contrôlé ⇒ Vidstack garde son `$state` (donc le **menu Speed**) synchro avec notre valeur ET la ré-applique à chaque (re)chargement média (qui sinon reset à 1×). `onRateChange` persiste les vrais changements user. **Source de vérité unique → ni oscillation ni désync menu.** Supprime tout le bricolage impératif précédent (timeouts/refs/`volArmedRef` pour la rate). Volume/muted restent volontairement NON contrôlés (eux n'ont pas ce reset).

### Leçons / pièges
- Pour un réglage que Vidstack reset au load et qu'un menu interne reflète, le **prop contrôlé** est LA solution — les setters impératifs ne synchronisent pas toujours le `$state` que le menu lit, d'où le « Normale » fantôme. Vérifier les types du lib AVANT de bricoler aurait évité 3 itérations.
- `onRateChange` (React) existe même s'il n'apparaît pas en recherche directe dans les `.d.ts` (généré depuis l'event DOM `rate-change`) ; `tsc` l'a validé.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` clean.
- ⏳ Tester : changer la vitesse (menu suit, pas d'oscillation) ; changer d'anime (vitesse + menu conservés).

---

## 2026-06-14 — Fix oscillation vitesse + streak retirée de la NavBar

### Contexte
(1) Le watcher continu de vitesse créait une **oscillation** : changer la vitesse alternait en boucle ancienne↔nouvelle (restore effect ré-appliquait l'ancienne avant que le save n'aligne la cible — bagarre entre deux effets sur `[playbackRateState]`). (2) Retirer la puce streak de la NavBar.

### Décisions prises
1. **Vitesse — plus de watcher continu** (`UniversalPlayer.tsx`) : remplacé par un **apply one-shot par média**. À chaque `streamData` : `rateUserSetRef=false`, puis `apply()` immédiat + re-applies à 400 ms et 1200 ms (couvre le reset-1× post-load de Vidstack), gardés par `!rateUserSetRef`. Le save effect (sur interaction) pose `rateUserSetRef=true` → les timers restants se taisent. **Aucun watcher permanent → aucune oscillation**, et le menu reste correct car on applique après le reset.
2. **Streak hors NavBar** : `StreakChip.tsx` supprimé + retiré de `NavBar.tsx`. L'enregistrement (`recordWatchToday` à ≥2 min dans `onTimeUpdate`) et le badge sur `/my-list` restent.

### Leçons / pièges
- Deux `useEffect` qui écoutent le même état réactif et s'écrivent mutuellement = oscillation garantie (l'ordre fixe fait gagner le premier déclaré). Pour un réglage « restaurer puis laisser libre », préférer un **apply borné dans le temps** (timeouts) plutôt qu'un watcher permanent.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` clean.
- ⏳ Tester : changer la vitesse → stable, pas d'oscillation ; changer d'anime → vitesse conservée dans le menu ; streak visible sur `/my-list` (pas dans la NavBar).

---

## 2026-06-14 — Fixes 2 : vitesse entre animes + streak qui ne montait pas

### Contexte
Suite des deux fixes : (1) la vitesse repassait à « Normale » dans l'UI en **changeant d'anime** ; (2) le streak ne s'affichait toujours pas.

### Décisions prises
1. **Vitesse entre animes** (`UniversalPlayer.tsx`) : le bug venait du guard `!volArmedRef` sur la correction — entre deux animes, `volArmedRef` pouvait rester `true` (page pas totalement remontée) → la correction était bloquée et Vidstack laissait 1×. Refonte : **la restauration ne dépend plus du tout de l'arm latch**. `rateTargetRef` = valeur voulue (storage puis choix user) ; un effet ré-assert la cible dès que `playbackRateState` diffère (sur `[playbackRateState, streamData]`), **toujours**. Comme la cible = le dernier choix user (le save effect la met à jour), ré-assert ne peut jamais révoquer un choix délibéré — juste annuler le reset-1× de Vidstack. Le save reste gardé par `volArmedRef` (anti-churn) + ignore l'écho du restore.
2. **Streak qui montait pas** : il ne se déclenchait qu'à la **fin** d'un épisode (`handleEpisodeComplete`) — donc 0 tant qu'on n'avait pas fini un ep. Ajout d'un déclencheur **plus fiable** : `recordWatchToday()` dans `onTimeUpdate` dès `currentTime >= 120s` (≥ 2 min vus = « regardé aujourd'hui »). Idempotent/jour, throttlé (~3 s). La puce NavBar se met à jour en live via `STREAK_EVENT`.

### Leçons / pièges
- Ne JAMAIS gater la *restauration* d'un réglage sur le latch d'interaction (qui sert au *save*) : entre deux médias le latch peut survivre et bloquer la restauration. Restaurer toujours, et rendre le save idempotent contre l'écho.
- Le seuil 2 min rend le streak observable sans finir l'épisode, tout en évitant de compter un simple survol.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` clean.
- ⏳ Tester : changer d'anime en 1.5× → menu reste 1.5× ; regarder 2 min → 🔥 apparaît dans la NavBar.

---

## 2026-06-14 — Fixes : UI vitesse désync + streak introuvable

### Contexte
Deux retours : (1) la vitesse était bien sauvée/appliquée mais le menu Vidstack affichait « Normale » alors qu'on était en 1.75× ; (2) le streak introuvable (badge seulement sur `/my-list`, masqué à 0).

### Décisions prises
1. **Fix UI vitesse** (`UniversalPlayer.tsx`) : `player.playbackRate = x` posé une fois sur `can-play` ne suffit pas — Vidstack **reset la rate à 1× quand le média (re)charge APRÈS `can-play`**, donc la valeur restait sur le `<video>` mais le menu montrait 1×. Remplacé par une boucle **auto-correctrice** : `savedRateRef` (cible) + `rateSettleRef` (fenêtre de correction de 4 s rouverte à chaque `streamData`). Un effet sur `playbackRateState` ré-assert la cible tant que `!volArmedRef` (avant interaction user) ET fenêtre ouverte — ce qui resynchronise le menu Vidstack. Dès que l'utilisateur change lui-même la vitesse, le save effect aligne `savedRateRef` + ferme la fenêtre → aucune lutte/flicker.
2. **Streak global** : nouveau `components/shared/StreakChip.tsx` (puce 🔥+nombre, masquée à 0, best en tooltip) montée dans la **NavBar** avant la cloche → visible partout (pas seulement `/my-list`, que les connectés ne voient pas). Le badge `/my-list` reste.

### Leçons / pièges
- Vidstack reset `playbackRate` à 1× sur (re)chargement média → toute restauration de vitesse doit être **auto-correctrice** (watch de l'état réactif), pas un one-shot sur `can-play` (le pattern volume marchait par chance car le volume n'est pas reset).
- Ordre des effets : restore déclaré avant save, tous deux sur `[playbackRateState]` → garder le restore gardé par `!volArmedRef` évite qu'il révoque un changement utilisateur avant que le save n'aligne la cible.
- Le streak compte à la **fin** d'un épisode, pas au lancement — normal qu'il soit à 0 tant qu'on n'a pas fini un ep aujourd'hui.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` clean.
- ⏳ Tester : recharger en 1.75× → menu affiche 1.75× ; finir un ep → puce 🔥 dans la NavBar.

---

## 2026-06-14 — Lot features (3/n) : streak de visionnage

### Contexte
Feature #4 « Objectifs / streak » : jours consécutifs avec au moins un épisode terminé.

### Décisions prises
1. **`lib/stats/streak.ts`** : store localStorage (`aniscroll:streak` = `{lastDay, current, best}`), event + hook `useStreak`. Jours = `YYYY-MM-DD` **locaux** (boundary timezone user, pas UTC). `recordWatchToday()` (idempotent dans la journée) : même jour → no-op ; +1 jour → continue ; gap → reset à 1. `liveStreak()` affiche 0 si le dernier visionnage date de > 1 jour (streak cassé sans réécriture).
2. **Enregistrement** : `recordWatchToday()` appelé dans `handleEpisodeComplete` (`[...info].js`), à chaque fin d'épisode — couvre HLS (`ended`) ET avance d'épisode (iframe).
3. **Affichage** : badge 🔥 en tête de `/my-list` (`useStreak`), montré seulement si streak > 0, avec `best` en tooltip. Clés i18n `myList.streakDays(_other)` + `myList.bestStreak`.

### Leçons / pièges
- Le streak « vivant » ≠ la valeur stockée : si l'utilisateur saute un jour, on n'a pas réécrit le store (pas d'event au repos) → `liveStreak` calcule le gap à l'affichage et renvoie 0 si cassé.
- Pluriel i18next : clé `_other` fournie pour `streakDays`.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` clean, JSON validés.
- ⏳ Tester : finir un ep aujourd'hui → 🔥 1 ; un autre demain → 🔥 2 ; sauter un jour → repart à 1.
- ⏭️ Suite : file d'attente, détection saison suivante, roulette, partage de carte, mode données réduites, thème custom, taille subs mémorisée, historique.

---

## 2026-06-14 — Lot features (2/n) : mini-lecteur = PiP natif (mobile) + fix a11y

### Contexte
Feature #3 « mini-lecteur PiP maison ». Choix utilisateur : **PiP natif navigateur** (vignette système qui survit à la navigation/onglets), pas de mini-lecteur global custom (qui aurait exigé de remonter le lecteur dans `_app` — refonte lourde).

### Décisions prises
1. **Desktop : déjà là.** Vidstack `DefaultVideoLayout` rend déjà son bouton PiP natif (`.vds-pip-button`, d'ailleurs utilisé comme ancre de positionnement du controls-host). Donc rien à ajouter sur desktop — un bouton custom aurait fait **doublon** (une 1re version l'ajoutait dans `CustomControls`, retirée).
2. **Mobile/small layout** : Vidstack ne surface pas PiP dans son layout mobile → ajout d'une `SettingsActionRow` « Image dans l'image » dans le menu réglages, gardée par `pipSupported` (`document.pictureInPictureEnabled`). Handler `togglePip` : `exitPictureInPicture` si déjà en PiP, sinon `video.requestPictureInPicture()` sur le `<video>` du player. Uniquement sur le chemin direct-stream (le chemin iframe `return` avant — pas de `<video>` joignable).
3. **Fix a11y** (bonus, même fichier) : `SettingsToggleRow` passait `aria-checked` sur `role="menuitem"` (warning ESLint `jsx-a11y/role-supports-aria-props`) → `role="menuitemcheckbox"`. La classe `.vds-menu-button` porte le style, pas le rôle, donc chrome inchangé. `next lint` clean.

### Leçons / pièges
- PiP natif ne marche QUE sur un vrai `<video>` (HLS/MP4), pas les serveurs iframe — le bouton se cache pour ceux-là (le chemin iframe a son propre `return`).
- Toujours vérifier ce que Vidstack rend déjà avant d'ajouter un bouton : `.vds-pip-button` existe (anchor du MutationObserver) ⇒ desktop couvert.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` (fichier touché) clean, JSON validés.
- ⏳ Tester : desktop → bouton PiP Vidstack ; mobile → menu réglages « Image dans l'image » sur stream direct ; iframe → pas de PiP.
- ⏭️ Suite : streak, file d'attente, détection saison suivante, roulette, partage de carte, mode données réduites, thème custom, taille subs mémorisée, historique.

---

## 2026-06-14 — Nouveau lot features (1/n) : vitesse de lecture mémorisée

### Contexte
Nouvelle liste de features demandées (12). Livraison **une par une, commit par feature**, dans l'ordre donné. Note : le **volume était déjà persisté** app-wide (`aniscroll:volume`/`muted`) et la reprise de progression existe — donc « volume mémorisé » est déjà fait, sauté.

### Décisions prises
1. **Vitesse de lecture mémorisée** (`UniversalPlayer.tsx`) : même pattern que le volume. `playbackRateState = useMediaState("playbackRate")`. Restore dans l'effet volume existant (`apply()` pose `player.playbackRate = savedRate`, clampé 0.25–4) ; save dans un effet gardé par le **même latch `volArmedRef`** (n'enregistre qu'après une vraie interaction utilisateur, pour ne pas re-sauver la churn du restore). Clé `aniscroll:playbackRate`, app-wide (tous lecteurs/animes/sessions).

### Leçons / pièges
- Réutiliser `volArmedRef` (latch one-way sur 1re interaction) évite de re-implémenter la garde anti-churn ; le player se remonte plusieurs fois (fallback serveur) donc un latch en `useRef` est indispensable.

### État déployé / à faire
- Branche `dev`. `tsc` clean.
- ⏳ Tester : mettre 1.5×, changer d'épisode/anime/recharger → reste à 1.5×.
- ⏭️ Suite de la liste : mini-lecteur PiP, streak, file d'attente, détection saison suivante, roulette, partage de carte, mode données réduites, thème custom, taille subs mémorisée, historique.

---

## 2026-06-14 — Affinage notifs : films 1-ep, new-ep RELEASING, reco resume théma

### Contexte
Retours sur les notifs + popup. (1) Les films courts : se baser sur « 1 seul épisode » plutôt que la durée. (2) Nouvel épisode : uniquement les animes **RELEASING**. (3) Rappel de reprise : un algo paced qui recommande UN anime en pause/stalled (≠ DROPPED) théma-matché à ce qu'on regarde récemment.

### Décisions prises
1. **Popup films** (`SkipOverlay.tsx`) : nouveau prop `isSingleEpisode` (watch page : `totalEpisodes === 1 || info.format === "MOVIE"`). Si single → seuil **95%** (`RATE_PROMPT_SINGLE_FRACTION`), sinon le `max(88%, durée-180s)` des séries. Threadé via `UniversalPlayer` → `SkipOverlay`.
2. **New-episode = RELEASING only** (`computeNotifications.ts`) : `fetchAiring` récupère aussi `status` ; on n'émet l'alerte que si `status === "RELEASING"`.
3. **Reco resume théma-matchée** :
   - Candidats : `PAUSED` ou `CURRENT` non touchés depuis **≥ 30 j** (`RESUME_STALE_DAYS`), hors ceux qui ont déjà une alerte new-ep. **DROPPED exclu** (demande explicite — l'utilisateur les a lâchés exprès).
   - Matching : `fetchThemes` (batch AniList `genres` + `tags{name}`, caché par id) ; `themeOverlap` = genres ×2 + tags ×1, comparé au set « regardé récemment » (`CURRENT`/`COMPLETED` actifs < 30 j). Meilleur score gagne ; égalité → le plus récemment stale.
   - Pacing : une nouvelle reco au plus **tous les 3 jours** (`RESUME_INTERVAL_MS`), mais on **persiste le pick** (`{mediaId, at}` en localStorage) et on le **ré-émet** pendant toute la fenêtre tant qu'il reste un candidat valide — sinon il disparaîtrait au recompute suivant (NavBar se remonte par page).
4. **Nettoyage** : `resumeAfterDays` retiré de `ComputeOpts` (remplacé par `RESUME_STALE_DAYS` fixe) ; import `getSyncPrefs` retiré du hook.

### Leçons / pièges
- **Le pick resume doit persister**, pas être re-décidé à chaque recompute : sinon `markResumeShown` fermait la porte et la notif s'évaporait au prochain rendu. D'où le `{mediaId, at}` stocké + ré-émission dans la fenêtre.
- `themesCache` est une `Map` par id (pas par requête) : on ne refait pas la requête genres/tags pour un id déjà connu.

### État déployé / à faire
- Branche `dev`. `tsc` + `next lint` (fichiers touchés) clean.
- ⏳ Tester : film (1 ep) → popup à 95% ; série en cours de diffusion en retard → alerte ; un PAUSED ancien proche théma d'un anime regardé → reco resume, et pas de 2e reco avant 3 j.

---

## 2026-06-14 — Notifications in-app (cloche NavBar) + fix popup films

### Contexte
(1) La popup de note à 88% arrivait trop tôt sur les films (88% de 2h = 14 min avant la fin). (2) Lot notifications : alerte nouvel épisode + rappel de reprise, **in-app** (pas de web push), via une **cloche dans la NavBar** (choix utilisateur).

### Décisions prises
1. **Fix films** (`SkipOverlay.tsx`) : le seuil de la popup de note devient `max(durée*0.88, durée - 180s)` (`RATE_PROMPT_FRACTION` + `RATE_PROMPT_MAX_LEAD_SECONDS=180`). Épisode 24 min → ~88% inchangé ; film 2h → plafonné à 3 min avant la fin.
2. **`lib/notifications/computeNotifications.ts`** : calcule les notifs depuis la **liste locale**. `new-episode` pour chaque entrée CURRENT dont le dernier épisode diffusé (`nextAiringEpisode.episode - 1`, sinon `episodes`) dépasse `progress` — via une **requête batch AniList** `Page.media(id_in:)`. `resume` pour les CURRENT/PAUSED dont `activityAt` dépasse `autoPauseDays` (réutilise le réglage existant). Dédoublonnage : pas de rappel resume si une alerte nouvel-épisode existe déjà pour le même média. **Cache module-level** (clé = ids triés, TTL 15 min) pour ne pas re-hit AniList à chaque navigation (la NavBar se remonte par page).
3. **`lib/notifications/useNotifications.ts`** : hook qui recompute au mount + sur `LOCAL_LIST_EVENT`/`storage`, garde l'état « lu » dans localStorage (`aniscroll:notifReadIds`). **Id stable** `kind:mediaId:nombre` → un épisode plus récent change l'id donc re-passe en non-lu. Prune des ids lus qui ne correspondent plus à une notif vivante. `runIdRef` anti-race sur les computes async concurrents.
4. **`components/shared/NotificationBell.tsx`** : cloche + pastille (compteur non-lus, "9+"), dropdown (ferme sur clic-dehors/Escape), ouverture = `markAllRead`. Chaque item linke `/en/anime/<id>`. Montée dans `NavBar.tsx` avant `ReportButton`. Clés i18n `notifications.*` (FR+EN).

### Leçons / pièges
- `pickTitle` ne renvoie jamais vide ("Untitled" au pire) → pas besoin de chaîne de fallback maison dans `localTitle`.
- On ne met en cache que les réponses AniList **réussies** (pas dans le `catch`), sinon un échec transitoire serait mémorisé 15 min.
- Web push **non** fait (app fermée = pas de notif) — c'est in-app only, par choix ; le service worker push reste un chantier futur si besoin.

### État déployé / à faire
- Branche `dev`. `tsc --noEmit` + `next lint` (fichiers touchés) clean, JSON validés.
- ⏳ Tester : avoir un anime CURRENT en retard d'épisode → pastille + entrée « épisode N sorti » ; un PAUSED ancien → entrée « en pause depuis X jours » ; ouvrir la cloche efface la pastille.
- ⏭️ Le lot « idées listes » est maintenant **épuisé** (rewatch, public/privé, fusion conflit, notifications). Web push = optionnel futur.

---

## 2026-06-14 — Réglages timing : auto-next au bouton, popup note à 88%

### Contexte
Deux ajustements de déclenchement dans `SkipOverlay.tsx`.

### Décisions prises
1. **Auto épisode suivant** déclenché quand le **bouton « Next Episode » apparaît** (`showNext` = début de l'outro OU dans les `NEXT_EP_TAIL_SECONDS` de la fin), au lieu de l'ancien `duration - 1s`. Effet dépend de `showNext`, gardé par `autoAdvancedRef`.
2. **Popup de note** déclenchée à **88% de la durée** (`RATE_PROMPT_FRACTION = 0.88`) au lieu d'un lead fixe de 25 s. Un seuil en % s'adapte aux épisodes TV ~24 min comme aux specials/films ; 88% = le dernier ~12% est quasi toujours ED + preview, donc l'histoire est finie mais le spectateur regarde encore.

### Leçons / pièges
- Sur le dernier épisode il n'y a en général **pas** de `nextEpisodeHref` → l'auto-next ne se déclenche pas, donc aucun conflit avec la popup de note. Si `autoSkipOutro` est actif, le saut pousse `currentTime` au-delà de 88% → la popup s'ouvre quand même.

### État déployé / à faire
- Branche `dev`. `tsc --noEmit` clean.
- ⏳ Tester : auto-next part dès l'apparition du bouton ; popup note vers 88% du dernier ep.

---

## 2026-06-14 — Lot listes : rewatch local, fusion conflit au resync, profil privé

### Contexte
Suite des « idées de réglages liste » validées. Trois chantiers : (1) compteur de **rewatch** stocké en local ; (2) **fusion de conflit automatique** au resync AniList (plus de `replace` destructif) ; (3) **profil public/privé** — option choisie par l'utilisateur : « masquer la page profil aux autres » (gating serveur réel).

### Décisions prises
1. **Rewatch local** : ajout du champ `repeat?: number` à `LocalEntry` (`localList.ts`, défaut 0 dans `upsertLocalEntry`). L'éditeur (`listEditor.tsx`) avait déjà le champ `rewatches` (poussé vers AniList via `repeat`) mais ne l'écrivait PAS en local → ajout du seed (`setRewatches(e.repeat)` en mode local) et de l'écriture (`repeat: rewatches` dans le `upsertLocalEntry` local). `fullSyncFromAniList` récupère aussi `repeat` depuis AniList.
2. **Fusion conflit au resync** (`syncEngine.ts`) : `fullSyncFromAniList` ne fait plus un `importEntries(remote, "replace")` aveugle. Nouveau : on lit le local courant, et pour chaque média présent des deux côtés on `reconcileEntry(local, remote)` — **garde la progression la plus avancée** (et le statut CURRENT/COMPLETED correspondant + l'`activityAt` max) ; AniList gagne sur les égalités et tous les autres champs. Les entrées **uniquement locales** (absentes d'AniList) sont **conservées** (avant elles étaient perdues). Résultat : resync **non destructif**.
3. **Profil privé** (gating serveur) :
   - `getServerSideProps` de `profile/[user].tsx` : `getUser(query.user, false)` récupère les réglages du user VISÉ ; si `setting.private === true` et que le visiteur n'est pas le propriétaire (`session.user.name` ≠ `query.user`, comparaison insensible à la casse) → `props: { isPrivate: true }`. Le composant rend une page « profil privé » (pas un 404 — le user existe, il a juste masqué sa liste).
   - **Toggle dans Réglages** (`settings.tsx`, section « Profil », visible si connecté) : charge `setting.private` via `GET /api/user/profile?name=`, l'écrit via `PUT` (merge sur le `setting` existant pour ne pas écraser `CustomLists`). Optimiste + revert sur échec.
   - Clés i18n : `settings.profile.*`, `profile.privateTitle/privateBody`.

### Leçons / pièges
- Le `setting` Prisma est un JSON unique partagé (déjà `CustomLists`) → **merger** `{ ...profileSettings, private }` au PUT, sinon on efface les autres réglages.
- La page profil lit la liste **AniList publique** d'un pseudo (AniList applique SA confidentialité) ; notre flag `private` ne gouverne QUE la page profil AniScroll — c'est explicité dans la note du réglage.
- `getUser(query.user)` est sensible à la casse côté Prisma ; pas de ligne = pas privé = visible (défaut sûr).
- TS : `for..of` sur `Map.values()` exige `Array.from(...)` avec la cible TS du repo (erreur TS2802).

### État déployé / à faire
- Branche `dev`. `tsc --noEmit` clean, JSON locales validés.
- ⏳ **À tester** : éditer un rewatch en local → persiste dans `/en/my-list` après reload ; sync ON, avancer un ep hors-ligne puis resync → progression locale conservée si plus avancée ; activer « Profil privé » dans Réglages → ouvrir `/profile/<toi>` en navigation privée (non connecté) = page « profil privé », connecté = liste visible.
- ⏭️ **Restant** : notifications (nouvel ep + rappel reprise) — session dédiée.

---

## 2026-06-13 — Popup note refondue (centrée, /10, traduite) + Auto play dans Automatisation

### Contexte
Retours sur la session précédente : (1) « Lecture auto » manquait dans le sous-menu Automatisation ; (2) le toggle « Noter à la fin » doit vivre dans les **Réglages du site**, pas dans le lecteur ; (3) refonte de la popup de note — centrée plein écran, déclenchée un peu **avant** la fin de l'anime, **sur 10** (pas 100), plus belle (style du site) et **traduite**.

### Décisions prises
1. **Auto play → sous-menu Automatisation** (`UniversalPlayer.tsx`) : déplacé dans le drill-in, retiré de la liste racine. Ambient lights reste racine. Le toggle `rateOnComplete` est **retiré** du lecteur (clés `player.rateOnComplete` supprimées des locales).
2. **Toggle « Noter à la fin » → page Réglages** : nouvelle section « Lecteur vidéo » dans `settings.tsx` avec le seul toggle `rateOnComplete` (clés `settings.player.*`). La pref reste dans `lib/prefs/playerPrefs.ts` (défaut true).
3. **Déclenchement avant la fin** : nouveau flux. La watch page calcule `isFinalEpisode` (`episodeNumber >= total`) et passe `onFinalEpisodeNearEnd` au player → `SkipOverlay`. SkipOverlay fire le callback **une fois** quand `currentTime >= duration - RATE_PROMPT_LEAD_SECONDS` (25 s) sur l'épisode final (ref `ratePromptedRef`, reset sur changement d'`episode`). Remplace l'ancien déclenchement à la complétion via `onEpisodeFinished` (qui ne renvoie plus de signal utilisé pour ça, mais garde `{ completed }`).
4. **RateModal réécrit** (`components/shared/RateModal.tsx`) : overlay centré (`fixed inset-0 flex items-center justify-center`, fond `bg-black/60 + backdrop-blur`), carte `bg-secondary ring-white/10`, cover + titre de l'anime, **rangée de 10 étoiles** (hover preview), input note, boutons Plus tard / Enregistrer. Score **1-10** : écrit tel quel en local (POINT_10_DECIMAL) et envoyé à AniList en `scoreRaw = score*10` (échelle /100). Traduit via namespace i18n `rate.*` (FR + EN). Suppression du prop `position` et du guard `!isFullscreen` à l'appel.

### Leçons / pièges
- `dataMedia` (watch context) = `setDataMedia(info)` → porte `title` + `coverImage.large`, donc la carte de la popup peut les afficher sans fetch.
- `markComplete` (`useAnilist`) est AniList-only (`if(!accessToken) return`) → la popup écrit TOUJOURS en local d'abord (déjà fait à la session précédente, conservé).
- Le déclenchement « avant la fin » vit dans SkipOverlay (qui a déjà `currentTime`/`duration`), PAS dans la watch page (qui ne suit pas le temps en continu) — `isFinalEpisode` est le seul bit qu'on lui passe.

### État déployé / à faire
- Branche `dev`. `tsc --noEmit` clean, JSON locales validés.
- ⏳ **À tester** : menu lecteur → Automatisation contient bien Lecture auto + 3 toggles ; Réglages → Lecteur vidéo → toggle « Noter à la fin » ; regarder le dernier ep d'un anime → popup centrée ~25 s avant la fin, noter sur 10 → score en local/AniList ; désactiver le toggle → pas de popup.

---

## 2026-06-13 — Sous-menu Automatisation du lecteur + popup note à la complétion

### Contexte
Suite des toggles lecteur. Demandes : (1) regrouper les toggles d'automatisation du lecteur dans une **sous-section** du menu Vidstack ; (2) **popup de note** quand un anime devient « Terminé », **désactivable** ; (3) confirmer que l'incrément de progression, le passage Prévu→En cours et le marquage Terminé auto étaient déjà là. (Rewatch, public/privé profil, fusion conflit, notifications → sessions suivantes.)

### Décisions prises
1. **Déjà en place (confirmé, non retouché)** : l'incrément de progression au visionnage est porté par `autoProgress` (+ progress local toujours MAJ) ; « Retirer de Prévu au démarrage » = le toggle `autoWatching` existant (PLANNING→CURRENT, `syncEngine.ts:184`) ; le marquage **COMPLETED** à la fin est **inconditionnel** (`syncEngine.ts:190`) — on le garde tel quel (le gater réduirait la fonctionnalité demandée).
2. **Sous-menu « Automatisation »** (`UniversalPlayer.tsx`) : nouveau pattern in-portal repliable. State `automationOpen` au root du player ; deux nouveaux composants `SettingsSubmenuRow` (ligne nav + chevron) et `SettingsSubmenuHeader` (retour). Quand ouvert, le host portalé (`settingsHostRef`) affiche header + les toggles ; sinon la ligne « Automatisation ». Reset de `automationOpen` quand le menu réglages se ferme (`useEffect([settingsHostAttached])`).
3. **Popup note à la complétion** : `playerPrefs.rateOnComplete` (défaut **true**, désactivable via un toggle dans le sous-menu Automatisation). `onEpisodeFinished` retourne maintenant `{ completed }` où `justCompleted = prev?.status !== "COMPLETED"` (la finition fait basculer en COMPLETED → on n'ouvre la popup **qu'une fois**, pas à chaque re-finition du dernier ep). `handleEpisodeComplete` (`[...info].js`) ouvre `RateModal` (via `setRatingModalState`) si `completed` + pref ON.
4. **RateModal rendu local-safe** : `markComplete` (`useAnilist`) est **AniList-only** (`if (!accessToken) return`) → pour les invités la note était perdue. Ajout d'un `upsertLocalEntry(mediaId, { status: COMPLETED, score: scoreRaw/10, notes, completedAt })` avant le push AniList. scoreRaw 1-100 → local POINT_10_DECIMAL (÷10).

### Leçons / pièges
- `RateModal` est branché sur `dataMedia` du watch context (déjà fourni) et était **dormant** (aucun `isOpen:true` ne le déclenchait) avant cette session.
- Beaucoup des demandes utilisateur étaient **déjà implémentées** — vérifier le code AVANT de re-coder a évité du travail en double (et un toggle Terminé qui aurait *cassé* le comportement attendu).
- Le sous-menu n'utilise PAS l'API `<Menu>` native de Vidstack : tout est portalé custom dans `settingsHostRef` (comme Autoplay/Ambient), donc un simple swap d'état suffit pour le drill-in.

### État déployé / à faire
- Branche `dev`. `tsc --noEmit` clean, JSON locales validés.
- ⏳ **À tester** : ouvrir menu lecteur → « Automatisation » → 4 toggles + retour ; finir le dernier ep d'un anime → popup note ; désactiver « Noter à la fin » → plus de popup ; en invité, noter → score visible dans `/en/my-list`.
- ⏭️ **Sessions suivantes** : rewatch/compteur, public/privé (profil entier), fusion conflit auto au resync, notifications (nouvel ep + rappel reprise).

---

## 2026-06-13 — Verrou réglages AniList hors-ligne + auto-skip/auto-next lecteur

### Contexte
Deux demandes : (1) rendre les réglages liés à AniList **non modifiables si non connecté** (ils ne font que pousser vers AniList) et renommer la section. (2) Ajouter au lecteur 3 toggles : **auto-skip intro**, **auto-skip outro**, **épisode suivant auto** — regroupés dans une nouvelle section des réglages (trop de toggles sinon).

### Décisions prises
1. **Réglages sync grisés pour les invités** (`settings.tsx`) : tous les toggles de la section sync passent `disabled={!isLoggedIn}` (master + autoProgress/autoWatching/autoPause + le champ `autoPauseDays` → `!isLoggedIn || !syncPrefs.autoPause`). Le composant `Toggle` gérait déjà le greyed-out. Le branchement guest dans `handleMasterToggle` (ligne ~202) devient mort mais reste inoffensif.
2. **Renommage section** : clé `settings.sync.title` → FR « Liste et Synchronisation AniList » / EN « List & AniList Sync ».
3. **Nouveau module `lib/prefs/playerPrefs.ts`** (copie exacte du pattern `syncPrefs` : 1 clé localStorage `aniscroll:playerPrefs`, CustomEvent, hook `usePlayerPrefs`) : `autoSkipIntro`/`autoSkipOutro`/`autoNextEpisode`, **tous OFF par défaut** (l'expérience par défaut reste manuelle, comme les boutons Skip/Next existants).
4. **Toggles dans le MENU du lecteur Vidstack** (pas la page Réglages du site — précision de l'utilisateur en cours de session). Trois `SettingsToggleRow` ajoutées dans `UniversalPlayer.tsx` à côté d'Autoplay / Ambient lights (mêmes lignes portalées dans `settingsHostRef`), lisant/écrivant `usePlayerPrefs`/`setPlayerPrefs`. Labels courts `player.autoSkipIntro/Outro/autoNextEpisode`. (Une 1re itération avait mis une section « Lecteur vidéo » dans `settings.tsx` + clés `settings.player.*` → **retirée**.)
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
