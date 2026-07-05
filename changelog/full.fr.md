# Changelog

Toutes les nouveautés d'AniScroll, les plus récentes en premier.

## [v0.0.6] — Découverte & recommandations (2026-07-05)

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
- **Boutons Info & Regarder** : sur chaque fiche, ouvrez la fiche d'info ou
  lancez directement la lecture.
- **« Pour vous »** : un panneau de recommandations personnalisées basées sur
  votre liste AniList, avec le « pourquoi » de chaque suggestion. Deux modes
  (tout / à prévoir) et un bouton pour en générer de nouvelles.

## [v0.0.5] — Fiches, saisons & lecteurs (2026-07-03)

### Ajouté
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
