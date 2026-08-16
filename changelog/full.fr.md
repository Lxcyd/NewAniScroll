# Changelog

Toutes les nouveautés d'AniScroll, les plus récentes en premier.

## [v0.0.7] — Aperçu au survol, graphe de franchise & illustrations (2026-08-16)

### Ajouté
- **Aperçu au survol** : posez le curseur sur n'importe quelle jaquette du site
  et une carte s'ouvre avec la **bande-annonce qui démarre toute seule**, le
  son, le synopsis, les mêmes notes et chiffres que la fiche, et un bouton pour
  ajouter la série à votre liste AniList. Une **lumière d'ambiance** reprend en
  temps réel les couleurs de la vidéo autour de la carte.
- **Réglages de l'aperçu** : l'aperçu au survol s'active ou se coupe dans les
  réglages, avec son propre délai de déclenchement.
- **Graphe de franchise** : la section Relations devient un vrai plateau, en
  plein écran — fiches illustrées déplaçables, zoom à la molette, recherche, et
  deux menus de filtres par type et par format. L'**ordre de visionnage est
  numéroté**, les bonus et hors-séries restent hors du fil principal, les
  sous-séries sont encadrées, et l'œuvre d'origine (le manga) entre sur le
  plateau. Les titres que vous avez terminés sont cerclés de vert.
- **Onglet Illustrations enrichi** : toute la bibliothèque fanart.tv, plus les
  visuels TMDB (bannières, affiches, logos), sans doublons.
- **Nouveau lecteur** : Ansembed rejoint les serveurs disponibles, et le
  lecteur voir-anime bascule sur voembed.net.
- **Épisodes coupés en deux fichiers** (Re:Zero ép. 1 VF) : les deux moitiés
  sont recollées et lues comme un seul épisode.
- **Vu au générique de fin** : un réglage pour compter l'épisode comme vu dès le
  début du générique, sans attendre la toute fin.
- **Cliquer sur le temps du lecteur** copie le lien horodaté.
- **Pastille de volume** : le niveau s'affiche dès le survol de l'icône.

### Modifié
- **Saut d'intro / d'outro sur beaucoup plus d'épisodes** : une cascade de
  replis prend le relais quand un lecteur ne répond pas, les épisodes en
  plusieurs parties sont gérés, et une détection ratée est réessayée au lieu
  d'être définitive.
- **Site encore plus léger** : ~46 ko de JavaScript en moins sur chaque page,
  jaquettes servies à la bonne taille dans les grilles, plusieurs pages passées
  en statique, onglets de la fiche chargés au clic, et une barre de navigation
  qui ne se recalcule plus à chaque image pendant le défilement.
- **Vignettes du lecteur** : pré-chargement environ 10x plus rapide, plus de
  case vide sur la barre, et l'aperçu suit enfin le curseur.
- **Découverte** ne propose plus que des animes en cours de diffusion.
- **Bandes-annonces bloquées dans votre pays** : elles sont masquées au lieu
  d'afficher un lecteur en erreur.
- **Bandeau d'accueil** : sa hauteur suit celle de la fenêtre, le logo officiel
  de la série y est affiché, et survoler le rail d'affiches met la rotation en
  pause.

### Corrigé
- **Films et hors-séries mal classés** : un film au milieu d'une chaîne, une
  re-adaptation prise pour un film-résumé ou une préquelle n'entrent plus dans
  le décompte des saisons.
- **Numérotation décalée** sur les séries dont la première saison est une
  préquelle.
- **Vignettes d'épisode manquantes** : la liste en cache ignorait une de ses
  sources pendant 30 jours.
- **Le lecteur sibnet refonctionne.**
- **Épisodes annoncés absents à tort** : un lecteur momentanément injoignable ne
  prouve pas que l'épisode n'existe pas.
- **Barre de navigation illisible** sur certaines bannières.
- **La langue ne bascule plus** une fraction de seconde au chargement de la
  page.
- **Compte à rebours du prochain épisode** qui repartait à zéro tout seul.

## [v0.0.6] — Contrôles du lecteur, vraies vignettes d'épisode & rapidité (2026-08-03)

### Ajouté
- **Raccourcis clavier configurables** : attribuez n'importe quelle touche à
  n'importe quelle action du lecteur depuis un clavier visuel — glissez l'icône
  d'une action sur la touche voulue. Regroupés par Lecture, Navigation, Saut,
  Audio, Vitesse et Affichage, avec un retour aux valeurs par défaut.
- **Panneau de statistiques vidéo** : résolution, images/s, débit, débit de
  connexion, tampon et images perdues pendant la lecture — plus un bouton de
  capture d'écran et « copier le lien à cet instant ».
- **Bouton épisode suivant** dans la barre de contrôle, à côté de lecture.
- **Le plein écran survit au changement d'épisode** : passer à l'épisode suivant
  ne vous éjecte plus du plein écran.
- **Vraies vignettes d'épisode** : chaque ligne affiche désormais l'image réelle
  de l'épisode au lieu d'un visuel répété, et de vrais titres d'épisode sur les
  séries où AniList n'en liste aucun (Chainsaw Man…).
- **Page Sources** : une page de crédits, accessible depuis le pied de page,
  listant les bases de données et communautés ouvertes qui alimentent le site.
- **Nouveau lecteur** : uqload s'ajoute aux serveurs anime-sama.

### Modifié
- **Un site nettement plus rapide** : les pages et requêtes communes à tous — la
  page de lecture, les listes d'épisodes, la résolution des sources — sont
  maintenant servies depuis le CDN au lieu d'être recalculées pour chaque
  visiteur. Les pages s'ouvrent plus vite et le site tient bien mieux la charge.
- **Saut d'intro / d'outro plus précis**, sur plus de lecteurs : la détection a
  été reprise lecteur par lecteur, donc les boutons Passer l'intro et Passer
  l'outro apparaissent sur plus d'épisodes et tombent à la bonne seconde.
- **Les notices du lecteur** (sous-titres incrustés, chat) s'affichent comme des
  notifications empilées dans un coin, et fonctionnent aussi en plein écran.
- **Barre de navigation lisible sur les visuels clairs** : elle passe en texte
  sombre quand la bannière derrière elle est claire, au lieu de disparaître.

### Corrigé
- **Mauvais titres d'épisode sur les suites** : les saisons 2 et suivantes de
  certaines séries affichaient les titres de la saison 1 (L'Attaque des Titans,
  Demon Slayer, Jujutsu Kaisen).
- **Regarder ensemble** : la lecture automatique démarre pour tout le monde dans
  le salon, et la réinitialisation d'un salon refonctionne.
- **La page d'accueil et le planning ne cassent plus** quand le cache est
  momentanément indisponible.
- **Serveurs affichés indisponibles à tort** : un lecteur qui échoue une fois
  pour une raison passagère n'est plus masqué comme s'il n'avait aucune source.
- Un lecteur choisi à la main ne s'affiche plus comme indisponible au moment
  précis où vous cliquez dessus.

## [v0.0.5] — Découverte, fiches, saisons & lecteurs (2026-07-05)

### Ajouté
- **Onglet Découverte** : un fil vertical plein écran, façon TikTok, pour
  parcourir les animes du moment. Faites défiler vers le haut ou le bas pour
  passer d'une fiche à l'autre.
- **Swipe pour trier** : glissez une fiche à droite ou à gauche pour l'ajouter à
  votre liste AniList. Par défaut, droite = « Terminé » et gauche = « Prévu ».
- **Réglages de swipe** : choisissez le statut assigné à chaque direction parmi
  En cours, En reprise, Terminé, Prévu, En pause et Abandonné.
- **Annuler** : revenez sur une fiche déjà glissée pour retirer l'action d'un
  simple clic (l'entrée AniList est supprimée).
- **« Pour vous »** : un panneau de recommandations personnalisées basées sur
  votre liste AniList, avec le « pourquoi » de chaque suggestion. Deux modes
  (tout / à prévoir) et un bouton pour en générer de nouvelles.
- **Onglets Films, Compilations et Opening / Ending** sur la fiche d'un anime :
  au lieu d'une longue liste, des onglets dédiés qui remplacent les épisodes.
- **Opening / Ending** : parcourez et regardez les génériques (openings/endings)
  d'une série, regroupés par saison, avec trois vues (détaillée, compacte,
  grille).
- **Compilations** : les films-résumés (recaps d'arc) sont désormais séparés des
  vrais films, dans leur propre section.
- **Carte des relations** : un aperçu déplaçable et zoomable des liens entre les
  saisons, films et spin-offs d'une franchise.
- **Note à la demi-étoile** : notez un anime avec des demi-points (8,5/10) à la
  fin du dernier épisode.
- **Choix du sens de synchronisation** : à la connexion, choisissez si votre
  liste AniList remplace votre liste locale, ou si votre liste du site est
  ajoutée à AniList — au lieu d'un simple avertissement d'écrasement.

### Modifié
- **Numérotation des saisons refaite** : un nouveau moteur multi-signaux arbitré
  par les dates de diffusion corrige l'ordre des saisons (fini la saison 2 qui
  affichait la saison 1, ou un remake classé avant l'original). Franchises
  vérifiées : Attack on Titan, Hunter x Hunter, Gundam, Jujutsu Kaisen, Demon
  Slayer…
- **Films bonus bien classés** : les films side-story et préquelles (ex.
  Hunter x Hunter : Phantom Rouge, Jujutsu Kaisen 0) ne sont plus comptés comme
  des saisons.
- **Liste d'épisodes plus rapide** : les très longues séries (One Piece, 1000+
  épisodes) s'affichent instantanément et défilent sans à-coups.
- **Fiche d'épisodes réorganisée** : onglets saison / Films / Opening-Ending
  harmonisés, badge du nombre d'épisodes, recherche et filtres disponibles
  partout.

### Corrigé
- **Lecteurs plus fiables** : le lecteur Megaplay, qui échouait souvent en
  production alors que la vidéo existait, est réparé (requêtes routées pour
  passer les protections anti-bot).
- **Lecture automatique fiabilisée** : la vidéo démarre seule sur davantage de
  lecteurs, et activer la lecture auto en cours de route la lance vraiment.
- **Multi-saisons sur anime-sama** : les longues séries concaténées (Gintama…)
  diffusent enfin la bonne saison.
- La fenêtre de notation ne réapparaît plus par erreur en ouvrant un autre anime.

## [v0.0.4] — Regarder ensemble (2026-06-26)

### Ajouté
- **Regarder ensemble** : regardez un épisode en synchro avec vos amis. Créez un
  salon, partagez un code à 4 chiffres ou un lien d'invitation, et la lecture
  reste synchronisée pour tout le monde.
- **Chat du salon** : un chat en direct à côté du lecteur, avec un sélecteur
  d'emojis complet et une collection de stickers anime — recherche en français
  et en anglais.
- **Modération par l'hôte** : l'hôte peut transférer l'hôte, rendre muet un
  membre, bloquer sa lecture, verrouiller le salon (privé), expulser ou bannir.
- **Synchronisation des épisodes** : changer d'épisode, de serveur ou de
  sub/dub suit automatiquement tout le salon.
- **Chat plein écran** : un chat superposable pour continuer à discuter en
  plein écran.

## [v0.0.3] — Paramètres repensés, thèmes & profil (2026-06-14)

### Ajouté
- **Page Paramètres repensée** : un menu latéral qui reste visible, avec une
  section par thème pour s'y retrouver d'un coup d'œil.
- **Thème personnalisable** : choisissez votre couleur d'accent, appliquée
  partout dans l'app en direct.
- **Page profil repensée** : bannière, avatar et statistiques, avec votre liste
  groupée par statut comme sur « Ma liste ».
- **Notation en fin d'anime** : une fenêtre vous propose de noter un anime quand
  vous terminez son dernier épisode (activable dans les réglages).
- **Ouvrir au visionnage ou à la fiche** : choisissez si cliquer sur un anime
  ouvre sa fiche d'info ou lance directement la lecture — et il reprend à
  l'épisode où vous vous êtes arrêté.
- **Masquer les spoilers** : floute les vignettes et masque les titres et
  descriptions d'épisodes dans toute l'app.
- **Réglages des notifications** : activez ou coupez chaque type d'alerte
  (nouveaux épisodes, suites, rappels de reprise).
- **Seuil de synchronisation** : réglez à partir de quel pourcentage d'un
  épisode il est compté comme vu (par défaut 80 %).
- **Serveur par défaut** : choisissez le lecteur essayé en priorité.
- **Forcer la qualité maximale** et **démarrer en sourdine** côté lecteur.
- **Carte de partage** : partager un anime affiche un bel aperçu (cover, titre,
  note) dans Discord et les réseaux.
- **Effacer l'historique** et **réinitialiser les réglages** dans une nouvelle
  section Avancé.

### Modifié
- La suppression de la liste locale se fait désormais depuis les Paramètres,
  avec une confirmation.
- En se connectant et activant la synchronisation, la liste AniList remplace
  désormais entièrement la liste locale.
- Historique de visionnage refait : recherche, regroupement par date et reprise
  en un clic.

## [v0.0.2] — Notes par épisode & lecteurs plus fiables (2026-06-10)

### Ajouté
- Onglet **Notes** : les notes de la communauté pour chaque épisode, colorées
  et organisées saison par saison (plein écran avec déplacement/zoom, responsive).
- Reprise automatique : la progression de lecture est sauvegardée et restaurée
  entre les lecteurs et les appareils.

### Modifié
- Les recommandations de l'accueil n'affichent plus d'animes pas encore sortis.
- Le sélecteur de saison affiche « Pas encore sortie » pour les saisons à venir.

### Corrigé
- Les animes à plusieurs saisons diffusent enfin la bonne saison (fini la
  saison 2 qui jouait la saison 1) sur anime-sama / voir-anime.
- Lecteurs voir-anime manquants restaurés sur de nombreuses séries.
- VF manquante des premiers épisodes de One Piece, icônes des sites externes,
  traduction du message d'accueil, et changelog passant sous la barre de navigation.

### Retiré
- Le lecteur AnimeSaturn a été retiré.

## [v0.0.1] — Bêta publique (2026-06-04)

👋 Bienvenue sur AniScroll | un endroit rapide et épuré pour regarder des
animes, sans publicité ni traçage. 🔗 Connectez-vous avec votre compte AniList
pour synchroniser votre liste et conserver votre progression sur tous vos
appareils, ou lancez-vous directement.

🚧 Il s'agit de notre première bêta publique : c'est encore un peu brut. Vous
rencontrerez sûrement des bugs, des épisodes cassés ou quelques pépins. Si un
épisode ne se lance pas ou que quelque chose cloche, utilisez le **bouton
signaler** : choisissez le problème (ne se lance pas, mauvais sous-titres,
mauvais timings de skip…) et l'anime et l'épisode nous sont envoyés
automatiquement pour qu'on corrige vite. Vos retours façonnent l'app. 🙏

🩷 Merci d'avoir rejoint AniScroll dès ses débuts. Nous nous engageons à
construire une expérience de streaming rapide, fiable et sans publicité, et
votre soutien y contribue directement.
