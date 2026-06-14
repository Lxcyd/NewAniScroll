# DEVLOG

Journal des modifs de dev, pour garder le contexte entre les sessions (survit aux `/clear`).
Ordre anti-chronologique (le plus récent en haut). Une entrée = une session/sujet, avec **décisions** et **leçons/pièges**, pas juste les commits (git les a déjà).

> Convention : dates absolues. Branche de travail = `dev` (push auto, voir mémoire). Le Worker Cloudflare se déploie **à la main** (`cd worker && npx wrangler deploy`) — un `git push` ne le déploie pas.

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
