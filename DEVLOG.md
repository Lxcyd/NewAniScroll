# DEVLOG

Journal des decisions et des lecons apprises. **Le detail vit dans `devlog/`,
un fichier par sous-systeme** ; ce fichier-ci n'est qu'un etat courant et un
index.

> **En debut de session : lire CE fichier, et lui seul** (~5 k tokens). Puis
> ouvrir le devlog du domaine sur lequel on travaille, et `grep` le reste a la
> demande. Le journal complet fait ~390 Ko / ~110 k tokens : le charger en
> entier consommait la moitie d'une fenetre de contexte avant la premiere
> question.

En fin de session, ajouter l'entree **dans le devlog du domaine**, en tete de
fichier, et sa ligne dans l'index ci-dessous. Regle de classement : le domaine
est celui **ou vit le code**, pas celui du symptome.

Le changelog du site (`changelog/`) ne se fabrique PAS a partir d'ici : il se
construit depuis `git log --since=<derniere release>`.

## Etat courant — 2026-08-29

- **v0.0.8 en production** depuis le 29/08 (PR #8, 237 commits). `origin/main`
  et `origin/dev` sont au meme point. Contenu : nouvelle page de visionnage,
  prochain episode + rappel, classement des lecteurs sur leurs performances
  mesurees, numerotation des saisons corrigee (JJK, AoT, MHA), TMDB devant
  ani.zip ET devant AniList pour les vignettes d'episode, fondu au blanc traite
  comme un fondu au noir.
- **Six caches ont monte de version** avec cette release — `seasonChain:v11`,
  `seasonList:v22`, `tmdbStills:v3`, `episode:v11`, et cote client
  `as:firstframe:v2`. La prod les reconstruit a la premiere visite : ne pas
  juger une page sur son premier chargement post-deploiement.
- La v0.0.7 (16/08, PR #6) avait demande une resolution de conflit : trois
  correctifs CI/cron commites sur les deux branches. Piege a retenir,
  **independant de la release** : `refresh-fanarts.yml` s'etait auto-merge
  *sans conflit* en dupliquant tout le bloc classifieur. La v0.0.8 n'a pas
  rencontre le cas (fusion a blanc verifiee avant d'ouvrir la PR, aucun
  workflow modifie des deux cotes), mais la verification reste a faire a chaque
  fois : l'absence de conflit ne prouve pas l'absence de degat.

## Chantiers ouverts

- **Worker Cloudflare non deploye.** `/w/status` et la journalisation des
  echecs d'ecriture Turso sont sur `main` mais pas en ligne : il faut un
  `wrangler deploy` + poser les secrets `TURSO_ADMIN_URL` / `TURSO_ADMIN_TOKEN`.
  Les analytics visiteurs sont muettes depuis le 11/07. -> `devlog/infra.md`
- **`TMDB_API_KEY` absente de l'environnement Preview** (presente en
  Production). Tout ce qui depend de TMDB tourne desactive en silence sur
  dev.aniscroll.com. -> `devlog/site.md`
- **Multi-parties OP/ED inerte sous v2** (ouvert depuis le 06/08) : les
  fenetres par partie sont jetees par `detect_per_host`. -> `devlog/oped.md`
- **ISR de la page anime a re-mesurer** (ouvert depuis le 03/08) : la mesure
  du hit CDN etait faussee par un cron supprime. -> `devlog/infra.md`
- **Surveiller apres la v0.0.8** : le compteur Upstash sur 48 h — six caches
  reconstruits d'un coup, c'est exactement le profil qui sature le plafond
  gratuit en milieu de mois (`devlog/infra.md`). Etat au 29/08 : 6 685
  commandes/jour, **40 %** du plafond en projection — confortable.
- **Le cout qui montait etait celui du Worker Cloudflare, pas Upstash** : 310
  requetes par visionnage contre un palier gratuit de 100 000/jour. Ramene a
  55 le 29/08 (PR #9). A re-mesurer si la page de lecture change encore.
- **Bandes noires 4:3** (Mobile Suit Gundam) : mesure faite, fichier 1440x1080
  sans bandes incrustees, donc la boite du lecteur reste en 16:9 alors que
  `videoRatio` sait la mesurer. Cause non tracee, correctif non ecrit.
  -> `devlog/player.md`

## Ou ecrire, ou chercher

| Domaine | Fichier | Entrees | Couvre |
| --- | --- | --: | --- |
| Apercu au survol & bandes-annonces | [`devlog/preview.md`](devlog/preview.md) | 32 | carte de survol, trailer, lumiere d'ambiance, blocage YouTube |
| Lecteur video & lecteurs distants | [`devlog/player.md`](devlog/player.md) | 42 | raccourcis, toasts, autoplay, plein ecran, w2g, lecteurs distants |
| Detecteur OP/ED | [`devlog/oped.md`](devlog/oped.md) | 11 | tools/opening-detector, replis F1-F7, garde-fous P1-P8, audits |
| Pages, saisons, relations & sources de donnees | [`devlog/site.md`](devlog/site.md) | 15 | saisons, graphe de franchise, hero, navbar, TMDB/fanart/ani.zip |
| Infra, cout, cache & releases | [`devlog/infra.md`](devlog/infra.md) | 15 | Upstash, Fluid CPU, crons, usage-monitor, analytics, releases |

## Index des entrees

### Apercu au survol & bandes-annonces — [`devlog/preview.md`](devlog/preview.md)

- 2026-08-16 — Le trailer de la carte, parfois noir, et qui marchait « au bout de plusieurs essais »
- 2026-08-15 — Nettoyage de l'aperçu au survol
- 2026-08-15 — Le fondu bas de la carte, et le rail du hero rendu survolable
- 2026-08-14 — La page info sait enfin qu'un trailer est géo-bloqué
- 2026-08-14 — Le géo-blocage revient, par le lecteur cette fois  _(voir aussi `devlog/player.md`)_
- 2026-08-14 — Bandes noires, curseur, et un coût Vercel qui ne servait plus
- 2026-08-14 — Le lecteur est préchauffé au repos ; deux fautes du commit d'avant
- 2026-08-14 — Un seul lecteur pour toute la session
- 2026-08-14 — Le proxy trailer est supprimé, retour à l'embed nu
- 2026-08-14 — Ne pas déplacer le cadre : AGRANDIR le player
- 2026-08-14 — Existe-t-il un dépôt qui n'est PAS bloqué ? Non — et cobalt le prouve
- 2026-08-14 — « Et si c'était le navigateur du visiteur qui demandait ? »
- 2026-08-14 — Le Worker déployé et mesuré : rien n'a changé, et c'était prévisible  _(voir aussi `devlog/infra.md`)_
- 2026-08-14 — PO token : la porte s'ouvre, la pièce est vide
- 2026-08-14 — Le POT est lié à la SESSION, pas à l'adresse (et pourquoi ça ne suffit pas)
- 2026-08-14 — Reproduire yt-dlp : la table des clients est épuisée
- 2026-08-14 — Le bouton de l'embed, enfin PHOTOGRAPHIÉ
- 2026-08-14 — Lumière d'ambiance du survol : elle ne pouvait pas bouger
- 2026-08-13 (fin) — Copier la requête de référence valait tous les réglages
- 2026-08-13 (nuit) — Le 403 n'était pas un token, c'était du rationnement
- 2026-08-13 (soir) — Trailers : l'identité de session, et pourquoi elle ne doit servir qu'en secours
- 2026-08-13 — Trailers : c'est notre propre machinerie de reprise qui nourrissait le blocage
- 2026-08-11 — Trailers : le refus de YouTube ne se combat pas dans la requête
- 2026-08-09 (soir 2) — Le halo « tout autour » n'était pas le halo
- 2026-08-09 (soir) — Deux frames YouTube, un seul état : le bug du bouton fantôme
- 2026-08-09 — Le bouton de YouTube qu'on ne peut pas enlever, et le halo en retard
- 2026-08-09 — Le halo qui ne changeait pas de couleur, et le volume partagé
- 2026-08-09 — Le bouton pause qui s'affichait tout seul, et la lumière qui suit la vidéo
- 2026-08-09 — L'aperçu et la page info doivent montrer la MÊME bannière
- 2026-08-09 — Aperçu au survol : commandes, son, lumière d'ambiance
- 2026-08-08 (nuit) — `size-full` n'existe pas en Tailwind 3.3 : la bannière de l'aperçu était vide
- 2026-08-08 (nuit) — Carte de survol avec bande-annonce, portée de Hayase

### Lecteur video & lecteurs distants — [`devlog/player.md`](devlog/player.md)

- 2026-08-29 — Le vrai cout d'un visionnage : 310 requetes, dont 51 utiles
- 2026-08-29 — AniSkip interroge sur une serie qu'il ignore
- 2026-08-29 — Les vignettes de la barre faisaient refuser la lecture (429)
- 2026-08-29 — La premiere frame blanche, et le voile qui manquait
- 2026-08-29 — Les episodes pas encore sortis, et la molette rendue au navigateur
- 2026-08-17 — La langue avant le lecteur : un classement 1-2-3 pose une fois
- 2026-08-17 (nuit) — Sibnet tuait la fonction, et une preference morte se rejouait a vie
- 2026-08-17 (soir) — Les chips s'effacent tous, et Megaplay ne revient jamais
- 2026-08-17 — Changer de lecteur faisait disparaitre nos boutons
- 2026-08-08 (soir) — Sibnet remarche : deux blocages, et une conclusion fausse en route  _(voir aussi `devlog/oped.md`)_
- 2026-08-06 — Le cache de sondes n'etait pas indexe par EPISODE
- 2026-08-06 — Un upload mort ne doit pas revenir a chaque rechargement
- 2026-08-06 — Le chip Voir-Anime disparait au rechargement (absence fabriquee)
- 2026-08-06 — voir-anime migre « LECTEUR myTV » : vidmoly.biz -> voembed.net
- 2026-08-06 — Episode SPLIT par le lecteur : Re:Zero ep1 VF (01a + 01b -> 49 min)
- 2026-07-30 (suite 2) — Bouton "épisode suivant" dans la barre + on RESTE en plein écran au changement d'épisode
- 2026-07-06 (suite 21) — toasts player : pile collapse sonner (max 3) + barre fine teintée + croix
- 2026-07-06 (suite 20) — toasts player : barre de compte à rebours + vraie pile en fullscreen
- 2026-07-06 (suite 19) — notices subs/chat : vrai toast sonner en fenêtré, réplique in-player en fullscreen
- 2026-07-06 (suite 18) — Ctrl+R rotait la vidéo au lieu de recharger
- 2026-07-06 (suite 17) — notices player (subs incrustés / chat) au format toast du site (bas-droite, fullscreen-safe)
- 2026-07-06 (suite 16) — countdown négatif + trads manquantes (schedule) + keys tooltip + onglet Découvrir
- 2026-07-06 (suite 15) — layout raccourcis corrigé + icône chat + ghosts Entrée/Espace + chat non-fullscreen
- 2026-07-06 (suite 14) — ghost Entrée trop petit + megaplay sous les menus + doublon seek ±5s
- 2026-07-06 (suite 13) — w2g create 500 (zadd NX cassé dans le shim REST) + icônes ambient/reset + drag espace
- 2026-07-06 (suite 12) — Raccourcis : action ambient, cap vitesse x2, ghost de drag opaque, icônes
- 2026-07-06 (suite 11) — Raccourcis : FIX vitesse (garde !event.request), pavé num, icônes, hint
- 2026-07-06 (suite 10) — Raccourcis : tooltip en mots, cap "m" clair, retrait seekToEnd, icône reset-speed
- 2026-07-06 (suite 9) — Raccourcis : FIX codes AZERTY rangée du bas, Escape ferme, icônes échangées
- 2026-07-06 (suite 8) — Raccourcis : FIX matching (event.code), rotate remplace mirror, seek ±5, nouvelles icônes
- 2026-07-06 (suite 7) — Éditeur raccourcis : clavier ×1.5, icônes +, drag = vraie forme de touche, rateUp miroir
- 2026-07-06 (suite 6) — Éditeur raccourcis : gap uniforme px, clavier ×1.8, ghost de drag, Enter highlight opaque, icône vitesse pleine
- 2026-07-06 (suite 5) — Éditeur raccourcis : espacement +, clavier +, badge vitesse en haut-droite
- 2026-07-06 (suite 4) — Éditeur raccourcis : plus d'espacement, `- = ^ $ ù *` en clair, icônes vitesse "speedometer"
- 2026-07-06 (suite 3) — Éditeur raccourcis : clavier plus compact, teinte foncée constante, `,;:!` en clair
- 2026-07-06 (suite 2) — Éditeur raccourcis : touches jointives, non-alphanum plus sombres, icônes OP/ED partagées
- 2026-07-06 (suite) — Éditeur raccourcis : tout assignable, Enter ISO, fond flou, header minimal
- 2026-07-06 — Éditeur raccourcis : clavier AZERTY 75 % (nav en ligne), fix icône espace
- 2026-07-05 (suite 4) — Éditeur raccourcis : polish visuel SS + retrait 2 actions
- 2026-07-05 (suite 3) — Éditeur raccourcis refait « keyboard-only » (design SS) + 4 actions
- 2026-07-05 (suite 2) — Raccourcis : éditeur drag&drop, fix décalage menu, 2 actions de plus
- 2026-07-05 (suite) — Raccourcis clavier configurables + clavier visuel + stats vidéo
- 2026-07-03 (suite) — Megaplay routé via Worker + synchro AniList ON par défaut avec choix de sens
- 2026-07-03 — Player : autoplay fiable (multi-lecteurs) + bouton play one-shot + icônes OP/ED + menu uniformisé
- 2026-07-02 (suite 3) — Player : gros bouton play central + autoplay

### Detecteur OP/ED — [`devlog/oped.md`](devlog/oped.md)

- 2026-08-26 — Le chiffre qu'on regardait ne gouvernait rien, et 46 % du parc etait injugeable
- 2026-08-08 — Lot `top50` : le resultat, et pourquoi deux lecteurs sur six n'ont rien rendu
- 🔄 EN COURS au 08/08 15:50 — lot `top50`, à relire ce soir
- 2026-08-08 — Une machine qui s'éteint fabriquait des absences de générique
- 2026-08-07 — Audit OP/ED : ce que la nuit de tests a révélé
- 2026-08-05 (4) — Audit complet : 4 bugs corriges, dont 2 qui SERVAIENT du faux
- 2026-08-05 (3) — Passe large 15 anime : F1 ne recupere jamais l'OP
- 2026-08-05 (2) — OP/ED : passe sur les 6 lecteurs + megaplay corrige (fenetre ED)
- 2026-08-05 — OP/ED : 4 lecteurs au lieu d'1 (megaplay, ansembed, DNS box)
- 2026-08-04 (suite 4) — OP/ED : couche de replis (F) + garde-fous faux positifs (P)
- 2026-07-14 — OP/ED : fin d'OP tronquée à 4:00 (fenêtre) + megaplay ED décalé (credited faible override audio)
- 2026-07-10 — OP/ED : précision ~0.25s sur les 4 bords (refine image *credited* dense)

### Pages, saisons, relations & sources de donnees — [`devlog/site.md`](devlog/site.md)

- 2026-08-29 — Deux « Season 1 » a la file : le garde qui empechait de compter
- 2026-08-29 — La vignette d'episode passe a TMDB, qui CHOISIT
- 2026-08-15 — Le graphe des relations se dessinait deux fois
- 2026-08-10 — Graphe de franchise : le reste du chantier
- 2026-08-08 (nuit) — Titre de la fiche : TMDB passe devant le logo fanart.tv
- 2026-08-03 (suite 2) — « Pourquoi on a pas les bonnes vignettes ? » — Fribb ne connaît qu'un tiers des ids Simkl
- 2026-07-30 (suite 3) — Navbar illisible sur une bannière claire → on mesure les pixels
- 2026-07-05 — Onglet Découverte (feed swipe façon TikTok) + panneau « For You »
- 2026-07-03 (suite 2) — Section Épisodes : perf, badges, harmonisation ; rating décimal ; fixes saison
- 2026-07-02 (suite 2) — Polish Films/OP-ED : miniatures clip, Chronicle, retour saison, perf
- 2026-07-02 (suite) — Films/OP-ED en onglets (remplacent la liste) + section Compilations
- 2026-07-02 — Dropdown OP/ED (clips AnimeThemes) + fix détecteur multi-lecteur [commit ceeffe5]  _(voir aussi `devlog/oped.md`)_
- 2026-07-01 (suite 2) — Diag résolution vidéo + fix panels fusionnés + films bonus SIDE_STORY  _(voir aussi `devlog/player.md`)_
- 2026-07-01 (suite) — Saisons : unification liste/label, franchise canonique, films numérotés, anime « sans saison »
- 2026-07-01 — Mapping des saisons : moteur multi-signaux + carte des relations + dual-format

### Infra, cout, cache & releases — [`devlog/infra.md`](devlog/infra.md)

- 2026-08-26 — Le chunk que personne ne peut éviter : `_app` divisé par deux
- 2026-08-22 (suite) — Page watch : −20 % de bundle, −19 % de HTML, sans toucher au comportement
- 2026-08-22 — Relevé usage : le seul trou de cache restant, et pourquoi le monitor ne verra jamais Vercel
- 2026-08-16 — Le cron ne rattrapait rien, et une panne AniList l'aurait prouvé trop tard
- 2026-08-04 (suite 3) — CORRECTION de l'entrée précédente : Vercel va bien, seul le Worker est muet
- 2026-08-04 (suite 2) — ⚠️ ENTRÉE ERRONÉE (voir la correction en suite 3) — la base ADMIN n'est plus écrite depuis la prod (11/07)
- 2026-08-04 (suite) — Passe de propreté : deps mortes, duplication, pages statiques
- 2026-08-04 — Passe de perf : bundle, images, code splitting, scroll
- 2026-08-03 (suite 3) — Audit usage Vercel : le plus gros poste de coût était notre propre cron
- 2026-08-03 (suite) — Release `dev` → `main`, monitor vivant, et TMDB dégagé
- 2026-08-03 — Le fix du 30/07 n'était jamais parti en prod (et le monitor ne pouvait pas le dire)
- 2026-07-30 (suite 4) — Chasse aux invocations : le POST qui rendait tout le cache décoratif
- 2026-07-30 (suite) — `tools/usage-monitor` : collecteur de diagnostic usage quotidien
- 2026-07-30 — Upstash toujours ~31k cmd/j après le fix edge-cache : le vrai volume = re-probe des `absent` sur `/source`
- 2026-07-29 — Explosion du Fluid Active CPU (Vercel) depuis le 18/07 : plafond Upstash gratuit
