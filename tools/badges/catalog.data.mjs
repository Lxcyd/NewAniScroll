/**
 * LA SOURCE UNIQUE DU CATALOGUE DES BADGES.
 *
 * Une ligne par badge. `tools/badges/gen-catalog.mjs` en tire TROIS choses :
 *   - lib/badges/catalog.ts        (les définitions typées)
 *   - locales/fr.json > badges.*   (nom + condition)
 *   - locales/en.json > badges.*   (idem)
 *
 * Elles vivent ensemble parce qu'un badge sans libellé est un badge cassé, et
 * qu'un libellé orphelin est du poids mort : les tenir dans trois fichiers
 * séparés, c'est garantir qu'ils divergeront. Le générateur refuse d'écrire si
 * une ligne est incomplète.
 *
 * ── LA RÈGLE QUI COMPTE ──────────────────────────────────────────────────────
 * L'`id` est l'IDENTITÉ du badge et ne change JAMAIS. C'est lui qui est écrit
 * dans les données de l'utilisateur (`aniscroll:badges`), et le renommer
 * reviendrait à retirer le badge à tous ceux qui l'ont. Le libellé, lui, se
 * réécrit librement : il n'est qu'un affichage. Même règle que le `tag` des
 * comptes (devlog/comptes.md, 30/08/2026).
 *
 * ── LA FORME D'UNE LIGNE ─────────────────────────────────────────────────────
 *   [id, rareté, icône, pastille, métrique, frNom, frCondition, enNom, enCondition]
 *
 * rareté  : c(ommon) u(ncommon) r(are) e(pic) l(egendary) m(ythic)
 * icône   : une clé de lib/badges/icons.ts
 * pastille: ce qui s'écrit sur la plaque du jeton ("250", "10 000", "A-Z", "")
 * métrique: ce que l'évaluateur doit mesurer — cf. lib/badges/evaluate.ts.
 *           `n` est l'objectif quand la métrique en a un.
 */

/* ── Les métriques, en raccourcis ────────────────────────────────────────────
   Écrire `{ k: "count", of: "episodes", n: 250 }` 177 fois serait illisible ;
   ces fabriques disent la même chose en tenant sur la ligne du badge. */

/** Un compteur qui monte : épisodes, anime terminés, minutes, notes… */
const count = (of, n) => ({ k: "count", of, n });
/** Un geste ponctuel, enregistré dans `facts.flags`. Objectif : 1. */
const flag = (name) => ({ k: "flag", name, n: 1 });
/** Un compteur de gestes, dans `facts.counters`. */
const counter = (name, n) => ({ k: "counter", name, n });
/** Le meilleur total sur une fenêtre GLISSANTE de `ms` (cf. localtime.bestWindow). */
const window_ = (ms, n) => ({ k: "window", ms, n });
/** La plus grosse grappe de visionnage d'un seul tenant (une « nuit »). */
const night = (n) => ({ k: "night", n });
/** La plus longue séance, en heures ; `weekend` la restreint au samedi-dimanche. */
const session = (hours, weekend = false) => ({ k: "session", weekend, n: hours });
/** Au moins un épisode lancé dans cette plage d'heures LOCALES. */
const hourWin = (from, to) => ({ k: "hourWindow", from, to, n: 1 });
/** Un épisode lancé pendant la minute de minuit. */
const midnight = () => ({ k: "midnight", n: 1 });
/** Un visionnage à cette date du calendrier, éventuellement d'un genre donné. */
const onDate = (month, day, genre) => ({ k: "onDate", month, day, genre, n: 1 });
/** Anime TERMINÉS portant ce genre AniList. */
const genre = (name, n) => ({ k: "genre", name, n });
/** Anime terminés de ce format (MOVIE, OVA…). */
const format = (name, n) => ({ k: "format", name, n });
/** Terminer une œuvre précise : tous ses ids (`all`) ou n'importe lequel (`any`). */
const works = (key, mode = "all") => ({ k: "works", key, mode, n: 1 });
/** Dépasser N épisodes vus sur une œuvre précise. */
const worksEpisodes = (key, n) => ({ k: "worksEpisodes", key, n });

export const FAMILIES = [
  "episodes", "time", "sessions", "finished",
  "discovery", "genres", "franchise", "regularity", "profile", "secret",
];

/**
 * Les échelles de paliers. Un badge qui porte un `ladder` ne s'affiche pas seul :
 * l'onglet ne montre que le premier palier non atteint, les autres sont dans le
 * dépli (c'est la demande : « si j'ai 9 épisodes, montrer le badge des 10 »).
 * L'ordre des ids ici EST l'ordre des paliers, et le générateur vérifie qu'il
 * est strictement croissant.
 */
export const LADDERS = {
  episodes: ["ep-1", "ep-25", "ep-250", "ep-1000", "ep-5000", "ep-10000"],
  finished: ["fin-1", "fin-5", "fin-25", "fin-75", "fin-200", "fin-500"],
  time: ["time-10h", "time-1d", "time-7d", "time-30d", "time-100d", "time-365d"],
  streak: ["streak-7", "streak-30", "streak-90", "streak-180", "streak-270", "streak-365"],
  /* « Note posée » est le premier barreau de l'échelle des notes, pas un badge
     isolé : sans lui, quelqu'un qui n'a jamais noté verrait « 0 / 50 » comme
     prochain objectif là où le premier pas en demande un seul. */
  rated: ["first-rating", "rated-50", "rated-200"],
  /* PAS d'échelle pour les sessions, malgré les apparences. « 6 h d'affilée »
     et « 12 h sur un week-end » ne mesurent pas la même chose : on peut tenir
     douze heures un samedi sans jamais avoir fait six heures d'un trait en
     semaine, et l'inverse aussi. Les mettre en échelle cacherait l'un derrière
     l'autre dans le dépli alors qu'aucun des deux n'est le palier suivant. */
  collection: ["badges-50", "badges-75"],
  favourite: ["fav-1", "fav-10"],
};

/* ══════════════════════════════════════════════════════════════════════════ */

export const CATALOG = {

  /* ── Épisodes ─────────────────────────────────────────────────────────────
     Le compteur le plus visible du profil. Un « épisode vu » est un épisode
     DISTINCT terminé (cf. le traitement du re-visionnage dans evaluate.ts). */
  episodes: [
    ["ep-1", "c", "screen3", "1", count("episodes", 1),
      "Premier épisode", "1 épisode vu.",
      "First episode", "Watch 1 episode."],
    ["ep-25", "u", "screen3", "25", count("episodes", 25),
      "Vingt-cinq épisodes", "25 épisodes vus.",
      "Twenty-five episodes", "Watch 25 episodes."],
    ["ep-250", "r", "screen3", "250", count("episodes", 250),
      "Deux cent cinquante épisodes", "250 épisodes vus.",
      "Two hundred and fifty episodes", "Watch 250 episodes."],
    ["ep-1000", "e", "screen3", "1 000", count("episodes", 1000),
      "Mille épisodes", "1 000 épisodes vus.",
      "A thousand episodes", "Watch 1,000 episodes."],
    ["ep-5000", "l", "screen3", "5 000", count("episodes", 5000),
      "Cinq mille épisodes", "5 000 épisodes vus.",
      "Five thousand episodes", "Watch 5,000 episodes."],
    ["ep-10000", "m", "screen3", "10 000", count("episodes", 10000),
      "Dix mille épisodes", "10 000 épisodes vus.",
      "Ten thousand episodes", "Watch 10,000 episodes."],

    ["resume", "c", "resume", "", flag("resume"),
      "Reprise", "Reprendre un épisode là où on l'avait laissé.",
      "Picked up again", "Resume an episode where you left off."],
    ["spotlight", "c", "spotlight", "", flag("spotlight"),
      "Coup de projecteur", "Regarder un épisode conseillé dans le carrousel de la page d'accueil.",
      "Spotlight", "Watch an episode suggested in the home page carousel."],
    ["no-pause", "u", "noPause", "", flag("noPause"),
      "Sans une pause", "Un épisode entier sans mettre pause.",
      "No pause", "Watch a whole episode without pausing once."],
    ["burst-20", "r", "burst", "20", window_(86_400_000, 20),
      "Vingt en un jour", "20 épisodes vus en 24 h.",
      "Twenty in a day", "Watch 20 episodes within 24 hours."],
    ["burst-50", "e", "speed", "50", window_(7 * 86_400_000, 50),
      "Cinquante en une semaine", "50 épisodes vus en 7 jours.",
      "Fifty in a week", "Watch 50 episodes within 7 days."],
    ["night-12", "e", "flame", "12", night(12),
      "Douze d'un trait", "12 épisodes dans la même nuit.",
      "Twelve in one go", "Watch 12 episodes in a single night."],
    ["late-night", "u", "moon", "", hourWin(2, 5),
      "Deux heures du matin", "Lancer un épisode entre 2 h et 5 h.",
      "Two in the morning", "Start an episode between 2 and 5 a.m."],
    ["midnight", "r", "dialMoon", "00:00", midnight(),
      "Minuit pile", "Lancer un épisode à 00 h 00 pile.",
      "On the stroke of midnight", "Start an episode at exactly 00:00."],
    /* DERIVE, et non enregistre au vol : la liste et la table de progression
       portent deja de quoi repondre (le dernier episode vu, et lui seul). Un
       drapeau pose par le lecteur ne vaudrait que pour l'avenir ; ceci vaut
       aussi pour ce qui a deja ete regarde. */
    ["by-the-end", "u", "swap", "", { k: "onlyLastEpisode", n: 1 },
      "Par la fin", "Regarder le dernier épisode d'un anime sans en avoir vu aucun autre.",
      "Straight to the end", "Watch an anime's final episode without having seen any other."],
    ["lunch", "c", "cutlery", "", hourWin(12, 14),
      "Pause de midi", "Un épisode entre 12 h et 14 h.",
      "Lunch break", "Watch an episode between noon and 2 p.m."],
    ["airday-50", "r", "broadcast", "50", counter("onAirDay", 50),
      "Jour de diffusion", "50 épisodes vus le jour de leur sortie.",
      "Release day", "Watch 50 episodes on the day they aired."],
    ["w2g", "u", "screenTwin", "", flag("w2g"),
      "Côte à côte", "Terminer un épisode en Watch2Gether.",
      "Side by side", "Finish an episode in a Watch2Gether party."],
    ["oav", "u", "screenPlus", "", flag("oav"),
      "Bonus d'épisode", "Regarder un OAV rattaché à une série.",
      "Episode extra", "Watch an OVA attached to a series."],
    ["never-op", "r", "skipOff", "", { k: "neverSkipOp", n: 1 },
      "Jamais l'opening", "Ne jamais passer l'opening d'un anime entier.",
      "Never the opening", "Finish a whole anime without ever skipping the opening."],
  ],

  /* ── Temps cumulé ─────────────────────────────────────────────────────────
     Une seule échelle, en MINUTES en interne. Les minutes sont mesurées (la
     durée réelle du fichier, relevée par le lecteur), jamais estimées sur une
     moyenne : un temps inventé sur un profil est un chiffre faux. */
  time: [
    ["time-10h", "c", "hourglass", "10 H", count("minutes", 600),
      "Dix heures", "10 h de visionnage cumulées.",
      "Ten hours", "Ten hours watched in total."],
    ["time-1d", "u", "hourglass", "1 J", count("minutes", 1440),
      "Journée pleine", "1 jour cumulé, soit 24 h.",
      "A full day", "One full day watched — 24 hours."],
    ["time-7d", "r", "hourglass", "7 J", count("minutes", 7 * 1440),
      "Sept jours au compteur", "7 jours cumulés.",
      "Seven days on the clock", "Seven days watched in total."],
    ["time-30d", "e", "hourglass", "30 J", count("minutes", 30 * 1440),
      "Un mois ailleurs", "30 jours cumulés.",
      "A month elsewhere", "Thirty days watched in total."],
    ["time-100d", "l", "hourglass", "100 J", count("minutes", 100 * 1440),
      "Cent jours au compteur", "100 jours cumulés, soit 2 400 h.",
      "A hundred days on the clock", "A hundred days watched — 2,400 hours."],
    ["time-365d", "m", "hourglass", "365 J", count("minutes", 365 * 1440),
      "Une année entière", "365 jours cumulés devant le lecteur.",
      "A whole year", "365 days spent in front of the player."],
  ],

  /* ── Sessions ─────────────────────────────────────────────────────────────
     Ce qui se joue en une seule traite. La séance est une GRAPPE d'activité,
     pas une date : une soirée qui passe minuit reste une soirée. */
  sessions: [
    ["session-6h", "r", "dialMoon", "6 H", session(6),
      "Six heures d'affilée", "6 h de suite dans la même session.",
      "Six hours straight", "Six hours in a single sitting."],
    ["session-12h", "e", "weekend", "12 H", session(12, true),
      "Marathon de week-end", "12 h sur un samedi-dimanche.",
      "Weekend marathon", "Twelve hours over one weekend."],
  ],

  /* ── Anime terminés ───────────────────────────────────────────────────────
     « Terminé » = le statut COMPLETED de la liste, celui qu'AniList et la liste
     locale partagent. Le re-visionnage (REPEATING) compte aussi : on ne
     re-regarde que ce qu'on a fini une fois — même raison que FINISHED dans
     lib/profile/insights.ts. */
  finished: [
    ["fin-1", "c", "bookmarkCheck", "1", count("completed", 1),
      "Premier anime", "Terminer un premier anime.",
      "First anime", "Finish your first anime."],
    ["fin-5", "u", "bookmarkCheck", "5", count("completed", 5),
      "Cinq terminés", "5 anime terminés.",
      "Five finished", "Finish 5 anime."],
    ["fin-25", "r", "bookmarkCheck", "25", count("completed", 25),
      "Vingt-cinq terminés", "25 anime terminés.",
      "Twenty-five finished", "Finish 25 anime."],
    ["fin-75", "e", "bookmarkCheck", "75", count("completed", 75),
      "Soixante-quinze terminés", "75 anime terminés.",
      "Seventy-five finished", "Finish 75 anime."],
    ["fin-200", "l", "bookmarkCheck", "200", count("completed", 200),
      "Deux cents terminés", "200 anime terminés.",
      "Two hundred finished", "Finish 200 anime."],
    ["fin-500", "m", "bookmarkCheck", "500", count("completed", 500),
      "Cinq cents terminés", "500 anime terminés.",
      "Five hundred finished", "Finish 500 anime."],
  ],

  /* ── Découverte ───────────────────────────────────────────────────────────
     Fouiller le catalogue au-delà des sorties du moment. Plusieurs de ces
     badges ont besoin de métadonnées d'œuvre (année, studio, format,
     popularité) que la liste locale ne porte pas d'origine : tant qu'elles
     manquent, le badge est « pas encore mesurable » et jamais « 0 % ». */
  discovery: [
    ["first-add", "c", "bookmark", "", { k: "listSize", n: 1 },
      "Premier pas", "Ajouter un premier anime à sa liste.",
      "First step", "Add your first anime to your list."],
    ["curious-10", "c", "curious", "10", counter("animeOpened", 10),
      "Curieux", "Ouvrir la fiche de dix anime différents.",
      "Curious", "Open ten different anime pages."],
    ["hidden-gem", "u", "gem", "", { k: "popularityUnder", max: 5000, n: 1 },
      "Pépite oubliée", "Terminer un anime vu par moins de 5 000 personnes.",
      "Forgotten gem", "Finish an anime with fewer than 5,000 viewers."],
    ["archive-1990", "u", "layers", "", { k: "yearBefore", year: 1990, n: 1 },
      "Fonds d'archive", "Terminer un anime d'avant 1990.",
      "From the archives", "Finish an anime released before 1990."],
    ["pioneer-1975", "e", "history", "", { k: "yearBefore", year: 1975, n: 1 },
      "Pionnier", "Terminer un anime sorti avant 1975.",
      "Pioneer", "Finish an anime released before 1975."],
    ["decades", "l", "timeline", "", { k: "decades", from: 1970, n: 6 },
      "Traversée des décennies", "Un anime terminé dans chaque décennie depuis 1970.",
      "Across the decades", "Finish an anime from every decade since 1970."],
    ["big-three", "u", "three", "", works("bigThree", "any"),
      "Les trois grands", "Commencer un anime du big 3.",
      "The big three", "Start one of the big three."],
    ["planning", "c", "calendarPlus", "", flag("planning"),
      "Liste d'attente", "Ajouter un anime pas encore diffusé.",
      "Waiting list", "Add an anime that hasn't aired yet."],
    ["two-voices", "u", "speech", "", flag("bothLangs"),
      "Deux voix", "Regarder le même épisode en VO puis en VF.",
      "Two voices", "Watch the same episode subbed, then dubbed."],
    ["blind-pick", "c", "shuffle", "", flag("random"),
      "À l'aveugle", "Lancer un anime choisi au hasard.",
      "Blind pick", "Start an anime chosen at random."],
    ["studio-10", "r", "clapper", "10", { k: "studio", n: 10 },
      "Signature de studio", "Terminer 10 anime du même studio.",
      "Studio signature", "Finish 10 anime from the same studio."],
    ["rewatch-1", "r", "loop", "", count("rewatched", 1),
      "Deuxième tour", "Revoir une série déjà terminée.",
      "Second time around", "Rewatch a series you had already finished."],
    ["rewatch-10", "e", "loop", "10", count("rewatched", 10),
      "Éternel retour", "Revoir dix séries déjà terminées.",
      "Eternal return", "Rewatch ten series you had already finished."],
    ["thrice", "e", "again3", "3", { k: "repeatSame", times: 3, n: 1 },
      "Trois fois n'est pas coutume", "Terminer trois fois le même anime.",
      "Third time lucky", "Finish the same anime three times."],
    ["comeback", "u", "flame", "", flag("comeback"),
      "Retour de flamme", "Reprendre une série après 30 jours d'absence.",
      "Rekindled", "Pick a series back up after 30 days away."],
    ["day-one", "r", "dayD", "", flag("dayOne"),
      "Jour J", "Terminer un anime le jour même de sa sortie.",
      "Day one", "Finish an anime on its release day."],
    /* Commence et termine le meme jour : les deux dates sont sur l'entree de
       liste, il n'y a rien a observer en direct. */
    ["one-sitting", "r", "flame", "", { k: "sameDayFinish", n: 1 },
      "D'une traite", "Commencer et terminer un anime dans la même journée.",
      "In one sitting", "Start and finish an anime on the same day."],
    ["movies-30", "e", "cinema", "30", format("MOVIE", 30),
      "Rien que des films", "Terminer 30 films.",
      "Films only", "Finish 30 films."],
    ["alphabet", "l", "alphabet", "A-Z", { k: "alphabet", n: 26 },
      "Complétiste alphabétique", "Terminer un anime pour chaque lettre de l'alphabet.",
      "Alphabet completionist", "Finish an anime for every letter of the alphabet."],
    ["long-title", "r", "longTitle", "100+", { k: "titleLength", min: 100, n: 1 },
      "Titre à rallonge", "Terminer un anime dont le titre dépasse 100 caractères.",
      "Mouthful of a title", "Finish an anime whose title runs past 100 characters."],
    ["all-players", "r", "players", "", { k: "hosts", n: 0 },
      "Tous les lecteurs", "Regarder un épisode sur chacun des lecteurs disponibles.",
      "Every player", "Watch an episode on each available player."],
    ["halloween", "u", "skullNight", "31/10", onDate(10, 31, "Horror"),
      "Nuit d'Halloween", "Regarder un anime d'horreur le 31 octobre.",
      "Halloween night", "Watch a horror anime on 31 October."],
    ["valentine", "u", "heart", "14/02", onDate(2, 14, "Romance"),
      "Saint-Valentin", "Regarder une romance le 14 février.",
      "Valentine's Day", "Watch a romance on 14 February."],
    ["april-fool", "u", "fishHook", "01/04", onDate(4, 1, "Comedy"),
      "Poisson d'avril", "Regarder une comédie le 1er avril.",
      "April Fools'", "Watch a comedy on 1 April."],
  ],

  /* ── Genres ───────────────────────────────────────────────────────────────
     Un badge par famille, sur les anime TERMINÉS. Les noms de genres sont ceux
     d'AniList, en anglais, parce que c'est ce que portent les données — la
     traduction se fait à l'affichage (lib/i18n/genreLabel.ts). */
  genres: [
    ["g-action", "r", "fist", "30", genre("Action", 30),
      "Shōnen dans le sang", "Terminer 30 anime d'action.",
      "Shōnen blood", "Finish 30 action anime."],
    ["g-romance", "r", "partnerHeart", "20", genre("Romance", 20),
      "Cœur d'artichaut", "Terminer 20 romances.",
      "Hopeless romantic", "Finish 20 romances."],
    ["g-horror", "r", "horror", "15", genre("Horror", 15),
      "Frisson garanti", "Terminer 15 anime d'horreur.",
      "Guaranteed chills", "Finish 15 horror anime."],
    ["g-mecha", "r", "robot", "10", genre("Mecha", 10),
      "Pilote de mecha", "Terminer 10 anime mecha.",
      "Mecha pilot", "Finish 10 mecha anime."],
    ["g-slice", "r", "leaf", "20", genre("Slice of Life", 20),
      "Tranche de vie", "Terminer 20 slice of life.",
      "Slice of life", "Finish 20 slice-of-life anime."],
    ["g-isekai", "r", "reborn", "15", { k: "tag", name: "Isekai", n: 15 },
      "Réincarné", "Terminer 15 isekai. Le camion n'y est pour rien.",
      "Reincarnated", "Finish 15 isekai. The truck had nothing to do with it."],
    ["g-fantasy", "r", "castle", "20", genre("Fantasy", 20),
      "Chasseur de dragons", "Terminer 20 anime de fantasy.",
      "Dragon hunter", "Finish 20 fantasy anime."],
    ["g-scifi", "r", "rocket", "15", genre("Sci-Fi", 15),
      "Voyageur stellaire", "Terminer 15 anime de science-fiction.",
      "Star traveller", "Finish 15 sci-fi anime."],
    ["g-mystery", "r", "magnifier", "15", genre("Mystery", 15),
      "Détective", "Terminer 15 anime à mystère.",
      "Detective", "Finish 15 mystery anime."],
    ["g-drama", "r", "teardrop", "20", genre("Drama", 20),
      "Larmes aux yeux", "Terminer 20 drames.",
      "Teary-eyed", "Finish 20 dramas."],
    ["g-comedy", "r", "laugh", "25", genre("Comedy", 25),
      "Fou rire", "Terminer 25 comédies.",
      "Fits of laughter", "Finish 25 comedies."],
    ["g-sports", "r", "volley", "10", genre("Sports", 10),
      "Esprit d'équipe", "Terminer 10 anime de sport.",
      "Team spirit", "Finish 10 sports anime."],
    ["g-music", "r", "note", "10", genre("Music", 10),
      "Sur scène", "Terminer 10 anime musicaux.",
      "On stage", "Finish 10 music anime."],
    ["g-psycho", "r", "knightPiece", "10", genre("Psychological", 10),
      "Mind game", "Terminer 10 anime psychologiques.",
      "Mind game", "Finish 10 psychological anime."],
    ["g-thriller", "r", "eye", "10", genre("Thriller", 10),
      "Sueurs froides", "Terminer 10 thrillers.",
      "Cold sweat", "Finish 10 thrillers."],
    ["g-school", "r", "school", "20", { k: "tag", name: "School", n: 20 },
      "Club de fin de journée", "Terminer 20 anime scolaires.",
      "After-school club", "Finish 20 school anime."],
    ["g-food", "r", "chef", "5", { k: "tag", name: "Food", n: 5 },
      "Toque d'or", "Terminer 5 anime de cuisine.",
      "Golden toque", "Finish 5 cooking anime."],
    ["all-genres", "e", "genresAll", "", { k: "allGenres", n: 0 },
      "Tous les genres", "Terminer un anime dans chacun des genres du catalogue.",
      "Every genre", "Finish an anime in every genre of the catalogue."],
    ["all-tags", "m", "tagsAll", "", { k: "allTags", n: 0 },
      "Tous les tags", "Terminer un anime portant chacun des tags du catalogue.",
      "Every tag", "Finish an anime carrying every tag of the catalogue."],
  ],

  /* ── Franchises ───────────────────────────────────────────────────────────
     Aller au bout d'une saga. La chaîne des saisons est reconstruite côté
     client à partir des relations AniList déjà en cache sur les entrées de la
     liste (`relIds`), sans interroger notre propre base. */
  franchise: [
    ["saga-2", "r", "rings", "", { k: "franchise", seasons: 2, n: 1 },
      "Saga bouclée", "Toutes les saisons d'une franchise (2 saisons minimum).",
      "Saga complete", "Every season of a franchise (two seasons minimum)."],
    ["saga-4", "e", "rings", "4", { k: "franchise", seasons: 4, n: 1 },
      "Grande saga", "Toutes les saisons d'une franchise d'au moins quatre saisons.",
      "Great saga", "Every season of a franchise of at least four seasons."],
  ],

  /* ── Régularité ───────────────────────────────────────────────────────────
     La série de jours consécutifs. Jours CALENDAIRES locaux : elle survit au
     changement d'heure et au voyage (cf. lib/badges/localtime.ts). */
  regularity: [
    ["streak-7", "u", "calendarCheck", "7 J", count("streak", 7),
      "Une semaine", "7 jours consécutifs.",
      "One week", "Seven consecutive days."],
    ["streak-30", "u", "calendarCheck", "30 J", count("streak", 30),
      "Un mois", "30 jours consécutifs.",
      "One month", "Thirty consecutive days."],
    ["streak-90", "r", "calendarCheck", "90 J", count("streak", 90),
      "Un trimestre", "90 jours consécutifs.",
      "One quarter", "Ninety consecutive days."],
    ["streak-180", "e", "calendarCheck", "180 J", count("streak", 180),
      "Six mois", "180 jours consécutifs.",
      "Six months", "A hundred and eighty consecutive days."],
    ["streak-270", "l", "calendarCheck", "270 J", count("streak", 270),
      "Neuf mois", "270 jours consécutifs.",
      "Nine months", "Two hundred and seventy consecutive days."],
    ["streak-365", "m", "calendarCheck", "365 J", count("streak", 365),
      "Un an", "365 jours consécutifs.",
      "One year", "Three hundred and sixty-five consecutive days."],
  ],

  /* ── Profil et collection ─────────────────────────────────────────────────
     Tenir sa liste, noter, ranger — et collectionner les badges eux-mêmes. */
  profile: [
    ["rated-50", "u", "starList", "50", count("rated", 50),
      "Critique", "Noter 50 titres.",
      "Critic", "Rate 50 titles."],
    ["rated-200", "r", "starList", "200", count("rated", 200),
      "Critique confirmé", "Noter 200 titres.",
      "Seasoned critic", "Rate 200 titles."],
    ["fav-1", "c", "heart", "1", count("favourites", 1),
      "Coups de cœur", "Mettre un anime en favori.",
      "Favourite", "Mark an anime as a favourite."],
    ["fav-10", "u", "heart", "10", count("favourites", 10),
      "Dix coups de cœur", "Ajouter dix anime en favoris.",
      "Ten favourites", "Mark ten anime as favourites."],
    ["first-rating", "c", "starList", "1", count("rated", 1),
      "Note posée", "Noter son premier anime.",
      "First rating", "Rate your first anime."],
    ["avatar", "c", "selfie", "", flag("avatar"),
      "Avatar", "Personnaliser sa photo de profil.",
      "Avatar", "Set a profile picture of your own."],
    ["share-link", "c", "copyLink", "", flag("copyLink"),
      "Épisode partagé", "Copier le lien d'un anime.",
      "Shared", "Copy an anime's link."],
    ["settings", "c", "gear", "", flag("settings"),
      "Réglages", "Ouvrir les paramètres.",
      "Settings", "Open the settings."],
    ["custom-list", "c", "listPlus", "", flag("customList"),
      "Rangement", "Créer une liste personnalisée.",
      "Tidy", "Create a custom list."],
    ["one-year-here", "r", "cake", "", { k: "accountAge", days: 365, n: 365 },
      "Un an ici", "Un an sur AniScroll.",
      "A year here", "One year on AniScroll."],
    ["badges-50", "e", "hexCluster", "50", count("badges", 50),
      "Cinquante badges", "Obtenir 50 badges.",
      "Fifty badges", "Earn 50 badges."],
    ["badges-75", "l", "hexCluster", "75", count("badges", 75),
      "Soixante-quinze badges", "Obtenir 75 badges.",
      "Seventy-five badges", "Earn 75 badges."],
    ["legendary-5", "l", "trophy", "5", { k: "rarityCount", rarity: "l", n: 5 },
      "Cinq légendaires", "Obtenir cinq badges légendaires.",
      "Five legendaries", "Earn five legendary badges."],
    ["showcase-open", "c", "gridFull", "", flag("badgesTab"),
      "Vitrine ouverte", "Ouvrir sa page de badges.",
      "Showcase open", "Open your badges page."],
    ["secret-50", "l", "question", "50", { k: "secretCount", n: 50 },
      "Chasseur de secrets", "Obtenir 50 badges secrets.",
      "Secret hunter", "Earn 50 secret badges."],
    ["complete", "m", "hexCluster", "100 %", { k: "allBadges", n: 0 },
      "Collection complète", "Obtenir tous les autres badges.",
      "Full collection", "Earn every other badge."],
  ],

  /* ── Secret ───────────────────────────────────────────────────────────────
     Hors progression ET HORS TOTAL : ils ne comptent pas dans les 101 badges
     annoncés. Leur nom s'affiche, leur condition reste floutée tant qu'ils ne
     sont pas obtenus — et le texte réel n'est PAS rendu dans le DOM. */
  secret: [
    ["anilist-linked", "u", "link", "", flag("anilistLinked"),
      "Compte lié", "Lier son compte AniList.",
      "Account linked", "Link your AniList account."],
    ["staff", "m", "shieldCheck", "STAFF", { k: "granted", n: 1 },
      "Équipe", "Réservé à l'administration.",
      "Staff", "Reserved for the administration."],
    ["beta", "l", "bookmark", "BETA", { k: "granted", n: 1 },
      "Bêta", "Compte créé pendant la bêta.",
      "Beta", "Account created during the beta."],
    ["changelog", "c", "film", "", flag("changelog"),
      "Lecteur de notes", "Lire la page changelog jusqu'en bas.",
      "Release-note reader", "Read the changelog page all the way down."],
    ["dead-end", "u", "screenBroken", "404", counter("notFound", 3),
      "Cul-de-sac", "Tomber trois fois sur la page introuvable.",
      "Dead end", "Land on the not-found page three times."],
    ["konami", "e", "dpad", "", flag("konami"),
      "Séquence secrète", "Saisir la séquence de touches qui traîne dans le code.",
      "Secret sequence", "Enter the key sequence hidden in the code."],
    ["devtools", "r", "console", "", flag("devtools"),
      "Inspecteur", "Ouvrir la console de développement.",
      "Inspector", "Open the developer console."],
    ["dmca", "r", "gavel", "3 MIN", flag("dmca"),
      "Lecture attentive", "Rester trois minutes sur la page DMCA.",
      "Close reading", "Spend three minutes on the DMCA page."],
    ["recursive", "r", "loupeSelf", "", flag("recursive"),
      "Récursif", "Chercher « AniScroll » dans la recherche d'AniScroll.",
      "Recursive", "Search for “AniScroll” in AniScroll's search."],
    ["not-here", "u", "noEntry", "", flag("notHere"),
      "Pas sur ce site", "Chercher « hentai ». Ce n'est pas ici.",
      "Not on this site", "Search for “hentai”. Not here."],
    ["polyglot", "u", "translate", "10", flag("polyglot"),
      "Traducteur", "Changer la langue de l'interface dix fois en une minute.",
      "Translator", "Switch the interface language ten times in a minute."],
    ["oldest", "r", "oldest", "", flag("oldest"),
      "Le tout premier", "Ouvrir la fiche de l'anime le plus ancien du catalogue.",
      "The very first", "Open the page of the catalogue's oldest anime."],
    ["self-search", "c", "selfie", "", flag("selfSearch"),
      "Autoportrait", "Chercher son propre pseudo dans la recherche.",
      "Self-portrait", "Search for your own username."],
    ["pin-mythic", "u", "showcase", "", flag("pinMythic"),
      "Vitrine", "Épingler un badge mythique sur son profil.",
      "Showcase", "Pin a mythic badge to your profile."],

    ["one-piece", "m", "compass", "", works("onePiece"),
      "Trouver le One Piece", "Terminer l'anime One Piece.",
      "Find the One Piece", "Finish One Piece."],
    ["hokage", "m", "ninja", "", works("naruto"),
      "Devenir Hokage", "Terminer Naruto et Naruto Shippuden.",
      "Become Hokage", "Finish Naruto and Naruto Shippuden."],
    ["boruto", "l", "scroll", "", works("boruto"),
      "La relève", "Terminer Boruto.",
      "The next generation", "Finish Boruto."],
    ["super-saiyan", "m", "aura", "", works("dragonBall"),
      "Au-delà du Super Saiyan", "Terminer Dragon Ball, Dragon Ball Z et Dragon Ball Super.",
      "Beyond Super Saiyan", "Finish Dragon Ball, Dragon Ball Z and Dragon Ball Super."],
    ["hashira", "e", "blade", "", works("demonSlayer"),
      "Dernier des Hashira", "Terminer Demon Slayer, films inclus.",
      "Last of the Hashira", "Finish Demon Slayer, films included."],
    ["walls", "l", "wall", "", works("aot"),
      "Liberté derrière les murs", "Terminer L'Attaque des Titans.",
      "Freedom behind the walls", "Finish Attack on Titan."],
    ["hunter-licence", "l", "crown", "", works("hxh"),
      "Chasseur licencié", "Terminer Hunter x Hunter.",
      "Licensed hunter", "Finish Hunter x Hunter."],
    ["bankai", "l", "skull", "", works("bleach"),
      "Bankai", "Terminer Bleach, Thousand-Year Blood War inclus.",
      "Bankai", "Finish Bleach, Thousand-Year Blood War included."],
    ["equivalent-exchange", "l", "spell", "", works("fmab"),
      "Le prix de l'équivalence", "Terminer Fullmetal Alchemist: Brotherhood.",
      "The price of equivalence", "Finish Fullmetal Alchemist: Brotherhood."],
    ["conan-1000", "m", "sleuth", "1 000", worksEpisodes("conan", 1000),
      "Mille enquêtes", "Dépasser 1 000 épisodes de Détective Conan.",
      "A thousand cases", "Pass 1,000 episodes of Detective Conan."],
    ["pokemon-500", "m", "cat", "500", worksEpisodes("pokemon", 500),
      "Attrapez-les tous", "Dépasser 500 épisodes de Pokémon.",
      "Catch them all", "Pass 500 episodes of Pokémon."],
    ["plus-ultra", "e", "titan", "", works("mha"),
      "Plus Ultra", "Terminer My Hero Academia.",
      "Plus Ultra", "Finish My Hero Academia."],
    ["death-note", "e", "pen", "", works("deathNote"),
      "Le cahier", "Terminer Death Note.",
      "The notebook", "Finish Death Note."],
    ["jujutsu", "e", "spiral", "", works("jjk"),
      "Exorciste diplômé", "Terminer Jujutsu Kaisen.",
      "Qualified exorcist", "Finish Jujutsu Kaisen."],
    ["chainsaw", "r", "chain", "", works("chainsawMan"),
      "Contrat signé avec un démon", "Terminer Chainsaw Man.",
      "Contract signed with a devil", "Finish Chainsaw Man."],
    ["rank-s", "r", "gun", "", works("opm"),
      "Rang S", "Terminer One Punch Man.",
      "S-Class", "Finish One Punch Man."],
    ["black-clover", "e", "spell", "", works("blackClover"),
      "Sorcier autodidacte", "Terminer Black Clover.",
      "Self-taught wizard", "Finish Black Clover."],
    ["steins-gate", "e", "clockRed", "", works("steinsGate"),
      "La sonnerie du réveil", "Terminer Steins;Gate.",
      "The ringing of the alarm", "Finish Steins;Gate."],
    ["re-zero", "e", "clockRed", "", works("reZero"),
      "Retour à zéro", "Terminer Re:Zero.",
      "Return by death", "Finish Re:Zero."],
    ["sao", "r", "guild", "", works("sao"),
      "Maître de guilde", "Terminer Sword Art Online.",
      "Guild master", "Finish Sword Art Online."],
    ["slime", "r", "slime", "", works("slime"),
      "Roi des slimes", "Terminer Moi, quand je me réincarne en Slime.",
      "King of the slimes", "Finish That Time I Got Reincarnated as a Slime."],
    ["shield-hero", "r", "wall", "", works("shieldHero"),
      "Bouclier levé", "Terminer The Rising of the Shield Hero.",
      "Shield raised", "Finish The Rising of the Shield Hero."],
    ["mushoku", "r", "scroll", "", works("mushoku"),
      "Deuxième vie studieuse", "Terminer Mushoku Tensei.",
      "A studious second life", "Finish Mushoku Tensei."],
    ["overlord", "r", "crown", "", works("overlord"),
      "Seigneur du tombeau", "Terminer Overlord.",
      "Lord of the tomb", "Finish Overlord."],
    ["konosuba", "r", "guild", "", works("konosuba"),
      "Party complet", "Terminer Konosuba.",
      "Full party", "Finish Konosuba."],
    ["frieren", "e", "sunflower", "", works("frieren"),
      "Deux mondes", "Terminer Frieren.",
      "Two worlds", "Finish Frieren."],
    ["solo-leveling", "r", "gun", "", works("soloLeveling"),
      "Chasseur de rang E", "Terminer Solo Leveling.",
      "E-rank hunter", "Finish Solo Leveling."],
    ["code-geass", "l", "mechaG", "", works("codeGeass"),
      "Masque de Zero", "Terminer Code Geass.",
      "Zero's mask", "Finish Code Geass."],
    ["evangelion", "l", "mechaG", "", works("evangelion"),
      "Coquille vide", "Terminer Neon Genesis Evangelion.",
      "Empty shell", "Finish Neon Genesis Evangelion."],
    ["bebop", "l", "bounty", "", works("bebop"),
      "Prime encaissée", "Terminer Cowboy Bebop.",
      "Bounty collected", "Finish Cowboy Bebop."],
    ["champloo", "e", "blade", "", works("champloo"),
      "Trois vagabonds", "Terminer Samurai Champloo.",
      "Three drifters", "Finish Samurai Champloo."],
    ["ghost-shell", "l", "space", "", works("gits"),
      "Fantôme dans la coque", "Terminer Ghost in the Shell: Stand Alone Complex.",
      "Ghost in the shell", "Finish Ghost in the Shell: Stand Alone Complex."],
    ["trigun", "e", "gun", "", works("trigun"),
      "L'ouragan humanoïde", "Terminer Trigun.",
      "The humanoid typhoon", "Finish Trigun."],
    ["berserk", "l", "skull", "", works("berserk"),
      "L'armure noire", "Terminer Berserk.",
      "The black armour", "Finish Berserk."],
    ["monster", "l", "sleuth", "", works("monster"),
      "Sans nom", "Terminer Monster.",
      "Nameless", "Finish Monster."],
    ["vinland", "e", "blade", "", works("vinland"),
      "Terre promise", "Terminer Vinland Saga.",
      "Promised land", "Finish Vinland Saga."],
    ["kingdom", "e", "crown", "", works("kingdom"),
      "Sous un seul ciel", "Terminer Kingdom.",
      "Under one sky", "Finish Kingdom."],
    ["ngnl", "r", "card", "", works("ngnl"),
      "Le vrai jeu", "Terminer No Game No Life.",
      "The real game", "Finish No Game No Life."],
    ["yugioh", "l", "card", "", works("yugioh"),
      "Duel de rois", "Terminer Yu-Gi-Oh! Duel Monsters.",
      "Duel of kings", "Finish Yu-Gi-Oh! Duel Monsters."],
    ["haikyu", "e", "volley", "", works("haikyu"),
      "Le smash d'équipe", "Terminer Haikyu!!.",
      "The team spike", "Finish Haikyu!!."],
    ["kuroko", "e", "hoop", "", works("kuroko"),
      "Panier gagnant", "Terminer Kuroko's Basket.",
      "Winning basket", "Finish Kuroko's Basketball."],
    ["blue-lock", "r", "ball", "", works("blueLock"),
      "Coup franc", "Terminer Blue Lock.",
      "Free kick", "Finish Blue Lock."],
    ["yowamushi", "e", "bike", "", works("yowamushi"),
      "Dernier tour de piste", "Terminer Yowamushi Pedal.",
      "Final lap", "Finish Yowamushi Pedal."],
    ["slam-dunk", "l", "hoop", "", works("slamDunk"),
      "Dans les gradins", "Terminer Slam Dunk.",
      "In the stands", "Finish Slam Dunk."],
    ["food-wars", "e", "pot", "", works("foodWars"),
      "Assiette parfaite", "Terminer Food Wars.",
      "The perfect plate", "Finish Food Wars."],
    ["assassination", "r", "school", "", works("ansatsu"),
      "Scan final", "Terminer Assassination Classroom.",
      "Final scan", "Finish Assassination Classroom."],
    ["fruits-basket", "e", "gearHeart", "", works("fruitsBasket"),
      "Les douze signes", "Terminer Fruits Basket.",
      "The twelve signs", "Finish Fruits Basket."],
    ["toradora", "r", "gearHeart", "", works("toradora"),
      "Tigre et dragon", "Terminer Toradora!.",
      "Tiger and dragon", "Finish Toradora!."],
    ["clannad", "e", "teapot", "", works("clannad"),
      "La ville qui se souvient", "Terminer Clannad et After Story.",
      "The town that remembers", "Finish Clannad and After Story."],
    ["your-lie", "e", "note", "", works("yourLie"),
      "Mensonge d'avril", "Terminer Your Lie in April.",
      "April's lie", "Finish Your Lie in April."],
    /* Ghibli se lit dans le STUDIO, pas dans une liste d'ids : une liste aurait
       vieilli à la sortie du film suivant, et le studio est déjà mis en cache
       sur l'entrée de liste. */
    ["ghibli-1", "u", "movies", "", { k: "studioNamed", name: "Studio Ghibli", n: 1 },
      "Voisin Totoro", "Terminer un film du studio Ghibli.",
      "Neighbour Totoro", "Finish a Studio Ghibli film."],
    ["ghibli-10", "l", "movies", "10", { k: "studioNamed", name: "Studio Ghibli", n: 10 },
      "Anthologie Ghibli", "Terminer dix films du studio Ghibli.",
      "Ghibli anthology", "Finish ten Studio Ghibli films."],
    ["shinkai", "e", "twilight", "", works("shinkai"),
      "Shinkai complet", "Terminer tous les films de Makoto Shinkai.",
      "Complete Shinkai", "Finish every Makoto Shinkai film."],
    ["gintama", "m", "tape", "", works("gintama"),
      "Cassette de Gintama", "Terminer Gintama.",
      "The Gintama tape", "Finish Gintama."],
    ["mirai-nikki", "r", "diary", "", works("miraiNikki"),
      "Journal du futur", "Terminer Mirai Nikki.",
      "Future diary", "Finish Mirai Nikki."],
    ["jojo", "m", "aura", "", works("jojo"),
      "JoJo jusqu'au bout", "Terminer toutes les parties de JoJo's Bizarre Adventure.",
      "JoJo to the end", "Finish every part of JoJo's Bizarre Adventure."],
    ["spy-family", "r", "gearHeart", "", works("spyFamily"),
      "Le monde de Spy", "Terminer Spy x Family.",
      "The world of Spy", "Finish Spy x Family."],
    ["dr-stone", "e", "spell", "", works("drStone"),
      "Dix milliards de pourcent", "Terminer Dr. Stone.",
      "Ten billion percent", "Finish Dr. Stone."],
    ["tokyo-ghoul", "e", "skull", "", works("tokyoGhoul"),
      "Mille et un masques", "Terminer Tokyo Ghoul.",
      "A thousand masks", "Finish Tokyo Ghoul."],
    ["parasyte", "r", "slime", "", works("parasyte"),
      "La main droite", "Terminer Parasyte.",
      "The right hand", "Finish Parasyte."],
    ["neverland", "r", "scroll", "", works("neverland"),
      "Par-dessus le mur", "Terminer The Promised Neverland.",
      "Over the wall", "Finish The Promised Neverland."],
  ],
};
