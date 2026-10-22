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
| 5 | Profil et studio | Édition COMPLÈTE sur mobile (décision de Luc du 22/10). Profil public, widgets, badges, bannière ; studio d'édition (glisser-déposer des widgets au doigt, panneaux de paramètres). C'est l'étape la plus lourde (`BannerStudio` fait 7000 lignes). |
| 6 | Le reste | Paramètres, compte et authentification, réinitialisation du mot de passe, pages statiques, 404, hors ligne. **Admin** (revue des fanarts, fanarts par anime) : utilisable au doigt, décision de Luc du 22/10. |
| 7 | Performance mobile | Poids JS par page, tailles d'images servies au téléphone, coût de l'ambilight et des animations. Pas de nouvelle requête réseau facturée (quotas Vercel et Turso). |
| 8 | Recette | Audit complet à 390×844, 360×780 et en paysage ; comparaison PC complète ; essai sur un vrai téléphone ; merge `mobile` → `dev` et un seul push. |

## Grille de parité — état au 22/10/2026 (branche `mobile`)

✅ fait et vérifié en émulation (390×844, 360×780, paysage 844×390) ;
📱 reste à confirmer sur un vrai téléphone.

| Page | Fonction PC absente ou cassée sur mobile | Ce qui a été fait |
|---|---|---|
| Partout | Menu au survol de l'avatar (Admin, Langue, Créer un compte, Saison, Discord) | ✅ panneau du compte à l'appui |
| Partout | Bouton menu flottant qui couvrait le contenu ; aucune navigation sur paramètres, ma liste, découvrir, profil | ✅ barre d'onglets du bas, montée par la Navbar |
| Partout | Aperçu au survol des jaquettes | ✅ appui long 📱 |
| Recherche | Palette centrée sous le clavier, « Ctrl+S » au doigt | ✅ calée en haut |
| Accueil | Vitrine des tendances masquée (`hidden lg:block`) | ✅ vitrine mobile (pochette, balayage) |
| Accueil | Retard d'un anime en cours au survol | ✅ visible au doigt |
| Fiche anime | Graphe des relations (cartes à la place) | ✅ graphe dans la page ; plein écran replié ; glisser/pincer 📱 |
| Fiche anime | Onglet dans l'URL | ✅ |
| Fiche anime | Tags limités, sans spoilers ni descriptions ; sites externes limités | ✅ tous, bouton spoilers, description au toucher |
| Fiche anime | Variables du design absentes (bordures blanches des onglets partagés), accent du thème ignoré | ✅ |
| Fiche anime | Pas encore sorti → 404 ; terminé → épisode 29/28 | ✅ logique partagée `lib/anime/watchCta.ts` |
| Visionnage | Pochette seule sur sa ligne, « Passer l'intro » sur le bouton lecture | ✅ |
| Visionnage | Paysage : lecteur plus haut que l'écran | ✅ borné par la hauteur, barre d'onglets masquée |
| Visionnage | Stats, capture, lien horodaté, rotation : clavier seulement | ✅ dans Réglages au doigt 📱 |
| Regarder ensemble | En-tête flouté par l'ambilight ; modération de l'hôte au survol | ✅ |
| Paramètres | Sommaire masqué | ✅ barre de sections |
| Paramètres | Interrupteurs et curseurs trop petits | ✅ zones d'appui agrandies |
| Profil | Nom sous la barre du haut ; onglets qui débordent ; widgets à 77 px | ✅ ; widgets sur une colonne en lecture |
| Studio | Inutilisable (panneau sur le profil, Enregistrer coupé) | ✅ studio empilé ; widgets à l'appui long 📱 |
| Admin | Barre latérale de la moitié de l'écran | ✅ en-tête + navigation qui défile |

### Restes connus, hors périmètre ou à décider par Luc

- Ambilight du lecteur : ~15 canvas sur téléphone, actif par défaut — le
  couper par défaut sur mobile ? (choix produit, pas fait).
- L'apercu à l'appui long charge son code sur tout téléphone (une requête de
  chunk par visiteur et par déploiement).
- Bugs PC repérés en passant, non corrigés (la branche ne touche pas au PC) :
  le plein écran du graphe des relations perd les variables du design (puces
  sans bordure) ; le Markdown du changelog coupe les puces aux retours à la
  ligne ; `/admin` planterait pour un admin SANS AniList (`session.user.token`
  vaut `undefined`, non sérialisable).
