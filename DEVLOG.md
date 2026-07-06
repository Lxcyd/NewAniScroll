# DEVLOG

Journal des modifs de dev, pour garder le contexte entre les sessions (survit aux `/clear`).
Ordre anti-chronologique (le plus récent en haut). Une entrée = une session/sujet, avec **décisions** et **leçons/pièges**, pas juste les commits (git les a déjà).

> Convention : dates absolues. Branche de travail = `dev` (push auto, voir mémoire). Le Worker Cloudflare se déploie **à la main** (`cd worker && npx wrangler deploy`) — un `git push` ne le déploie pas.

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
