# Plan — AniScroll entièrement utilisable sur mobile

Branche `mobile` (partie de `dev` le 22/10/2026, worktree `NewAniScroll-mobile`).
Elle revient dans `dev` par un seul merge, donc un seul push et un seul déploiement.

## Règles de travail

1. **Le PC ne bouge pas d'un pixel.** Toute modification mobile est confinée
   (`@media (max-width: 768px)`, classes `max-md:`, ou branche `useIsMobile`).
   Chaque étape se termine par une comparaison des captures PC avant/après à
   1440×900 : une différence non voulue bloque l'étape.
2. **Pas de nouvelle copie mobile d'un composant.** Le mobile doit réutiliser
   les composants PC rendus responsives. Une copie (comme `InfoPageMobile`, 1575
   lignes) dérive : c'est elle qui montre encore les cartes de relations quand
   le PC a le graphe. Une copie reste acceptable seulement si la *structure*
   diffère vraiment, et elle doit alors appeler les mêmes sous-composants.
3. **Même style.** Les couleurs, les polices, les cartes et les animations sont
   reprises telles quelles. On adapte la disposition et l'interaction, pas
   l'identité visuelle.
4. **Chaque fonction PC a un équivalent tactile.** Survol → appui ; appui long
   ou bouton visible ; clic droit → menu ; raccourcis clavier → gestes ;
   glisser à la souris → glisser au doigt.

## Outils

- `tools/browser-check/mobile-audit.mjs` (sans dépendance, Chrome + CDP) :
  - émule un iPhone 14 en portrait (390×844, tactile, User-Agent iPhone) ;
  - capture chaque page écran par écran ;
  - relève les débordements horizontaux, les cibles tactiles < 40 px et les
    textes < 11 px.

  `MOBILE_W=360 MOBILE_H=780` simule un petit Android ; `844×390` simule le
  paysage (lecteur).
- **Vrai téléphone sans déploiement :** `next dev -H 0.0.0.0 -p 3124`, puis
  `http://<IP du PC>:3124` sur le téléphone, connecté au même Wi‑Fi.
  - Sur Android, `chrome://inspect` donne la console du téléphone par câble USB.
  - Sur iPhone, l'équivalent passe par Safari sur Mac, donc il n'est pas
    disponible ici.
- **Validation finale :** sur dev.aniscroll.com après le merge (un seul push).

## Constat de départ (audit du 22/10, 390×844)

- Aucun débordement horizontal sur les pages publiques, sauf
  `my-list` (`.as-stat-card` fait 395 px pour un écran de 390).
- **Barre du haut** : le logo, 4 icônes et l'avatar tiennent à peine, et
  « BETA » est collé aux icônes. Plusieurs icônes font 24–36 px, alors qu'une
  cible tactile devrait faire au moins 40 px.
- **Bouton menu flottant** (`MobileNav`) : il recouvre le contenu en bas à
  droite, par exemple le bas de la bande-annonce.
- **Fiche anime** : copie mobile séparée.
  - Relations en cartes, avec le graphe seulement en plein écran (« Voir la
    chronologie »).
  - `#episodes` dans l'URL n'ouvre pas l'onglet, alors que le PC le fait.
  - 76 textes de moins de 11 px.
- **Lecteur** :
  - la fenêtre « ordre des lecteurs » fonctionne, mais ses boutons ‹ › font
    28 px ;
  - l'ambilight déborde de l'écran : il est coupé, mais il faut vérifier son
    coût sur un téléphone ;
  - la liste d'épisodes est utilisable.
- **Paramètres** : 57 cibles de moins de 40 px (interrupteurs, segments).
- **Survol uniquement** : `HoverPreview` est désactivé sur tactile, donc rien
  ne le remplace. Sont aussi concernés `HoverVolume`, les infobulles de
  `ScoresTab` et de `ListBlocks`, et `BannerStudio`.
- **Pas encore audité** (il faut un compte) : profil, studio, widgets, badges.

## Étapes

Chaque étape donne un ou plusieurs commits sur `mobile`, avec l'audit mobile et
la comparaison PC à chaque fois.

| # | Étape | Contenu |
|---|---|---|
| 0 | Outillage | Audit mobile ✅. Ajout du mode PC et de la comparaison de captures. Captures PC de référence avant toute modification. Inventaire des fonctions PC page par page (la grille de parité ci-dessous). |
| 1 | Coque commune | Barre du haut compacte ; `MobileNav` sans recouvrement ; zones sûres (encoche) ; `100dvh` ; fenêtres (nouveautés, préférences lecteur, éditeur de liste, signalement, connexion) en panneaux qui montent du bas ; toasts ; cibles ≥ 40 px partout. |
| 2 | Fiche anime | Graphe des relations dans la page (mode vertical déjà présent dans `RelationsGraph`, avec glisser et pincer au doigt) ; onglets liés à l'URL ; les 5 onglets avec le même contenu que sur PC (OP/ED, films bonus, notes par épisode avec infobulle au toucher) ; textes lisibles. Puis faire converger `InfoPageMobile` vers les composants PC. |
| 3 | Lecteur et visionnage | Commandes tactiles (double appui ±10 s, appui = afficher ou masquer, glisser la barre de progression) ; plein écran et paysage ; passer l'intro et l'outro ; stats ; regarder ensemble (salle, chat, emojis) ; choix du lecteur ; les raccourcis clavier remplacés par des gestes ou masqués ; ambilight allégé ou coupé si trop coûteux. |
| 4 | Navigation et catalogue | Accueil, Découvrir (cartes à glisser), recherche et palette de recherche, programme, tendances, populaires, récents, vus récemment, ma liste (débordement), catalogue. Aperçu au survol → appui long. |
| 5 | Profil et studio | Profil public, widgets, badges, bannière ; studio d'édition (glisser-déposer des widgets au doigt, panneaux de paramètres). C'est l'étape la plus lourde (`BannerStudio` fait 7000 lignes). |
| 6 | Le reste | Paramètres, compte et authentification, réinitialisation du mot de passe, pages statiques, 404, hors ligne. |
| 7 | Performance mobile | Poids JS par page, tailles d'images servies au téléphone, coût de l'ambilight et des animations. Pas de nouvelle requête réseau facturée (quotas Vercel et Turso). |
| 8 | Recette | Audit complet à 390×844, 360×780 et en paysage ; comparaison PC complète ; essai sur un vrai téléphone ; merge `mobile` → `dev` et un seul push. |

## Grille de parité (à remplir à l'étape 0, cocher au fil des étapes)

| Page | Fonction PC | Sur mobile aujourd'hui | Cible |
|---|---|---|---|
| Fiche anime | Graphe des relations dans la page | Cartes + plein écran | Graphe vertical dans la page |
| Fiche anime | Onglet dans l'URL (`#episodes`) | Ignoré | Comme sur PC |
| … | … | … | … |
