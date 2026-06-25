# DEVLOG

Journal des modifs de dev, pour garder le contexte entre les sessions (survit aux `/clear`).
Ordre anti-chronologique (le plus récent en haut). Une entrée = une session/sujet, avec **décisions** et **leçons/pièges**, pas juste les commits (git les a déjà).

> Convention : dates absolues. Branche de travail = `dev` (push auto, voir mémoire). Le Worker Cloudflare se déploie **à la main** (`cd worker && npx wrangler deploy`) — un `git push` ne le déploie pas.

---

## 2026-06-25 (suite 11) — Watch 2gether : 266 stickers anime importés + composer contentEditable (étape 2)

### Emojis anime — données
- Extrait les **13 packs emojigg** les plus récents de Téléchargements (PNG+GIF) → **266 images** copiées dans `public/emojis/anime/` (renommées en `snake_case`, filename = shortcode pour zéro ambiguïté).
- `animeStickers.ts` rempli : **266 entrées** `{shortcode,label,src,tags}` générées. Labels nettoyés (id numérique parasite retiré). **Zéro doublon** (266 filenames + 266 shortcodes uniques, vérifié).
- **Collisions résolues** : 3 shortcodes (`:cry: :sleep: :think:`) existaient déjà dans `ANIME_EMOJIS` (Twemoji→unicode), ce qui les aurait fait convertir en unicode par `replaceShortcodes`. Renommés `:cry_anim: :sleep_anim: :think_anim:` (+ fichiers). Plus aucune collision.
- Contrainte respectée : shortcodes en `[a-z0-9_]` only (pas de `-`, le `SHORTCODE_RE` les rejette).

### Composer contentEditable (étape 2)
- Nouveau **`ChatComposer.tsx`** (forwardRef : `insert`/`focus`/`getText`/`clear`) : `<div contentEditable>` qui affiche les stickers **en image inline dans la barre** (un `<input>` ne peut pas). Sérialise à l'envoi : `<img data-shortcode>` → `:shortcode:`, `<br>`/blocs → `\n`. Entrée=envoyer (Shift+Entrée=ligne), paste en texte brut, garde de longueur, placeholder via `:empty::before`.
- Branché dans **FullscreenChat** et **WatchPartyPanel** (remplace les 2 `<input>`). EmojiButton `onPick` : sticker → `insert(:shortcode:)` (image), emoji unicode → `insert(replaceShortcodes(...))` (char). `ChatText` rend déjà les stickers (~1.4× la taille emoji).
- CSS `.w2g-composer` (placeholder, scroll vertical max 96px, caret iOS).

### Fixes (rappel suite 10, inclus)
- Hint FS **1×/session** (ref `hintShownRef`). Icône Envoyer **visible au hover** (exclu `.w2g-fs-send` de la règle `.vds-player button:hover→rose`).

### À tester / pièges
- contentEditable : vérifier caret après insert, envoi, mute (overlay panel), iOS. Les GIF s'animent dans la barre + le chat.
- Si un sticker ne s'affiche pas → fichier manquant dans `public/emojis/anime/` (le `<img>` ne rend rien, rien d'autre ne casse).

### Fixes
- **Hint FS « le chat est ici » : 1 seule fois par session w2g** (avant : à chaque entrée FS). Garde via `useRef` (`hintShownRef`) qui vit le temps du composant = toute la session party. Se montre au 1er passage FS, auto-dismiss 4,5s ou dès qu'on ouvre le chat.
- **Icône Envoyer invisible au hover (FS chat)** : la règle globale `.vds-player button:hover { color: pink }` teintait l'icône blanche en rose sur fond rose → invisible. Fix : exclu `.w2g-fs-send` de cette règle + `.w2g-fs-send:hover { color:#fff; filter:brightness(.92) }`.

### Onglet emoji anime — ÉTAPE 1 (data + onglet, input classique)
- Choix user : images **locales** dans `public/emojis/anime/`, et à terme l'image visible **dans la barre de saisie** (→ contentEditable, ÉTAPE 2). Fait par étapes.
- `public/emojis/anime/` créé. Nouveau `lib/watch2gether/animeStickers.ts` : `ANIME_STICKERS` (`{shortcode,label,src,tags}`) + `ANIME_STICKER_MAP` + `isAnimeSticker`. Liste vide pour l'instant (l'utilisateur dépose les images + ajoute les entrées).
- **Séparé** des `ANIME_EMOJIS` (Twemoji→unicode) : les stickers sont image-only, **exclus de `replaceShortcodes`** (ils restent `:shortcode:` jusqu'au rendu `<img>`). Naturellement exclus car `SHORTCODE_TO_CHAR` ne les contient pas.
- `ChatText` rend les stickers (`ANIME_STICKER_MAP`, ~1.4× la taille emoji).
- `EmojiButton` : 2e onglet « Anime » (🎌, affiché seulement si ≥1 sticker), grille d'images, recherche étendue aux stickers (surfacés en 1er). i18n `party.emojiAnime` (en/fr).

### ÉTAPE 2 (à venir) — composer contentEditable
- Remplacer les `<input>` (panel + FS) par `<div contentEditable>` pour afficher l'`<img>` du sticker inline dans la barre. Sérialiser à l'envoi (`<img data-shortcode>` → `:shortcode:`). Gérer placeholder, Entrée=envoyer, caret, paste texte.

### État
- Branche `dev`. JSON OK. ÉTAPE 1 testable (l'onglet anime apparaît dès qu'on ajoute des stickers + images).

---

## 2026-06-25 (suite 9) — Watch 2gether : revue sécu (rate-limit IP + anti-impersonation invité), hint FS à chaque FS

### Sécurité
- **Brute-force du code à 4 chiffres + spam** : aucun endpoint sauf `event` n'était rate-limité, et `event` keyait sur `user.userId` (un guestId client-fourni → contournable). Ajout de `lib/watch2gether/rateLimit.ts` (`allowByIp`, par IP via X-Forwarded-For, fail-open). Appliqué : `join` (anti-énumération, strict 20/s/IP), `create` (anti room-spam, strict), `stream` (anti-DoS subscribers Redis, strict), `presence`+`event` (backstop, 50/s/IP), `moderate` (strict).
- **Impersonation d'invité / prise de contrôle host** (faille sérieuse) : le `guestId` (secret + seule créance d'un invité) était diffusé en clair dans `senderId` de chaque chat/action ET dans la liste des membres → n'importe quel participant pouvait voler l'identité d'un invité, et si l'host est invité, le kicker/ban/transférer. Fix : `auth.ts` dérive un **id PUBLIC = `g:` + HMAC-SHA256(guestId, secret serveur)** (one-way), utilisé partout (membership, senderId, members). Le secret guestId ne quitte jamais le canal client→serveur. Côté client : on ne calcule plus `g:{guestId}` localement ; le matching « c'est moi » utilise l'**id confirmé par le serveur** (`confirmedId` de join). Nouveau découpage `connectGate` (ouvre la connexion) vs `selfId` (matching). Comptes AniList non concernés (session vérifiée serveur). Secret via `W2G_GUEST_SECRET` (fallback `NEXTAUTH_SECRET`). Migration : transparente (rooms éphémères 6h ; les anciens membres plaintext deviennent des ghosts reapés).
- **`sanitizeName`** : la regex strip bien les contrôles 0x00–0x1F + `<>` (le « space » affiché est un NUL littéral en source — fonctionnellement correct, garde lettres/chiffres/espaces).

### Fixes
- **Hint FS « le chat est à droite »** : montrait via un compteur localStorage plafonné à 3 → épuisé en test → « il manque ». Retiré le cap : le hint s'affiche **à chaque passage en fullscreen** (discret, auto-dismiss 4,5s, disparaît dès qu'on ouvre le chat).

### Leçons / pièges
- **Le secret d'un invité ne doit JAMAIS être diffusé** : tout id broadcast (senderId, members) doit être un dérivé one-way. Le client matche sur l'id confirmé par le serveur, pas sur un id recalculé localement.
- **Rate-limit par IP, pas par id applicatif** quand l'id est client-fourni (guest).

---

## 2026-06-25 (suite 8) — Watch 2gether : icône chapitres grisée (dim inline), hover Inviter

### Décisions / fixes
- **Icône chapitres pas grisée** (alors que le clic était bien bloqué) : le grisage reposait sur la CSS `opacity` via la classe marqueur, peu fiable selon où elle tombait + le rendu de l'icône. Fix : le tagging applique désormais le dim **inline directement sur le bouton** (`opacity:.5; filter:grayscale(1); cursor:not-allowed; pointer-events:none`) quand bloqué, et le **nettoie** quand débloqué — indépendant du cascade CSS. La détection cible le **bouton lui-même** (aria-label/title propres, plus l'ancêtre qui contient juste le tooltip). Effet re-exécuté sur toggle `amPlaybackBlocked` (un changement de state React ne déclenche pas le MutationObserver). `pointer-events:none` neutralise aussi l'ouverture du menu en bonus.
- **Bouton Inviter hover** : utilisait `bg-action/20`+`hover:bg-action/30` → silencieusement ignoré (alpha sur `var()` CSS, cf. suite 6). Fix : `bg-transparent` + `hover:bg-[#E94560]/25` (hex littéral) → rectangle rose au survol, comme Privé.

### Leçons / pièges
- **Pour griser un élément de lib tierce de façon fiable** : poser le style **inline** sur l'élément (gagne sur tout) plutôt que compter sur une règle CSS + classe, surtout quand on n'est pas sûr de la structure DOM.

---

## 2026-06-25 (suite 7) — Watch 2gether : toast inactivité affiché 2× → garde idempotente

### Décisions / fixes
- **« You were removed for inactivity » 2 fois** : au réveil, le re-join SSE ET le beat presence 403 en parallèle ; le garde `!removedRef.current` **racait** (chacun teste AVANT son `await res.json()`, puis `teardown()` pose le flag trop tard → les deux passent). Fix : flag dédié **`rejectedRef`** + helper **`rejectOnce(reason)`** qui pose `rejectedRef.current = true` **synchronement, avant tout await**, puis teardown + `onJoinRejected` une seule fois. Les deux chemins (join + beat) passent par `rejectOnce` → idempotent. `rejectedRef` reset au démarrage d'une session (comme `removedRef`).

### Leçons / pièges
- **Un garde contre la double-exécution doit être posé AVANT le premier `await`**, pas via un effet de bord ultérieur (teardown) — sinon deux callers concurrents franchissent le check pendant la fenêtre async. Un seul helper idempotent (`rejectOnce`) centralise la garde.

---

## 2026-06-25 (suite 6) — Watch 2gether : chapitres = custom element (vrai blocage), hover Privé (bug Tailwind var)

### Décisions / fixes
- **Bouton chapitres TOUJOURS cliquable** : cause trouvée — le bouton chapitres Vidstack est un **custom element `<media-menu-button>`** (pas un `<button>`, pas de `role=button` ni `data-media-menu-button`). Mon `closest("button,[role=button],...")` ne le trouvait donc JAMAIS → ni grisé ni vetoé. Fixes : (1) le scan de tagging inclut maintenant `media-menu-button` + `[aria-label]`/`[title]` ; (2) le veto remonte les **ancêtres par attribut** (aria-label/title contenant chapter/chapitre) **quel que soit le tag** ; (3) veto aussi sur **`pointerup`** (pas que pointerdown/click) ; (4) fermeture du menu au blocage renforcée : Escape + `media-menu.close()` + **pointerdown hors-menu** sur le root (Vidstack ferme au clic extérieur) + passes différées.
- **Rectangle rose manquant au hover Privé** : bug **Tailwind** — `bg-action/25` ne marche PAS car `action = var(--brand-primary, #E94560)` (une CSS var) : Tailwind ne peut pas injecter l'alpha sur une variable → règle ignorée. Fix : `hover:bg-[#E94560]/25` (hex littéral → l'alpha s'applique). Le blanc marchait déjà (`white` est une vraie couleur).
- **Apparition instantanée** : retrait de `transition-colors duration-200` → le rectangle de fond apparaît immédiatement au hover (Public et Privé).

### Leçons / pièges
- **Vidstack rend des custom elements** (`media-menu-button`, etc.) : un `closest("button")` les rate. Pour cibler de façon robuste → remonter les ancêtres par **attribut** (aria-label), pas par type d'élément.
- **`bg-<couleur>/<alpha>` ne marche pas si la couleur est une `var()` CSS** dans Tailwind : l'alpha ne peut s'injecter que sur hex/rgb littéraux. Utiliser `bg-[#hex]/alpha` ou définir la couleur en triplet RGB.

---

## 2026-06-25 (suite 5) — Watch 2gether : kick inactivité côté MOI (au réveil) — panel fermé + toast

### Décisions / fixes
- **Reapé pour les autres mais panel resté ouvert chez moi** : au réveil, la SSE ne re-fire pas toujours `onopen` → `join()` pas rappelé → le rejet « inactivité » n'arrivait jamais côté UI. Et le heartbeat `presence` avalait silencieusement le 403 (`post` renvoie null si !ok). Fix : le **heartbeat presence inspecte la réponse** — un 403 « Removed for inactivity » déclenche le **même flux que join** : `teardown()` + `onJoinRejected("inactive")` → `stripParty()` (ferme le panel room → repasse au lobby) + toast `party.toastInactive`. Plus un beat **immédiat sur `visibilitychange`** (réveil tab/tel) pour que le kick remonte tout de suite, pas après un intervalle.
- **Anti double-toast** : `join()` ET le presence-beat peuvent rejeter en parallèle au réveil → garde `!removedRef.current` avant de rejeter (teardown pose le flag).

### Leçons / pièges
- **La SSE n'est pas un signal de réveil fiable** (l'EventSource peut rester « open » fantôme après une veille). Le **heartbeat presence + `visibilitychange`** est le signal fiable pour détecter un kick au retour.
- **Un `post` qui jette les non-2xx masque les rejets serveur** : pour un endpoint qui peut légitimement 403 (kick), il faut inspecter le status, pas juste `res.ok ? json : null`.

---

## 2026-06-25 (suite 4) — Watch 2gether : chapitres lockout robuste (scan DOM), hover Public/Privé +visible

### Décisions / fixes
- **Bouton chapitres toujours cliquable/non grisé** : mes sélecteurs devinaient le DOM Vidstack (`.vds-chapters-menu-button`, `aria-label="Chapters"`) — faux en FR (« Chapitres ») et fragiles. Nouvelle approche **agnostique du DOM** : un effet **scanne tous les `button/[role=button]/[data-media-menu-button]`** du player et identifie celui des chapitres par **n'importe quel texte identifiant** (aria-label / title / data-tooltip / tooltip enfant) contenant `chapter`/`chapitre` (insensible casse) → pose la classe `.w2g-chapters-btn`. Re-scan via **MutationObserver** (la barre se reconstruit au resize/fullscreen) + passes différées. La CSS grise+désactive `.w2g-playback-blocked .w2g-chapters-btn`. Le **veto capture** utilise aussi cette classe + un fallback texte. Fermeture du menu au blocage via Escape sur le bouton taggé/menus ouverts.
- **Hover Public/Privé pas assez visible** : opacités montées (`hover:bg-action/25` privé, `hover:bg-white/20` public) + `duration-200`, fond transparent par défaut → rectangle de la couleur du texte (rose/blanc) atténué qui apparaît au survol.

### Leçons / pièges
- **Ne pas deviner le DOM d'une lib tierce** (Vidstack) ni se fier à un aria-label anglais (localisé) : scanner par texte multi-source + MutationObserver pour survivre aux reconstructions, et poser sa propre classe marqueur.

---

## 2026-06-25 (suite 3) — Watch 2gether : kick inactivité (vrai fix), hover Public/Privé

### Décisions / fixes
- **Kick inactivité ne marchait pas (timing)** : le flag `:inactive` n'était posé que par `listMembers` (lors d'un reap). Mais dans une room **solo / silencieuse**, rien ne déclenche `listMembers` pendant que le tel dort → flag jamais posé → au réveil `consumeInactive` renvoie false → reconnexion silencieuse. Fix : nouvelle fonction **`reapInactiveMembers(roomId)`** (prune + flag, + transfert d'host si l'host a timeout) appelée **au tout début** de `join` (avant le `consumeInactive`) ET de `stream`. `listMembers` l'appelle aussi en tête (DRY). Donc le reap+flag est garanti AVANT la décision de rejet → 403 « Removed for inactivity » + toast `party.toastInactive`. One-shot conservé (rejoin manuel ok).
- **Hover Public/Privé** (spec user) : fond **transparent** par défaut ; au hover, un **rectangle de la couleur du texte, atténué** apparaît derrière (Privé = `hover:bg-action/20` rose, Public = `hover:bg-white/15` blanc), animé via `transition-colors`. Avant : fond toujours visible.

### Leçons / pièges
- **Un flag posé en effet de bord d'une lecture (`listMembers`) n'est pas fiable** s'il faut qu'il soit prêt à un autre moment : il faut une fonction de reap **explicite** appelée sur le chemin critique (join/stream), pas compter sur un appel incident.
- **Reap = aussi gérer la succession d'host** : sinon une room peut rester sans host actif si l'host est celui qui a timeout.

---

## 2026-06-25 (suite 2) — Watch 2gether : chapitres grisé+fermé (FR), hint v2, zone hover = taille du chat

### Décisions / fixes
- **Bouton chapitres pas grisé en FR** : la CSS ne matchait que `aria-label*="Chapters"` (anglais) ; en FR le bouton est « Chapitres » (via `VIDSTACK_FR`) → jamais grisé. Fix : CSS couvre maintenant **Chapters + Chapitres** + la classe `.vds-chapters-menu-button` + une **classe marqueur `.w2g-chapters-btn`** qu'un effet JS pose à l'exécution (trouve le bouton par aria-label EN/FR, poll ~10s) → grisage garanti quelle que soit la langue / les renommages de classe Vidstack.
- **Menu chapitres ne se fermait pas au blocage** : nouvel effet sur le front montant de `amPlaybackBlocked` → si le menu chapitres est ouvert (`aria-expanded='true'`), on le ferme via **Escape** (dispatch sur le bouton + le menu ouvert + document). PAS un `click` synthétique : le veto capture l'avalerait. + `blur()` en fallback. (`keyDisabled` ne gêne pas : les menus Vidstack ont leur propre handler Escape.)
- **Hint FS « première fois » manquant** : compteur `w2g.fsChat.hintSeen` probablement épuisé (≥3) en test → nouvelle clé **`.v2`** (reset pour tout le monde) + durée 3,6s→**4,5s** pour qu'il soit bien vu au moins une fois.
- **Zone de hover = taille du chat** (spec user) : avant une fine bande de 64px pleine hauteur ; maintenant la zone fait la **footprint du panneau** (`min(364px, 42vw)` × `58vh`, ancrée bas-droite) → survoler là où le chat apparaît l'ouvre. Compromis assumé : cette zone `pointer-events:auto` peut intercepter un clic vidéo en bas-droite, mais c'est exactement la zone d'interaction chat.

### Leçons / pièges
- **aria-label Vidstack est localisé** : tout sélecteur CSS/JS basé dessus doit couvrir EN **et** FR (« Chapters »/« Chapitres »). Le plus robuste : poser sa propre classe marqueur via JS et styler dessus.
- **Fermer un menu Vidstack quand les clics sont vetoés** : utiliser **Escape** (clavier, non vetoé), pas un click synthétique (avalé par le veto capture).

---

## 2026-06-25 (suite) — Watch 2gether : blocage anti-poison, menu chapitres verrouillé, hint sans gap, i18n

### Décisions / fixes
- **Blocage : cible « remote-only » (cause racine du desync)** : le bug « le bloqué met play et reste désync / ne peut plus l'arrêter » venait d'une **course** — quand le flag `amPlaybackBlocked` n'est pas encore arrivé, le `onPlay` local appelait `setTarget(..., paused:false)`, **empoisonnant** la cible ; ensuite `enforceBlocked` lisait `target.paused === false` et le **laissait jouer**. Fix : deux cibles séparées — `target` (dérive, alimentée par events remote **et** nos actions) et **`remoteTarget`** (autoritaire, alimentée **uniquement** par les events remote). `enforceBlocked` n'utilise QUE `remoteTarget` (fallback snapshot) → une action locale d'un bloqué ne peut plus jamais influencer ce vers quoi on le force. Couplé à l'enforce sur front montant + rafale (80/250/600/1200 ms) + boucle 500 ms.
- **Menu chapitres verrouillé pour un bloqué (au niveau event, robuste)** : la CSS `.w2g-playback-blocked` ne suffisait pas (le popup chapitres peut se portaler hors du root, et les classes Vidstack bougent). Ajout d'un **veto en phase capture** (sur le player ET document, `pointerdown`+`click`) qui annule tout clic sur seek bar / play / bouton chapitres / titre de chapitre / items du menu chapitres quand bloqué — avant les handlers Vidstack. Même pattern que l'interception fullscreen iOS. + toast throttlé.
- **Hint FS chat sans « trou » à droite** : le nudge déplaçait toute la pilule vers la gauche → la bande noire décollait du bord droit. Fix : le **fond reste épinglé au bord** (padding droit +), seul le **contenu** (chevron+icône+texte) fait le nudge. Pilule rendue **plus transparente** (`rgba(0,0,0,0.4)`, blur 5px) comme demandé.
- **i18n « Open party chat »** : était en dur → `party.openChat` (en/fr). (`watchTogether` déjà fait à la session précédente.)
- **Kick pour inactivité (au réveil > 5 min)** : avant, un membre reapé par `MEMBER_TTL` revenait silencieusement au réveil. Désormais le reap **stale** (vraie inactivité, pas le cas migration `unknown`) ajoute l'userId au set `:inactive`. `join` : si non-membre et `consumeInactive` (one-shot) → 403 « Removed for inactivity » → page strip `?party` + toast `party.toastInactive`. `stream` : **peek** `isInactive` (sans consommer, le join possède le consume) → 403. Reason `inactive` ajouté à `onJoinRejected`. One-shot : un rejoin **manuel** juste après marche (le flag a été consommé).

### Leçons / pièges
- **Une cible de sync ne doit pas mélanger « ce que je veux » et « ce que le groupe fait »** quand il y a un blocage : l'autorité (remote) doit être isolée, sinon l'action de l'utilisateur bloqué se réinjecte dans la cible et casse l'enforcement.
- **Reap inactivité ≠ reap migration** : ne flagger « inactive » que le cas `stale` (membre réel qui s'est tu), pas le `unknown` (pas de `seen` + offline + pas de profil = junk de migration), sinon on notifierait à tort.
- **Peek vs consume sur un flag one-shot** partagé par 2 routes (join + stream) : une seule route doit consommer (join), l'autre peek (stream), sinon course → le flag disparaît avant d'être rapporté.
- **Verrouiller un contrôle Vidstack = phase capture sur document**, pas (seulement) CSS sur le root : les popups se portalent, les classes ne sont pas garanties.
- **Nudge d'animation collé à un bord** : n'animer que le contenu, garder le fond épinglé, sinon gap visible.

---

## 2026-06-25 — Watch 2gether : présence persistante (veille), blocage robuste, latence, FS chat, i18n, CPU

### Décisions / fixes
- **Présence persistante pendant la veille** (bug user) : un téléphone en veille → heartbeat stoppé → clé présence (TTL 12s) expirée → membre **prune** (avatar disparu) + réordonné en tête au réveil. Refonte du modèle : l'**appartenance est durable** (retrait seulement sur leave/kick/ban, ou filet **MEMBER_TTL = 5 min** sans heartbeat pour un beacon raté/crash). Nouveau stockage Redis : `:profiles` (hash userId→{name,image}, survit à l'expiration présence) + `:seen` (zset last-seen pour le filet 5 min). `listMembers` itère l'**order zset** (jamais re-stampé → ordre stable par ancienneté) et **ne prune plus** sur expiration présence ; il renvoie un flag `online`. `touchPresence` écrit présence (online court) + profile + seen. `isMember` passe de la **clé présence** au **member set** (sinon une room verrouillée 403 le membre endormi à la reconnexion). `oldestMember` (succession host) préfère le plus ancien **en ligne**.
- **Avatar veille grisé** : `m.online === false` → avatar `opacity-40` + title `party.offline` ; redevient plein au réveil. Reste à sa place (ordre inchangé).
- **Bloqué qui met play à l'instant du blocage** (bug user, encore) : en plus de la boucle périodique (now **500ms**), un **effet sur le front montant** de `amPlaybackBlocked` applique l'état correct **immédiatement** + une **rafale** (80/250/600/1200ms) pour avaler les events média async — « avant ET après que le blocage UI ait été appliqué » (demande user). La boucle bloqué **ne bail PAS** sur `applying.current` (sinon un guard coincé laisserait jouer). Host en pause → bloqué repassé en pause sous ~0,5s.
- **Menu chapitres verrouillé pour un bloqué** : un clic sur un titre de chapitre = un seek déguisé. Ajout au lockout CSS `.w2g-playback-blocked` : `.vds-chapters-menu-button`, `[data-media-menu-button][aria-label*="Chapters"]`, `.vds-chapter-title` (`pointer-events:none`).
- **Compensation de latence** : `position` d'un event est échantillonnée à `e.ts` chez l'émetteur → on projette `min(5s, max(0, now-ts)) * rate` (clamp horloge) sur `play`/`seek`/`snapshot`. Cible locale `target{position,paused,rate,at,known}` + `projectedTarget()` ; boucle nudge si dérive > 1.25s en lecture (jamais contre une pause locale).
- **FS chat** : plus d'icône bulle persistante + croix. **Hover bord droit → ouvre** (slide+fade), **mouse-leave → ferme instantanément** (transition inversée 160ms ; grâce 400ms seulement si on tape). **Hint discret** repositionné **en bas-droite, au niveau de la zone de reveal** (avant : centré verticalement) — pilule + chevron gauche + petit nudge horizontal `w2gFsHintNudge` ; plafonné à 3 affichages (`w2g.fsChat.hintSeen`). Bulles éphémères affichées seulement panneau fermé.
- **i18n bouton « Watch together »** : était en dur dans la page watch → `party.watchTogether` (en/fr).
- **Active CPU** (« réglages sûrs ») : SSE self-close 55s→**58s**, heartbeat 15s→**25s**, `maxDuration` reste **60** (Hobby tue au-delà). Presence inchangé (5s).

### Leçons / pièges
- **Présence ≠ appartenance** : une clé à TTL court ne doit PAS porter l'appartenance, sinon toute suspension JS (veille, onglet en fond) « fait quitter » le membre. Séparer : présence = flag online court ; appartenance = set durable + filet last-seen.
- **`isMember` doit lire le member set durable** (pas la présence) pour le gate des rooms verrouillées, sinon un membre endormi est 403 chez lui au réveil.
- **`order zset` jamais re-stampé** = ordre d'affichage stable à travers offline/online ; c'est le `zadd NX` qui le garantit (un `zadd` sans NX au heartbeat réordonnait au réveil).
- **Sync event-only insuffisant** : réconciliation périodique (client, 0 CPU serveur) + **enforce sur le front montant** du blocage pour la course play-à-l'instant-du-blocage.
- **`maxDuration > plan cap` = fonction tuée**, pas étendue.

### État
- Branche `dev`. ⚠️ Nouveau schéma Redis (`:profiles`, `:seen`) : rétro-compatible (membres sans `seen` gardés tant qu'online/profil présent). Typecheck non lancé localement (TS absent de l'env) — à vérifier au build.

---

## 2026-06-24 (suite 5) — Watch 2gether : désync blocage, FS chat refonte, contrôles

### Décisions / fixes
- **Inversion host ↔ bloqué** : le revert de `enforceBlocked` utilisait `withGuard` (120ms). Mais `video.currentTime = pos` déclenche un `seeked` **asynchrone** qui tombait *après* l'expiration du guard → re-broadcast → l'hôte se prenait la position/état du bloqué (« inversé »). Fix : suppression dédiée de **500ms** qui couvre tout le revert + chaque handler `on*` bail **en amont** si `amPlaybackBlocked` (plus aucun broadcast possible en état bloqué).
- **PiP / sortie fullscreen non cliquables** : la **zone de hover droite** du FS chat (`height:100%`) recouvrait la barre de contrôle en bas à droite (PiP/fullscreen) et avalait les clics. Fix : la zone s'arrête au-dessus de la barre (`calc(100% - 104px)`), et tout le panel FS est ancré `bottom:96`. (La corrélation « avec le blocage » était fortuite — le bug existait dès que le FS chat était actif.)
- **FS chat refonte** (spec user) : icône chat avec une **croix en bas-à-gauche**. Hover sur l'icône → chat + composer. Clic sur la croix → masqué « pour de bon » (persisté `w2g.fsChat.hidden`), réapparaît **uniquement** au survol du bord droit.
- **Noms toujours roses** en FS chat (avant : rose seulement pour soi).

### Leçons / pièges
- **Un overlay plein écran `pointer-events:auto` mange les contrôles du player**. Toute UI superposée au player en fullscreen doit laisser une bande libre en bas (≥ hauteur de la barre Vidstack) sinon PiP/fullscreen/volume deviennent incliquables.
- **`currentTime=` → `seeked` est async** : un guard de suppression doit durer plus longtemps (~500ms) que la fenêtre d'application synchrone, sinon l'event de revert fuit et se re-broadcast.

### État déployé
- Commit `dev` : `e0eeb81`. Typecheck OK, ESLint OK.

---

## 2026-06-24 (suite 4) — Watch 2gether : lockout lecture fort, FS chat, départs/host

### Décisions prises
- **Blocage de lecture « fort »** : 4 couches qui se complètent — (1) `keyDisabled` Vidstack (clavier : espace/flèches), (2) classe CSS `.w2g-playback-blocked` qui met `pointer-events:none` sur `.vds-time-slider` (barre + chapitres) et `.vds-play-button`, (3) le garde sur l'élément `<video>` qui *revert* tout changement d'état sur le snapshot autoritaire, (4) refus du changement de serveur (lecteur) côté page (`handleServerChange` early-return + toast). Le changement de serveur est une action de lecture → traité comme telle.
- **FS chat** : ré-ajout du bouton bulle flottant + une **croix** qui masque le chat définitivement (persisté en localStorage `w2g.fsChat.hidden`) ; le bouton bulle le ramène. Strings traduites (`party.fsNoMessages/fsHide/fsShow` + placeholder/`party.message`).
- **Départs plus rapides** : `PRESENCE_TTL` 30s→**12s**, heartbeat client 15s→**5s** (≥2 refresh par fenêtre TTL). Un onglet fermé (beacon `pagehide` pas garanti) disparaît en ~12s au lieu de 30s.
- **Prune+broadcast throttlé** : `/presence` recompute et **rediffuse** la liste des membres au plus une fois / ~6s par room (`acquireThrottle` = `SET NX EX`), pour que les partis disparaissent **pour tout le monde** sans attendre une action (join/moderate). Le bouton Quitter reste instantané (publie direct).
- **Promotion host nettoie les sanctions** : `setHost` `srem` le mute + le playback-block du nouvel hôte (succession au départ OU transfert explicite), côté serveur, plus un miroir optimiste dans `transferHost`.

### Leçons / pièges
- **Espace n'était pas rattrapé par le garde `<video>`** : Vidstack a son propre keyboard handler → il fallait `keyDisabled`, le garde sur les events `<video>` ne suffit pas pour le clavier.
- **`pointer-events:none` sur le slider** suffit pour neutraliser barre **et** chapitres (les `vds-slider-chapter` sont enfants du `vds-time-slider`).
- **Le throttle Redis** (`SET key 1 EX n NX`) est le moyen le plus simple d'avoir « une action par fenêtre, peu importe combien de clients tapent » sans état applicatif.

### État déployé
- Commit `dev` : `c1cd2fa`. Typecheck OK, ESLint OK.

---

## 2026-06-24 (suite 3) — Watch 2gether : audit sécurité + revue

### Contexte
Passe de revue : nettoyer les logs de debug, chercher bugs/exploits, fixer. Tout sur le Redis `w2g:` ; les routes API sont la surface d'attaque.

### Exploits / bugs trouvés et corrigés
- **Émission d'events sans avoir rejoint** (le plus sérieux) : `event.ts` ne vérifiait que `roomExists`. Comme le code de room fait **4 chiffres** (brute-forçable, 10 000 valeurs), n'importe qui pouvait spammer le chat ou piloter la lecture d'une room sans la rejoindre. Fix : gate `canEmit(roomId, userId)` (présent dans le member set **ou** présence active — tolérant aux trous de heartbeat d'un vrai membre, mais bloque un non-membre) + rejet des bannis. Le créateur est désormais `addMember` dès `create.ts` pour pouvoir émettre avant le round-trip `join`.
- **Contournement du ban/lock via `/presence`** : `touchPresence` ajoute au member set, donc un POST direct sur `/presence` permettait à un banni / exclu d'une room privée de se réinscrire en contournant les gardes de `join`. Fix : `presence.ts` applique les mêmes gardes (ban + locked-non-member).
- **XSS stocké (défense en profondeur)** : `guestName` était juste tronqué, pas sanitisé, et il est diffusé/persisté. Fix : `sanitizeName()` strippe les caractères de contrôle ASCII (`\x00-\x1f`, `\x7f`) et `< >` avant le cap à 24 (React échappe déjà au rendu, mais ceinture+bretelles).
- **Valeurs numériques non bornées** : `position`/`rate` acceptés tels quels → un client pouvait écrire `position: 1e9`/`NaN` dans le hash. Fix : `clampNum()` (position 0–24h, rate 0.25–4) + cap des strings (`epiNumber`/`server`/`aniId`).
- **`roomId` non validé** : utilisé direct dans les clés Redis sans borne de taille/format. Fix : `isValidRoomId()` (`^\d{4,5}$`) appliqué dans toutes les routes client (`event/join/presence/leave/moderate/stream`) → un id géant/malformé est rejeté en 400 avant de toucher Redis.

### Leçons / pièges
- **`isMember` = présence active vs member set** : pour le **lock** (qui doit interdire le retour après départ) on veut la **présence active** ; pour le **droit d'émettre** on veut le **member set** (tolérant aux blips de heartbeat, sinon on droppe des events légitimes). Deux besoins distincts → deux fonctions (`isMember` présence, `canEmit` set∪présence).
- **Caractère de contrôle littéral dans une regex** : l'éditeur affichait `/[\x00-\x1f\x7f<>]/` comme `/[ -<>]/` (le `\x00` rendu en espace) → fausse alerte de « range dangereuse ». Vérifié au niveau octets (`python repr`) que la classe est bien `\x00-\x1f\x7f<>`, pas une plage `space..<`.
- **Le créateur n'était pas membre** tant que son `join` SSE n'avait pas tourné → avec le nouveau gate `canEmit`, ses premiers events auraient été droppés. D'où l'`addMember` dans `create.ts`.

### État déployé
- Logs de debug temporaires : tous retirés (vérifié, ne restent que des `console.error` de catch). Typecheck `tsc --noEmit` OK, ESLint OK.

---

## 2026-06-24 (suite 2) — Watch 2gether : latence (optimistic UI), enforcement, gating ban/privé

### Contexte
Retours : modération + chat « réagissent ~1s après », blocage de lecture non appliqué côté bloqué, exclu/banni pas vraiment expulsés, room privée invisible aux non-membres.

### Décisions prises
- **Optimistic UI partout** ([useWatchParty.ts](lib/watch2gether/useWatchParty.ts)) : la latence vient du round-trip **client POST → Redis publish → Pub/Sub → SSE → client** (~1s, pire sur Hobby). On applique donc l'effet **localement d'abord**, l'event SSE qui suit ne fait que confirmer.
  - Modération : `kick/ban` retirent le membre localement ; `mute/blockPlayback` patchent le flag ; `transferHost` réassigne la couronne ; `setFlags` patche le snapshot.
  - **Chat** : message affiché tout de suite avec id temp `tmp-…` + `pending:true` (rendu en `opacity-50`). `dispatch` remplace le placeholder par l'écho serveur (match `pending && userId && text`). **Timer de grâce 5s** qui drop le placeholder si jamais confirmé (cas muté → 403 silencieux). Le nom d'affichage est résolu via `membersRef` (pas besoin de le passer en prop).
- **Enforcement du blocage de lecture côté bloqué** ([UniversalPlayer.tsx](components/watch/primary/UniversalPlayer.tsx)) : avant, le serveur rejetait juste le broadcast → l'utilisateur lisait quand même *chez lui*. Maintenant `onPlay/onPause/onSeeked/onRate` appellent `enforceBlocked()` qui **revert** sur le snapshot autoritaire (re-seek + play/pause) et toast throttlé. Lecture de `amPlaybackBlocked` via `partyRef` (le `party` change à chaque chat → l'effet de sync ne dépend que des callbacks stables, donc ref obligatoire).
- **Gating ban / room privée** : `stream.ts` **403** désormais pour un banni (sinon le snapshot initial *flashait* la room) et pour un non-membre d'une room `locked`. Mais EventSource n'expose pas le status HTTP sur erreur → on ne peut pas distinguer un 403 d'une coupure transitoire. Donc **`join()` eager au mount** (fetch maison qui lit le status) : 403/404 → `onJoinRejected("banned"|"locked"|"notfound")` → la page strippe `?party` + toast. Idem si on retape le code d'une room où on est banni.

### Leçons / pièges
- **Pub/Sub = fire-and-forget, pas de replay.** Si le client SSE est en reconnexion au moment d'un event `kick`, il le **rate** définitivement. Le `ban` est robuste (flag persistant vérifié au `join`/`stream`) ; le `kick` est « soft » (rejoinable) → si l'event est manqué, l'exclu reste. Acceptable par design du kick, mais à garder en tête : **tout état qui doit survivre à une reconnexion doit être un flag Redis vérifié au join, pas seulement un event.**
- **EventSource ne donne pas le code HTTP** sur `onerror` (juste « erreur »). Pour détecter un refus (403 ban/privé) il faut un **POST `join` séparé** qui lit le status ; ne pas compter sur le flux SSE pour ça.
- **Effet de sync player à deps stables** : il ne dépend que de `party.broadcast/onRemote/applyingRemoteRef` (sinon il se re-bind à chaque chat et drop des events). Donc tout flag dynamique lu dedans (`amPlaybackBlocked`) passe par une **ref** mise à jour à chaque render, jamais par la closure.
- **`UniversalPlayer` n'avait pas `toast`** : import `sonner` ajouté pour le message de blocage.
- **Badge mute en bas-à-droite** : OK car un membre muté n'est jamais hôte → pas de collision avec la couronne (même coin).

### État déployé
- Commit `dev` : `fc54960`. Typecheck `tsc --noEmit` OK, ESLint OK. Build Vercel sur `dev`.

### Raffinements suivants (`cefa55c`)
- **Toggle Public/Privé qui « flappe » au spam** : double cause = (1) optimistic local + (2) events `settings`/`snapshot` en vol qui reflètent encore l'ancien état. Fix combiné : **cooldown 700ms** sur le bouton + **`pendingLockRef`** (valeur voulue mémorisée 4s) ; `reconcileSnapshot()` force la valeur voulue tant que le serveur n'a pas confirmé, puis se nettoie. Tout snapshot adopté (join/snapshot/settings) passe par ce reconcile.
- **Emoji du picker affiché en texte** : le picker insère un `:shortcode:` via `insertEmoji` (setText direct, hors `onChange`) → `replaceShortcodes` ne tournait pas dessus. Fix : `insertEmoji` applique aussi `replaceShortcodes`.
- **Chat « grisé puis normal »** : on a retiré le dimming `pending` (le message optimiste s'affiche déjà instantanément ; l'écho serveur le remplace en silence). Plus d'effet visuel.
- **Ring rose absent pour soi (invité)** : `effectiveUserId` (guest) se résout en `useEffect`, donc `myId` est `null` au premier rendu. Fix : on capture l'**id confirmé par le serveur** (`join` renvoie `me.userId`) dans `confirmedId`, et `myId = effectiveUserId || confirmedId`. Sert aussi à `isHost`/`amMuted`/`amPlaybackBlocked`.
- **Message « tu es muté » au chat** : l'input n'est plus `disabled` quand muté → `submit` montre un toast (sinon une box désactivée ne déclenche aucun feedback au clic).

---

## 2026-06-24 (suite) — Watch 2gether : modération avancée, i18n, polish UI/UX

### Contexte
Plusieurs passes de raffinement sur le panel de groupe et le chat, suite à des retours visuels (screenshots). Sujets : modération hôte étendue, internationalisation (FR/EN), picker emoji, chat, et pas mal de détails CSS.

### Décisions prises
- **Modération par membre, pas par room.** L'ancien flag global `playbackLocked` (room) a été **remplacé** par un **blocage de lecture par personne** (set Redis `w2g:room:{id}:pbblock`, comme les mutes/bans). L'hôte bloque un membre précis ; [event.ts](pages/api/v2/watch2gether/event.ts) rejette ses events playback en 403. Actions modération désormais : `kick/ban/mute/unmute/block-playback/unblock-playback/transfer-host/set-flags` ([moderate.ts](pages/api/v2/watch2gether/moderate.ts)). Seul `locked` (room privée) reste un flag room.
- **i18n complet** : nouveau namespace `party` dans [locales/en.json](locales/en.json)/[locales/fr.json](locales/fr.json), panel câblé à `useTranslation` (react-i18next, instance unique [lib/i18n/config.ts](lib/i18n/config.ts)). Picker emoji traduit **sauf les noms d'emoji**. Toggle room = **Public / Privé** (icônes planète/cadenas).
- **Nom invité localisé** ([guest.ts](lib/watch2gether/guest.ts)) : `i18n.t("party.guest")` → « Invité » en FR. **Migration** de l'identité déjà stockée (`Guest 1234` → `Invité 1234`) à la lecture, car le nom est persisté en localStorage et diffusé aux autres.
- **`:pog:` → emoji inline** : `replaceShortcodes` (dérive le char unicode depuis le codepoint Twemoji) appliqué dans `onChange` des deux composers → le shortcode se convertit dès que le `:` final est tapé. (Le picker, lui, garde les images custom anime.) Le champ `<input>` ne peut pas héberger d'images, donc seuls les 16 customs ↔ unicode sont convertis au typing.
- **Ordre des membres = ordre d'arrivée** (zset `order`), plus vieux à gauche. `listMembers` itère le zset.

### Leçons / pièges
- **Bug d'ordre des membres** (icône qui « saute en premier » après un message) : `touchPresence` (heartbeat) ré-`sadd`ait le membre au Set mais **pas** au zset d'ordre. Après un stale-prune (`zrem`), le membre revenait sans timestamp d'ordre → ré-inséré avec un **nouveau** temps (donc plus « ancien » → à gauche). **Fix** : `touchPresence` fait aussi `zadd NX` sur le zset d'ordre. Toujours garder les deux structures en phase.
- **Menu de modération + `overflow-hidden`** : un menu inline au survol sous l'avatar est **clippé** par le `overflow-hidden` du panel root. Une version portail (anti-clip) résout le clip mais réintroduit le **gap de survol** (le curseur traverse un vide → le menu disparaît). Compromis retenu : menu **inline au survol** + **retrait de `overflow-hidden`** sur le root (les coins arrondis tiennent car les enfants sont transparents ; seul le scroll du chat clippe, via son propre `overflow-y-auto`).
- **Tooltip natif `title`** s'affiche **sous** le curseur, non repositionnable → tooltip custom (`group-hover`, `z-[100]`) au-dessus de l'avatar, et `noTitle` sur `MemberAvatar` pour couper le natif.
- **Ring « c'est moi »** : le faire venir **uniquement** de `MemberAvatar` (`highlight`), pas d'un ring sur la box parente en plus — le double-ring trompait (semblait absent pour les joiners). Même chemin de rendu pour hôte et joiners.
- **Chat bas→haut** : `flex flex-col justify-end` dans un conteneur scrollable `min-h-full` ; le `ref` d'auto-scroll doit être sur le **conteneur scrollable**, pas sur le flex interne.
- **Spread de `Set` (`[...set]`)** casse le typecheck (target < es2015) : utiliser `Array.from`/un `for…of`/`.has()`, pas le spread.

### État déployé
- Commits `dev` : modération v1 `9168a46`, fixes+modération étendue `945fb3f`, portail→inline + emoji inline `d5ef57c`, polish (tooltip/rings/chat/i18n) `94d29da`. Typecheck local **OK** (`tsc --noEmit`, `node_modules` présent désormais). Build Vercel sur `dev` (dev.aniscroll.com).

---

## 2026-06-24 — Watch 2gether (visionnage synchronisé) : MVP → v2

### Contexte
Feature « Watch 2gether » : créer/rejoindre une room et regarder un épisode en sync (play/pause/seek mirrorés), avec chat, présence, sync d'épisode/serveur, modération, et chat en plein écran. Contrainte forte : **pas de Vercel KV/DB** — tout sur le **Redis existant** (`REDIS_URL`, [lib/redis.ts](lib/redis.ts)). Vercel = serverless, donc **pas de serveur WebSocket** persistant.

### Décisions prises (transport)
- **Redis Pub/Sub + SSE** (serveur→client) + **POST HTTP** (client→serveur). Pas de WS.
- **SSE = connexion ioredis dédiée par flux** ([lib/watch2gether/subscriber.ts](lib/watch2gether/subscriber.ts)) : une fois en mode `subscribe`, une connexion ne peut plus faire de commandes → **ne jamais** appeler `.subscribe()` sur le client `redis` partagé.
- **`maxDuration: 60` sur [stream.ts](pages/api/v2/watch2gether/stream.ts)** + auto-close à 55s : Vercel coupe les fonctions longues, donc on ferme proprement avant et le client `EventSource` se reconnecte (re-`join` = re-sync). Sur Hobby (~10s) ça reconnecte plus souvent, mais ça marche.
- **État room dans Redis** (préfixe `w2g:`) : Hash snapshot (source de vérité pour les late joiners), Set membres, présence par clé à TTL court (heartbeat 15s, TTL 30s), List chat plafonnée, channel Pub/Sub. Voir [lib/watch2gether/redisRoom.ts](lib/watch2gether/redisRoom.ts).

### Décisions produit
- **Tout le monde contrôle** la lecture. Anti seek-war : echo-suppression par `senderId`, garde `applyingRemote` autour de l'application d'un event distant, tolérance de seek ~0.75s.
- **Ouvert aux non-connectés** : identité invité stable en localStorage ([lib/watch2gether/guest.ts](lib/watch2gether/guest.ts)), id serveur préfixé `g:`. La session AniList prime toujours ([lib/watch2gether/auth.ts](lib/watch2gether/auth.ts)).
- **Room id = code à 4 chiffres** (`allocateRoomId`, anti-collision) : sert à la fois d'URL `?party=` et de code à taper. Création → **copie auto** du lien d'invite.
- **Rôles** : hôte = créateur ; **kick** (rejoinable) / **ban** (jusqu'à dissolution de la room). Le ban vit dans un Set lié au TTL de la room → une room recréée avec le même code repart propre. **Transfert d'hôte au membre le plus ancien** (zset d'ordre de join) quand l'hôte part.
- **Emojis** : PicMo en **import dynamique** (client-only, sinon crash SSR) + emojis anime customs via **URLs distantes** ([lib/watch2gether/animeEmojis.ts](lib/watch2gether/animeEmojis.ts), rien à bundler). `:shortcode:` rendus en `<img>` par [ChatText.tsx](components/watch/party/ChatText.tsx).
- **Chat plein écran** : bulles éphémères à droite (fade ~6s), cachées après inactivité, re-révélées au survol du bord droit, composer intégré. Monté via `createPortal` **dans l'élément du player** (pas `document.body`) pour rester visible en fullscreen ([FullscreenChat.tsx](components/watch/party/FullscreenChat.tsx)).

### Architecture / points d'intégration
- Hook orchestrateur [useWatchParty.ts](lib/watch2gether/useWatchParty.ts) : EventSource + reconnexion, heartbeat présence, `sendBeacon` au départ, `broadcast`/`onRemote`, `leave`/`kick`/`ban`, `hostId`/`isHost`, `onSelfRemoved` (kick/ban/leave → la page retire `?party`).
- Player [UniversalPlayer.tsx](components/watch/primary/UniversalPlayer.tsx) : prop `party` optionnelle + effet de sync **isolé** (la logique progress/resume existante est intacte). Monte `FullscreenChat`.
- Page [watch/[...info].js](pages/en/anime/watch/%5B...info%5D.js) : hook activé par `?party`, sync épisode **et serveur** (events `episode`/`server` + snapshot), redirection cross-anime via snapshot (One Piece → JJK ep5), panel avec gap + hauteur calée sur le player (ResizeObserver) + fermable (pastille de réouverture).
- Events : `play/pause/seek/rate/position/episode/server/chat/presence/snapshot/host/kick/ban`, tous via `publishEvent` → SSE → `dispatch`/`onRemote`.

### Leçons / pièges
- **Imports `@/pages/*` ne résolvent pas** : le `tsconfig` ne mappe que `@/components|utils|lib|prisma`. Les routes API doivent importer `authOptions` en **relatif** (`../../pages/api/auth/[...nextauth]`).
- **Identité invité résolue en `useEffect`** (lecture localStorage), pas en `useMemo`, sinon mismatch SSR/CSR. La connexion SSE/présence attend que l'identité soit prête avant d'authentifier.
- **Remote bypass** : un changement de serveur reçu applique `setActiveServer` **directement** (pas `handleServerChange`) pour ne pas re-broadcaster en boucle.
- **PicMo** : popup ancré au `body` → en plein écran l'**emoji picker** peut ne pas s'afficher (la saisie texte marche). Limitation connue, acceptable.

### État déployé / à faire
- **Pas typecheck en local** (pas de `node_modules`/node dans l'env de dev) — `next build` typecheck sur Vercel. **`npm install` requis** : ajout de `@picmo/popup-picker`.
- Les URLs d'emojis anime (emoji.gg) sont un jeu de départ ; si 404 → l'emoji ne s'affiche juste pas, à remplacer par des images perso.
- Commits sur `dev` : MVP `26b7c25`, invités+codes `f505979`, v2 (menu/rôles/fullscreen/emojis/serveur) `67eb6fb`.

---

## 2026-06-21 (suite 3) — Reco « Pour toi » : perf réseau + meilleurs candidats

### Contexte
« Améliore l'algo et rends-le bcp plus rapide » — en gardant un œil sur l'usage Vercel/Turso/Upstash.

### Décisions prises
- **Le goulot est réseau, pas CPU.** Le moteur (`engine.ts`) tourne en µs ; tout le temps part dans les fetch AniList. Donc l'optimisation = moins de payload + parallélisme + cache, pas du tuning de boucle.
- **Deux jeux de champs** ([lib/recommend/fetchMeta.ts](lib/recommend/fetchMeta.ts)) : `LIGHT_FIELDS` (profil + walk franchise sur **toute** la liste, ~300 ids — sans `description`/`bannerImage`/`recommendations`) et `FULL_FIELDS` (uniquement les ~10 candidats **affichés**, hydratés une fois à la fin). Divise par ~3 la bande passante AniList sur les grosses listes.
- **Batches parallèles** : `fetchMetaByIds` fait ses pages de 50 en `Promise.all` au lieu d'un `for await` séquentiel → une liste de 300 = latence d'**1** aller-retour, pas 6. **Même nombre de requêtes** (donc pas de hausse d'usage), juste en parallèle.
- **Cache « groundwork » séparé** ([pages/api/v2/recommend.ts](pages/api/v2/recommend.ts)) : le profil + le set d'exclusion franchise + la map collaborative ne dépendent **que de la liste**, pas du `round`. Mis en cache Redis sous `recommend:ground:v2:<sig>` (TTL 6 h). Un *regenerate* / changement de round skippe tout le pass liste → **moins** d'appels Upstash/AniList, pas plus.
- **Meilleurs candidats** (le gros levier qualité) :
  - Graine collaborative **élargie** : recos AniList de **tout** anime nettement au-dessus de la moyenne perso (ou rewatché), pas seulement score ≥ 8. Gratuit (les `recommendations` voyageaient déjà dans la passe liste).
  - **Combos de genres ANDés** (`genreCombos`) : AniList `genre_in` fait un AND, donc `[Action, Comedy]` sort les anime qui sont **les deux** — bien plus ciblé que le top-4 en OR (qui ne renvoie que les blockbusters de chaque genre). Top-1 seul (filet large) + paires des genres forts (filets serrés), capé à 5 requêtes parallèles.
- **Scoring affiné** : bonus **récence** (≤2 ans +0.2, ≤5 ans +0.1), anti-blockbuster **adaptatif** (pénalité log-scalée selon l'écart de popularité vs ce que l'user adore, plafonnée), micro-pénalité **synopsis absent** (tie-breaker, jamais zéro).

### Leçons / pièges
- **Paralléliser ≠ plus d'usage.** On garde le même nombre de requêtes AniList, on les lance juste ensemble. Le cache groundwork **réduit** l'usage sur les rerolls. Donc « plus rapide » et « moins cher » vont ensemble ici.
- **Hydrater à la fin** est clé : scorer 200+ candidats avec les champs lourds gâcherait de la bande passante pour 190 qu'on n'affichera jamais. On score en LIGHT, on diversifie, **puis** on charge FULL les 10 survivants.
- `for...of Object.entries` et `Math.max(...Array.from())` compilent (cible ≥ es2015 / downlevelIteration OK) — `tsc --noEmit` clean.

### État déployé / à faire
- `tsc` + `next lint` clean. À tester sur une vraie liste : vitesse ressentie (surtout 1er chargement froid + regenerate), et si les propositions « donnent plus envie » avec les combos de genres + graine collaborative élargie.

---

## 2026-06-21 (suite 2) — Reco « Pour toi » : algo v2 + bug franchise transitif

### Le bug (révélateur)
On proposait **Mob Psycho S3 alors que S1 est dans la liste** (et pas finie). Deux causes :
1. `watchedMeta` ne fetchait que COMPLETED/CURRENT/REPEATING/DROPPED → une S1 **PAUSED/PLANNING** ne chargeait jamais ses `relations` → sa franchise n'était pas exclue. **Fix** : fetch metadata de **toute** la liste.
2. AniList ne lie que les saisons **adjacentes** (S1↔S2, S2↔S3). Mon exclusion faisait **1 seul hop** → S3 (2 hops) passait. **Fix** : **walk transitif (BFS, depth 4)** sur les relations de franchise jusqu'à clôture du composant connexe ; `isDiscoverable` vérifie aussi les relations du candidat vers tout id exclu.

### Algo v2 (les propos ne donnaient pas envie)
- **Affinité relative à la moyenne** de l'utilisateur (`scoreToAffinity(score, mean)`) : un 7 chez quelqu'un qui note 6 ≠ chez qui note 8. Pré-passe pour la moyenne.
- **Tags dominants** (W.tag 0.8→1.5) : ce sont le signal de « feel » le plus granulaire d'AniList. Bonus de **densité de tags** (combien des tags forts du candidat l'user aime). Genres réduits (broad).
- **Pénalités de tags détestés** (pas que genres).
- **CURRENT amorti par la progression** (ep1 = preuve faible × 0.4).
- **Floor de signal** : un candidat sans match contenu NI communauté est ramené à ×0.15 (le filler de page-genre ne peut plus dépasser un vrai match thématique).
- Raisons réordonnées : tags d'abord (plus spécifiques).

### Autres
- **Traduction préchargée** : `prefetchTranslations` sur les 10 synopsis dès l'arrivée du lot (plus de flash anglais au reroll).
- **Fenêtre agrandie** : 760px (sm) / 880px (lg), poster 180×256, + meta line (format · saison · studio), chips de tags, description 5 lignes.

### À vérifier
- Plus aucune suite d'un anime en liste (tester Mob Psycho). Pertinence accrue (tags). `tsc`+`lint` clean.

---

## 2026-06-21 (suite) — Moteur de recommandation « Pour toi »

### Contexte
Bouton qui analyse toute la liste AniList (animes vus, notes, vitesse de visionnage, repeats, statut) pour proposer un nouvel anime. Deux entrées : sur `/discover` (bouton ✨ à gauche de l'engrenage) et sur le profil (owner only). Deux modes : **Tous** (hors liste, découverte) et **Depuis mes prévus** (re-classe les PLANNING par affinité).

### Architecture
- **Engine pur** ([lib/recommend/engine.ts](lib/recommend/engine.ts)) sans réseau, testable : `buildProfile` (vecteur de goût par genre/tag rank-pondéré/studio/format/décennie ; signaux = note→affinité signée, repeat, **vitesse de binge** via `completedAt-startedAt`/épisodes, DROPPED = négatif) → `scoreCandidate` (blend contenu 0.5 / communautaire 0.3 / qualité 0.2 + pénalités genres détestés + mismatch de niche + bonus suite/studio, **avec raisons structurées**) → `diversify` (MMR-like sur genres).
- **Métadonnées** ([lib/recommend/fetchMeta.ts](lib/recommend/fetchMeta.ts)) : batch de 50 via `anilistFetch` (cache Redis partagé + rate-limit déjà gérés) ; `recommendations` AniList = signal collaboratif, `relations` = détection des suites.
- **API** ([pages/api/v2/recommend.ts](pages/api/v2/recommend.ts)) : POST `{ list, mode }` (le client envoie sa liste cachée — pas de re-auth serveur). Candidats = reco AniList des animes adorés ∪ suites non vues ∪ top-genres highly-rated. Cache Redis par **hash de signature de liste** (15 min) → reroll instant.
- **UI** ([ForYouPanel.tsx](components/discover/ForYouPanel.tsx) + [forYou.module.css](components/discover/forYou.module.css)) : modal portée à `<body>`, 1 carte + raisons en prose ([recReasons.ts](components/discover/recReasons.ts)) + toggle Tous/Prévus + bouton « Une autre ».

### Décisions
- **Serveur + Redis** (vs tout client) : l'analyse fetch beaucoup de métadonnées ; le cache par-liste + le cache partagé d'`anilistFetch` évitent le rate-limit AniList et rendent le reroll instantané.
- **Le client POST sa liste** plutôt que re-fetch serveur avec le token : réutilise `getUserList` (déjà caché), pas de plomberie d'auth serveur.
- **Pas de listes custom** dans le scoring (comme le swipe) — juste les statuts AniList.

### Pièges
- **TS target < es2015** : pas de spread sur `Map`/`Set` iterators → `Array.from(...).forEach`.
- **CSS modules** : `ring:` est une utility Tailwind, PAS du CSS valide → `border:`.
- `useTranslatedText` réutilisé pour traduire le synopsis de la reco (déjà préchauffé ailleurs).

### À vérifier
- `tsc` + `next lint` clean. Tester avec une vraie liste : pertinence des recos, raisons cohérentes, reroll, mode prévus.
- Liste vide / non connecté → messages d'état gérés.

---

## 2026-06-21 — Page Discovery : portage du feed swipe vertical (référentiel MAUI → React)

### Contexte
Remplacement du bouton navbar « Anime » par « Discovery » (→ `/en/discover`) et réécriture de la page pour matcher le feed swipe du repo `S00295653/AniScroll` (mon ancien projet **.NET MAUI / Blazor**, pas React). Le code C#/Razor ne se copie pas → **portage** du comportement + look, pas du code. La page avait déjà un stack Tinder ; remplacé par le feed plein écran à défilement **vertical** (style TikTok) où le swipe **horizontal** assigne un statut AniList configurable.

### Décisions / architecture (`dev`)
- **Feed vertical** ([pages/en/discover.tsx](pages/en/discover.tsx)) : `currentIndex` sur liste virtualisée (fenêtre ±5), `translateY((i-currentIndex)*vh)`. API existante `/api/v2/discover/[page]` (Redis) réutilisée + préchargement.
- **Hook drag** ([useCardDrag.ts](components/discover/useCardDrag.ts)) : port de `scroll-helpers.js` — pointer/touch/molette, lock d'axe, paint RAF-throttlé, fly-off Tinder, snap-back.
- **Carte plein écran** ([ScrollCard.tsx](components/discover/ScrollCard.tsx)) + [scroll.module.css](components/discover/scroll.module.css) : port de `Index.razor` + `card.css`. `memo()` (voir pièges).
- **Swipe Settings** ([ScrollerSettingsPanel.tsx](components/discover/ScrollerSettingsPanel.tsx)) : layout preview (zones gauche/droite + squelette) + bottom-sheet picker. **Statuts seuls** (pas de listes custom — pas de backend équivalent ici). Statuts écrits via `saveMediaListEntry`, persistance localStorage ([swipeSettings.ts](lib/discover/swipeSettings.ts)).
- **Undo** : bouton sur le toast (sonner) + badge sur la carte au scroll-back ; revert via `DeleteMediaListEntry`.
- **Réutilisations clés** : `useTranslatedText` + `prefetchTranslations` pour traduire/précharger les synopsis ; `animeHref(id, clickTarget)` + `useClickTarget()` pour respecter le réglage *Navigation → Page de visionnage/info* sur le clic titre/poster.

### Leçons / pièges (debug swipe, le gros du temps)
- **Snap-back ajoutait quand même en liste.** Le hook signalait `axis:"horizontal"` pour TOUT relâchement ; la page appliquait l'action sans vérifier le seuil. Fix : sous le seuil → le hook renvoie `axis:"none"` (no-op page). Seuil monté 85→120px.
- **« Image passe derrière sur les bords ».** 3 causes empilées : (1) `overflow:visible` que j'avais mis sur la carte la laissait déborder sur la voisine → retiré, la **carte** (`overflow:hidden`) est la limite de clip ; (2) `.imageSection { z-index:20 }` créait un contexte d'empilement qui échappait au clip → baissé à 3 ; (3) le `.contentWrapper` centré/étroit avec `overflow:hidden` rognait le poster au bord du wrapper (bande) → repassé `visible`. Fond de carte **opaque** pour que rien ne transparaisse.
- **Swipe saccadé en partant SUR l'image.** Le poster se transforme et glisse **sous le curseur** → les `pointermove` partaient à l'élément maintenant sous le curseur. Fix : **`setPointerCapture`** sur le container. (En partant à côté ça marchait par accident.)
- **Régression de fluidité = re-render.** `useTranslatedText` met à jour l'état quand la trad arrive → **toutes les cartes** se re-rendaient en plein swipe et entraient en conflit avec les écritures DOM du hook. Fix : `memo(ScrollCard)`.
- **Garder `data-dragging` jusqu'à la fin du fly-off** (pas le retirer au début de `onEnd`), sinon la carte est re-clippée/re-descendue en z-index en plein vol.
- **`skPulse3s` du référentiel n'est jamais défini** (keyframe absente) → le squelette ne shimmer pas en boucle dans l'original, juste une entrée `skIn`. J'avais inventé un shimmer trop rapide → retiré.
- **EP label** : repris la logique exacte du Hero info (`7/12` / `1208+` / `12` / `N/A`), nécessite `nextAiringEpisode` dans la requête.
- **status-dot** : couleur exacte du référentiel `rgb(0,230,0)` + glow + `pulse-green` (mon `#10b981` était trop terne) ; `upcoming` = rouge.
- **Bug indépendant** : dropdown notifications (`w-80` ancré `right-0`) débordait hors écran en mobile → `fixed left-2 right-2` sous `sm`, panneau d'origine au-dessus.

### À vérifier
- `tsc --noEmit` + `next lint` clean à chaque commit.
- Reste très visuel : tester le swipe (fluidité en partant sur l'image, pas de débordement), l'undo (toast + badge), et le réglage click-target.

---

## 2026-06-20 — CPU Fluid encore à 4h53/4h : single-flight + snapshot des absences

### Contexte
Dashboard Vercel toujours en dépassement (`aniscroll` 4h53 / 4h). La courbe = baseline quotidien OK + **un pic isolé le 9 juin (~1h6m)**. Or les fixes du 15 juin sont **postérieurs** au pic → le dépassement mensuel traîne surtout le résidu du 9 ; le vrai test = la courbe post-15. Mais deux fuites structurelles restaient sur le chemin chaud (`/api/v2/source`, l'endpoint le plus CPU-lourd : scrape multi-provider + cheerio).

### Diagnostic
- **Pas de single-flight.** Sur un épisode froid populaire, des dizaines de visiteurs probent le MÊME `(server, episode)` en parallèle. Le cache Redis n'est peuplé qu'APRÈS le 1er retour → chaque requête concurrente lançait son PROPRE scrape. N scrapes identiques pour 1 résultat = la forme exacte du « pic ».
- **Les absences n'étaient pas mémorisées.** Le snapshot `/api/v2/availability` ne stockait que les serveurs CONFIRMÉS. Les serveurs sans source (~la moitié, par design) n'y figuraient jamais → re-probés par CHAQUE visiteur → un scrape `/api/v2/source` à chaque fois que le cache négatif (600s) avait expiré (typique d'un nouvel épisode). C'est le gros du CPU de fond restant.
- **Écarté : filtrer le fan-out par langue.** Le sélecteur (`serverSelector.js`) affiche les 3 groupes (multi/VO/VF) simultanément ; couper le probe par langue masquerait des serveurs réellement proposés. Abandonné.

### Décisions / fix (`dev`)
1. **Single-flight Redis** (`source/index.js`) : sur cache MISS, `SET NX EX 20` sur `lock:<cacheKey>`. Le détenteur (leader) scrape ; les concurrents (followers) **poll le cache** (budget 6s, `LOCK_POLL_MS` 150ms) et servent le résultat du leader. Lock libéré **après** que l'écriture cache ait atterri (sinon un follower verrait le lock parti avant le résultat → scraperait). Fallback : si le leader timeout (upstream lent / crash → lock expire), le follower scrape lui-même → jamais de deadlock. Skippé si caching off.
2. **Snapshot des absences** (`availability.js` + `[...info].js`) : le snapshot passe de `[...]` à `{ ok:[…], absent:[…] }` (rétrocompat lecture de l'ancien tableau, auto-retiré au prochain POST). Le client hydrate les `absent` dans `cachedFailed` → **probe SKIPPÉ** pour les serveurs connus-vides. Publié seulement à partir des **404 STABLES** (`confirmedAbsent`, set distinct de `cachedFailed` qui mélange transitoires) — un rejet anti-bot transitoire ne doit JAMAIS être publié comme absence permanente (sinon host masqué 6h). Merge serveur : verdict le plus récent gagne par id (un host qui revient quitte `absent`).

### Leçons / pièges
- **Le cache Redis ne fait PAS office de single-flight.** Il n'aide qu'après le 1er retour ; la rafale concurrente froide passe à travers. Il faut un verrou explicite pour collapser N→1.
- **Ne jamais publier un échec TRANSITOIRE comme absence durable.** `cachedFailed` mélange 404-stable et anti-bot-flaky ; seuls les `fail-404` vont dans `confirmedAbsent`. Le double-fail transitoire reste local.
- Libérer le lock **après** l'écriture cache (`write.finally(release)`), pas en fire-and-forget parallèle, sinon fenêtre de course où un follower re-scrape.

### À vérifier en prod
- ⏳ Courbe Fluid post-20 juin : le baseline doit chuter (absences plus re-scrapées) ET le pic week-end s'aplatir (single-flight).
- ⏳ DevTools sur un épisode déjà vu : aucun POST `/api/v2/source` pour les serveurs vides (avant : ~la moitié partaient quand même).
- `tsc` + `next lint` clean sur les 3 fichiers.

---

## 2026-06-15 (suite) — Fix surconsommation Redis Upstash (aniscroll-cache)

### Contexte
Dashboard Upstash `aniscroll-cache` : « Daily Commands by Regions » (eu-west-1) plat jeu/ven/sam puis **pic dimanche ~600k commandes + lundi ~400k** (idem bandwidth). C'est le Redis, pas Vercel. Profil = **événement week-end** (épisode populaire sorti → vague de visiteurs), pas un usage de fond.

### Diagnostic
- Commandes Redis par mount de page watch : `/api/v2/availability` GET (1) + au POST final SET-NX guard (+GET/SET merge, mais collapse à ~1 write/10min) + **`/api/v2/source` × N probes**. Chaque probe = `rateLimiterRedis.consume()` (**~2-3 commandes EVALSHA**, c'est une écriture) + `redis.get(cacheKey)` (1).
- **Bug d'ordre** : dans `source/index.js`, `consume()` tournait **AVANT** le check de cache. Donc même un **hit de cache** coûtait ~3 commandes. Sur un épisode populaire (la majorité des probes tapent le cache), le limiter multipliait le compte de commandes **3-4×** pour rien.
- Les scripts de masse (`warm-cache.mjs` etc.) envoient `X-Warmer: 1` → rate-limiter + availability POST skippés → relativement propres, pas la cause. Le pic = **trafic réel**.

### Décision / fix (`dev`)
- **Inversé l'ordre dans `/api/v2/source`** : `redis.get(cacheKey)` D'ABORD ; `rateLimiterRedis.consume()` seulement sur **cache MISS** (le chemin qui déclenche le scrape coûteux et mérite la protection). Un hit de cache = **1 commande** au lieu de ~4. Combiné au skip des serveurs trusted (fix précédent), le pic week-end doit nettement baisser.

### Leçons / pièges
- **`rate-limiter-flexible` `.consume()` = écriture Redis (~2-3 commandes Lua), pas gratuit.** Ne jamais le mettre avant le cache : protéger le travail coûteux, pas les hits de cache. Sur une route à fan-out massif c'est un multiplicateur ×3-4 du compte de commandes Upstash.
- Upstash facture/quota au **nombre de commandes** — réduire les commandes/requête sur le chemin chaud (cache-hit) prime sur tout.

### À vérifier
- ⏳ Surveiller « Daily Commands » Upstash après le prochain week-end : le pic doit être divisé (cache-hits passés de ~4 à 1 commande).

---

## 2026-06-15 — Fix surconsommation CPU Vercel (Fluid Active CPU 4h54/4h)

### Contexte
Dashboard Vercel : `aniscroll` = 98,3 % du quota Fluid Active CPU (4h49m / mois), dépassement. Courbe = baseline quotidien régulier (~10-16 min/j) + **pic isolé le 10 juin (~1h10 en une journée)**. Le « Fluid Active CPU » mesure le **temps CPU dans les fonctions serverless**, pas la bande passante.

### Diagnostic (pas d'accès dashboard depuis la CLI — raisonné sur le code)
- **Coupable = `/api/v2/source`** (1764+ lignes) : résolution de stream multi-providers + parsing **cheerio**, l'endpoint le plus CPU-lourd. Appelé en **fan-out de 15-30 POSTs par mount de page watch** (un par serveur, ×2 sur retry transitoire) — c.f. `pages/en/anime/watch/[...info].js` (`probe`/`runPool`). Sur cold cache → autant de scrapes cheerio. Le pic du 10 juin = vague de visiteurs sur un épisode fraîchement sorti (cold cache simultané) ou une vrille de retry.
- **PAS la cause** (vérifié) : le proxy vidéo `m3u8` est porté par le **Worker Cloudflare** (`UniversalPlayer.tsx` PROXY_BASE hardcodé worker, pas le `/api/v2/proxy/m3u8` Vercel) ; `AnilistHealthBanner` déjà optimisé (poll 5 min + edge 300s) ; `bulk-refresh` borné 50 + admin-only ; dép `cron` orpheline (aucun `new CronJob`).
- L'endpoint `source` avait DÉJÀ un cache Redis positif (300s) + négatif (sentinel `{"__nf":1}`, 120s) + le snapshot `/api/v2/availability` cross-visiteur. Mais **le client re-scrapait quand même** : `hydrateFromServer` ne faisait que colorier les chips (commentaire « do NOT add to cachedConfirmed ») → re-probe systématique de tout serveur connu-bon.

### Décisions / fix (sur `dev`)
1. **Faire confiance au snapshot availability** (`[...info].js`) : `hydrateFromServer` ajoute désormais les serveurs du snapshot à `cachedConfirmed` (donc exclus du fan-out) ET le pool est **awaité APRÈS** l'hydratation (`await hydrateFromServer()` avant de calculer `remaining`) — sinon le filtre ne voyait pas encore les confirmés (course). Résultat : un épisode populaire coûte **~0 scrape par visiteur après le 1er**. Compromis assumé : le prefetch source cache n'est plus seedé pour les serveurs trusted → cliquer un chip déclenche UN resolve à la demande (hit Redis positif si chaud, un scrape si froid) ; un snapshot périmé s'auto-corrige via `markFailed` à la sélection.
2. **TTL cache négatif 120s → 600s** (`source/index.js` `SOURCE_NOTFOUND_TTL_S`) : un serveur sans source pour un épisode ne « revient » quasi jamais en quelques minutes ; 10 min écrasent la rafale de re-scrape cold-visit (le client ne persiste plus les échecs en sessionStorage, donc CE cache est le seul rempart).
3. **`maxDuration: 15` sur `/api/v2/source`** : plafond dur qui tue une invocation en vrille (boucle de redirection, retries en cascade anti-bot) avant qu'elle brûle le budget Fluid — cause probable du pic du 10 juin. Les fetchs internes capent déjà à 3-5s, donc un resolve sain finit bien en-dessous.

### Leçons / pièges
- **Fluid Active CPU = temps CPU dans les fonctions**, pas le transfert. Un fan-out de scrapes cheerio le fait exploser ; le proxy vidéo (qui est sur Cloudflare) ne compte pas.
- Un snapshot cross-visiteur qui ne fait que **peindre l'UI sans gater le travail** ne sert à rien côté coût : il faut qu'il **supprime** le re-scrape (`cachedConfirmed`), pas juste colorier.
- Awaiter l'hydratation avant de calculer `remaining` est indispensable — sinon la course laisse passer tout le fan-out.

### À vérifier en prod (dev → dev.aniscroll.com)
- ⏳ Ouvrir un épisode déjà vu par quelqu'un → chips verts instantanés SANS rafale de POST `/api/v2/source` (DevTools Network) ; cliquer un chip trusted → un seul resolve.
- ⏳ Surveiller la courbe Fluid sur quelques jours : le baseline quotidien doit chuter nettement.

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
