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
      "Premier pas", "Regarde ton premier épisode.",
      "First step", "Watch your first episode."],
    ["ep-25", "u", "screen3", "25", count("episodes", 25),
      "Habitué", "Regarde 25 épisodes.",
      "Regular", "Watch 25 episodes."],
    ["ep-250", "r", "screen3", "250", count("episodes", 250),
      "Passionné", "Regarde 250 épisodes.",
      "Enthusiast", "Watch 250 episodes."],
    ["ep-1000", "e", "screen3", "1 000", count("episodes", 1000),
      "Élite", "Regarde 1 000 épisodes.",
      "Elite", "Watch 1,000 episodes."],
    ["ep-5000", "l", "screen3", "5 000", count("episodes", 5000),
      "Vétéran", "Regarde 5 000 épisodes.",
      "Veteran", "Watch 5,000 episodes."],
    ["ep-10000", "m", "screen3", "10 000", count("episodes", 10000),
      "Légende", "Regarde 10 000 épisodes.",
      "Legend", "Watch 10,000 episodes."],

    ["resume", "c", "resume", "", flag("resume"),
      "Où j'en étais ?", "Reprends un épisode là où tu l'avais laissé.",
      "Where was I?", "Pick an episode back up where you left off."],
    ["spotlight", "c", "spotlight", "", flag("spotlight"),
      "Coup de projecteur", "Lance un épisode depuis le carrousel de l'accueil.",
      "Spotlight", "Start an episode from the home page carousel."],
    ["no-pause", "u", "noPause", "", flag("noPause"),
      "D'une traite", "Regarde un épisode entier sans jamais mettre pause.",
      "In one go", "Watch a whole episode without pausing once."],
    ["burst-20", "r", "burst", "20", window_(86_400_000, 20),
      "Streaming Intensif", "Regarde 20 épisodes en 24 heures.",
      "Intensive Streaming", "Watch 20 episodes within 24 hours."],
    ["burst-50", "e", "speed", "50", window_(7 * 86_400_000, 50),
      "Marathon", "Regarde 50 épisodes en 7 jours.",
      "Marathon", "Watch 50 episodes within 7 days."],
    ["night-12", "e", "flame", "12", night(12),
      "Nuit blanche", "Enchaîne 12 épisodes dans la même séance.",
      "All-nighter", "Watch 12 episodes in a single sitting."],
    ["late-night", "u", "moon", "", hourWin(2, 5),
      "Insomnie", "Lance un épisode entre 2 h et 5 h du matin.",
      "Night owl", "Start an episode between 2 and 5 a.m."],
    ["midnight", "r", "dialMoon", "00:00", midnight(),
      "Minuit", "Lance un épisode à 00 h 00 pile.",
      "Midnight", "Start an episode at exactly 00:00."],
    /* DERIVE, et non enregistre au vol : la liste et la table de progression
       portent deja de quoi repondre (le dernier episode vu, et lui seul). Un
       drapeau pose par le lecteur ne vaudrait que pour l'avenir ; ceci vaut
       aussi pour ce qui a deja ete regarde. */
    ["by-the-end", "u", "swap", "", { k: "onlyLastEpisode", n: 1 },
      "Spoilé", "Regarde le dernier épisode d'un anime sans avoir vu les autres.",
      "Spoil", "Watch the last episode of an anime without having seen any of the others."],
    ["lunch", "c", "cutlery", "", hourWin(12, 14),
      "Pause déj", "Lance un épisode entre midi et 14 h.",
      "Lunch break", "Start an episode between noon and 2 p.m."],
    ["airday-50", "r", "broadcast", "50", counter("onAirDay", 50),
      "Toujours à jour", "Regarde 50 épisodes le jour même de leur diffusion.",
      "Always up to date", "Watch 50 episodes on the day they air."],
    ["w2g", "u", "screenTwin", "", flag("w2g"),
      "Watch party", "Termine un épisode dans une salle Watch2Gether.",
      "Watch party", "Finish an episode in a Watch2Gether room."],
    ["oav", "u", "screenPlus", "", flag("oav"),
      "Épisode bonus", "Regarde un OAV ou un épisode spécial.",
      "Bonus episode", "Watch an OVA or a special."],
    ["never-op", "r", "skipOff", "", { k: "neverSkipOp", n: 1 },
      "Jamais sans l'opening", "Termine un anime sans jamais passer l'opening.",
      "Never skip the opening", "Finish an anime without ever skipping the opening."],
  ],

  /* ── Temps cumulé ─────────────────────────────────────────────────────────
     Une seule échelle, en MINUTES en interne. Les minutes sont mesurées (la
     durée réelle du fichier, relevée par le lecteur), jamais estimées sur une
     moyenne : un temps inventé sur un profil est un chiffre faux. */
  time: [
    ["time-10h", "c", "hourglass", "10 H", count("minutes", 600),
      "Premières heures", "Cumule 10 heures de visionnage.",
      "First hours", "Watch 10 hours in total."],
    ["time-1d", "u", "hourglass", "1 J", count("minutes", 1440),
      "24 heures d'anime", "Cumule 24 heures de visionnage.",
      "24 Hours of Anime", "Watch 24 hours in total."],
    ["time-7d", "r", "hourglass", "7 J", count("minutes", 7 * 1440),
      "Une semaine complète", "Cumule 7 jours de visionnage, soit 168 heures.",
      "A full week", "Watch 7 days' worth in total, or 168 hours."],
    ["time-30d", "e", "hourglass", "30 J", count("minutes", 30 * 1440),
      "Un mois complet", "Cumule 30 jours de visionnage, soit 720 heures.",
      "A full month", "Watch 30 days' worth in total, or 720 hours."],
    ["time-100d", "l", "hourglass", "100 J", count("minutes", 100 * 1440),
      "Cent jours d'anime", "Cumule 100 jours de visionnage, soit 2 400 heures.",
      "100 Days of Anime", "Watch 100 days' worth in total, or 2,400 hours."],
    ["time-365d", "m", "hourglass", "365 J", count("minutes", 365 * 1440),
      "Une année entière", "Cumule 365 jours de visionnage. Oui, une année entière.",
      "A full year", "Watch 365 days' worth in total. Yes, a whole year."],
  ],

  /* ── Sessions ─────────────────────────────────────────────────────────────
     Ce qui se joue en une seule traite. La séance est une GRAPPE d'activité,
     pas une date : une soirée qui passe minuit reste une soirée. */
  sessions: [
    ["session-6h", "r", "dialMoon", "6 H", session(6),
      "Six heures d'affilée", "Tiens 6 heures d'affilée dans la même séance.",
      "Six hours straight", "Watch for 6 hours in a single sitting."],
    ["session-12h", "e", "weekend", "12 H", session(12, true),
      "Marathon du week-end", "Tiens une séance de 12 heures pendant le week-end.",
      "Weekend marathon", "Watch for 12 hours in one sitting over the weekend."],
  ],

  /* ── Anime terminés ───────────────────────────────────────────────────────
     « Terminé » = le statut COMPLETED de la liste, celui qu'AniList et la liste
     locale partagent. Le re-visionnage (REPEATING) compte aussi : on ne
     re-regarde que ce qu'on a fini une fois — même raison que FINISHED dans
     lib/profile/insights.ts. */
  finished: [
    ["fin-1", "c", "bookmarkCheck", "1", count("completed", 1),
      "Initié", "Termine ton premier anime.",
      "Initiate", "Finish your first anime."],
    ["fin-5", "u", "bookmarkCheck", "5", count("completed", 5),
      "Amateur", "Termine 5 anime.",
      "Fan", "Finish 5 anime."],
    ["fin-25", "r", "bookmarkCheck", "25", count("completed", 25),
      "Connaisseur", "Termine 25 anime.",
      "Connoisseur", "Finish 25 anime."],
    ["fin-75", "e", "bookmarkCheck", "75", count("completed", 75),
      "Expert", "Termine 75 anime.",
      "Expert", "Finish 75 anime."],
    ["fin-200", "l", "bookmarkCheck", "200", count("completed", 200),
      "Deux cents anime", "Termine 200 anime.",
      "200 anime", "Finish 200 anime."],
    ["fin-500", "m", "bookmarkCheck", "500", count("completed", 500),
      "Hotaku", "Termine 500 anime.",
      "Otaku", "Finish 500 anime."],
  ],

  /* ── Découverte ───────────────────────────────────────────────────────────
     Fouiller le catalogue au-delà des sorties du moment. Plusieurs de ces
     badges ont besoin de métadonnées d'œuvre (année, studio, format,
     popularité) que la liste locale ne porte pas d'origine : tant qu'elles
     manquent, le badge est « pas encore mesurable » et jamais « 0 % ». */
  discovery: [
    ["first-add", "c", "bookmark", "", { k: "listSize", n: 1 },
      "Liste commencée", "Ajoute ton premier anime à ta liste.",
      "List started", "Add your first anime to your list."],
    ["curious-10", "c", "curious", "10", counter("animeOpened", 10),
      "Curieux", "Ouvre la fiche de 10 anime différents.",
      "Curious", "Open 10 different anime pages."],
    ["hidden-gem", "u", "gem", "", { k: "popularityUnder", max: 5000, n: 1 },
      "Pépite méconnue", "Termine un anime suivi par moins de 5 000 personnes.",
      "Hidden gem", "Finish an anime followed by fewer than 5,000 people."],
    ["archive-1990", "u", "layers", "", { k: "yearBefore", year: 1990, n: 1 },
      "Avant les années 90", "Termine un anime sorti avant 1990.",
      "Pre-90s find", "Finish an anime released before 1990."],
    ["pioneer-1975", "e", "history", "", { k: "yearBefore", year: 1975, n: 1 },
      "Pionnier", "Termine un anime sorti avant 1975.",
      "Pioneer", "Finish an anime released before 1975."],
    ["decades", "l", "timeline", "", { k: "decades", from: 1970, n: 6 },
      "Toutes les décennies", "Termine un anime de chaque décennie depuis les années 70.",
      "Every decade", "Finish an anime from every decade since the 1970s."],
    ["big-three", "u", "three", "", works("bigThree", "any"),
      "Big Three", "Termine One Piece, Naruto ou Bleach.",
      "Big three", "Finish One Piece, Naruto or Bleach."],
    /* Derive du statut de diffusion mis en cache, pas observe a l'ajout : ainsi
       le badge vaut aussi pour ce qui est deja dans la liste. */
    ["planning", "c", "calendarPlus", "", { k: "planningUnaired", n: 1 },
      "Impatient", "Ajoute à ta liste un anime pas encore sorti.",
      "Hyped", "Add an anime that hasn't aired yet to your list."],
    ["two-voices", "u", "speech", "", flag("bothLangs"),
      "VO et VF", "Regarde le même épisode en VO et en VF.",
      "Sub and dub", "Watch the same episode both subbed and dubbed."],
    ["blind-pick", "c", "shuffle", "", flag("random"),
      "Au hasard", "Lance un anime tiré au hasard.",
      "Random pick", "Start an anime picked at random."],
    ["studio-10", "r", "clapper", "10", { k: "studio", n: 10 },
      "Studio préféré", "Termine 10 anime du même studio.",
      "Favourite studio", "Finish 10 anime from the same studio."],
    ["rewatch-1", "r", "loop", "", count("rewatched", 1),
      "Premier revisionnage", "Revois un anime que tu avais déjà terminé.",
      "First rewatch", "Rewatch an anime you'd already finished."],
    ["rewatch-10", "e", "loop", "10", count("rewatched", 10),
      "Accro", "Revois 10 anime que tu avais déjà terminés.",
      "Hooked", "Rewatch 10 anime you'd already finished."],
    ["thrice", "e", "again3", "3", { k: "repeatSame", times: 3, n: 1 },
      "Jamais deux sans trois", "Termine le même anime trois fois.",
      "Third time's the charm", "Finish the same anime three times."],
    ["comeback", "u", "flame", "", flag("comeback"),
      "Repris en main", "Reprends un anime laissé de côté plus de 30 jours.",
      "Back on track", "Pick an anime back up after more than 30 days away."],
    ["day-one", "r", "dayD", "", flag("dayOne"),
      "Final le jour même", "Regarde le dernier épisode d'un anime le jour de sa diffusion.",
      "Finale on day one", "Watch an anime's final episode on the day it airs."],
    /* Commence et termine le meme jour : les deux dates sont sur l'entree de
       liste, il n'y a rien a observer en direct. */
    ["one-sitting", "r", "flame", "", { k: "sameDayFinish", n: 1 },
      "D'un coup", "Commence et termine un anime le même jour.",
      "One Shot", "Start and finish an anime on the same day."],
    ["movies-30", "e", "cinema", "30", format("MOVIE", 30),
      "Cinéphile", "Termine 30 films.",
      "Film buff", "Finish 30 films."],
    ["alphabet", "l", "alphabet", "A-Z", { k: "alphabet", n: 26 },
      "De A à Z", "Termine un anime pour chaque lettre de l'alphabet.",
      "A to Z", "Finish an anime for every letter of the alphabet."],
    ["long-title", "r", "longTitle", "100+", { k: "titleLength", min: 100, n: 1 },
      "Titre à rallonge", "Termine un anime dont le titre dépasse 100 caractères.",
      "Very long title", "Finish an anime whose title runs past 100 characters."],
    ["all-players", "r", "players", "", { k: "hosts", n: 0 },
      "Tous les lecteurs", "Regarde un épisode sur chacun des lecteurs proposés.",
      "Every player", "Watch an episode on every player on offer."],
    ["halloween", "u", "skullNight", "31/10", onDate(10, 31, "Horror"),
      "Nuit d'Halloween", "Regarde un anime d'horreur le 31 octobre.",
      "Halloween night", "Watch a horror anime on 31 October."],
    ["valentine", "u", "heart", "14/02", onDate(2, 14, "Romance"),
      "Saint-Valentin", "Regarde une romance le 14 février.",
      "Valentine's Day", "Watch a romance on 14 February."],
    ["april-fool", "u", "fishHook", "01/04", onDate(4, 1, "Comedy"),
      "Poisson d'avril", "Regarde une comédie le 1er avril.",
      "April Fools'", "Watch a comedy on 1 April."],
  ],

  /* ── Genres ───────────────────────────────────────────────────────────────
     Un badge par famille, sur les anime TERMINÉS. Les noms de genres sont ceux
     d'AniList, en anglais, parce que c'est ce que portent les données — la
     traduction se fait à l'affichage (lib/i18n/genreLabel.ts). */
  genres: [
    ["g-action", "r", "fist", "30", genre("Action", 30),
      "Fan d'action", "Termine 30 anime d'action.",
      "Action fan", "Finish 30 action anime."],
    ["g-romance", "r", "partnerHeart", "20", genre("Romance", 20),
      "Sentimental", "Termine 20 romances.",
      "Romantic", "Finish 20 romances."],
    ["g-horror", "r", "horror", "15", genre("Horror", 15),
      "Même pas peur", "Termine 15 anime d'horreur.",
      "Not even scared", "Finish 15 horror anime."],
    ["g-mecha", "r", "robot", "10", genre("Mecha", 10),
      "Dans le cockpit", "Termine 10 anime de mecha.",
      "In the cockpit", "Finish 10 mecha anime."],
    ["g-slice", "r", "leaf", "20", genre("Slice of Life", 20),
      "Tranche de vie", "Termine 20 slice of life.",
      "Slice of life", "Finish 20 slice-of-life anime."],
    ["g-isekai", "r", "reborn", "15", { k: "tag", name: "Isekai", n: 15 },
      "Voyageur d'un autre monde", "Termine 15 isekai.",
      "Otherworld traveller", "Finish 15 isekai."],
    ["g-fantasy", "r", "castle", "20", genre("Fantasy", 20),
      "Autre monde", "Termine 20 anime de fantasy.",
      "Other worlds", "Finish 20 fantasy anime."],
    ["g-scifi", "r", "rocket", "15", genre("Sci-Fi", 15),
      "Sci-fi", "Termine 15 anime de science-fiction.",
      "Sci-fi", "Finish 15 sci-fi anime."],
    ["g-mystery", "r", "magnifier", "15", genre("Mystery", 15),
      "Détective", "Termine 15 anime de mystère.",
      "Detective", "Finish 15 mystery anime."],
    ["g-drama", "r", "teardrop", "20", genre("Drama", 20),
      "Fan de drama", "Termine 20 drames.",
      "Drama fan", "Finish 20 dramas."],
    ["g-comedy", "r", "laugh", "25", genre("Comedy", 25),
      "Mort de rire", "Termine 25 comédies.",
      "Dying of laughter", "Finish 25 comedies."],
    ["g-sports", "r", "volley", "10", genre("Sports", 10),
      "Esprit d'équipe", "Termine 10 anime de sport.",
      "Team spirit", "Finish 10 sports anime."],
    ["g-music", "r", "note", "10", genre("Music", 10),
      "En rythme", "Termine 10 anime musicaux.",
      "On the beat", "Finish 10 music anime."],
    ["g-psycho", "r", "knightPiece", "10", genre("Psychological", 10),
      "Guerre psychologique", "Termine 10 anime psychologiques.",
      "Mind games", "Finish 10 psychological anime."],
    ["g-thriller", "r", "eye", "10", genre("Thriller", 10),
      "Thriller", "Termine 10 thrillers.",
      "Thriller", "Finish 10 thrillers."],
    ["g-school", "r", "school", "20", { k: "tag", name: "School", n: 20 },
      "Cour de récré", "Termine 20 anime scolaires.",
      "Schoolyard", "Finish 20 school anime."],
    ["g-food", "r", "chef", "5", { k: "tag", name: "Food", n: 5 },
      "Ça donne faim", "Termine 5 anime de cuisine.",
      "Now I'm hungry", "Finish 5 cooking anime."],
    ["all-genres", "e", "genresAll", "", { k: "allGenres", n: 0 },
      "Touche-à-tout", "Termine au moins un anime dans chaque genre du catalogue.",
      "Jack of all genres", "Finish at least one anime in every genre in the catalogue."],
    ["all-tags", "m", "tagsAll", "", { k: "allTags", n: 0 },
      "Maître du Catalogue", "Couvre chaque tag du catalogue avec au moins un anime terminé.",
      "Master of Catalogue", "Cover every tag in the catalogue with at least one finished anime."],
  ],

  /* ── Franchises ───────────────────────────────────────────────────────────
     Aller au bout d'une saga. La chaîne des saisons est reconstruite côté
     client à partir des relations AniList déjà en cache sur les entrées de la
     liste (`relIds`), sans interroger notre propre base. */
  franchise: [
    ["saga-2", "r", "rings", "", { k: "franchise", seasons: 2, n: 1 },
      "Toutes les saisons", "Termine toutes les saisons d'une franchise (au moins 2).",
      "All seasons", "Finish every season of a franchise (at least 2)."],
    ["saga-4", "e", "rings", "4", { k: "franchise", seasons: 4, n: 1 },
      "Longue saga", "Termine toutes les saisons d'une franchise qui en compte au moins 4.",
      "Long saga", "Finish every season of a franchise that has at least 4."],
  ],

  /* ── Régularité ───────────────────────────────────────────────────────────
     La série de jours consécutifs. Jours CALENDAIRES locaux : elle survit au
     changement d'heure et au voyage (cf. lib/badges/localtime.ts). */
  regularity: [
    ["streak-7", "u", "calendarCheck", "7 J", count("streak", 7),
      "Une semaine d'affilée", "Regarde au moins un épisode 7 jours de suite.",
      "One-week streak", "Watch at least one episode 7 days in a row."],
    ["streak-30", "u", "calendarCheck", "30 J", count("streak", 30),
      "Un mois d'affilée", "Regarde au moins un épisode 30 jours de suite.",
      "One-month streak", "Watch at least one episode 30 days in a row."],
    ["streak-90", "r", "calendarCheck", "90 J", count("streak", 90),
      "Trois mois d'affilée", "Regarde au moins un épisode 90 jours de suite.",
      "Three-month streak", "Watch at least one episode 90 days in a row."],
    ["streak-180", "e", "calendarCheck", "180 J", count("streak", 180),
      "Six mois d'affilée", "Regarde au moins un épisode 180 jours de suite.",
      "Six-month streak", "Watch at least one episode 180 days in a row."],
    ["streak-270", "l", "calendarCheck", "270 J", count("streak", 270),
      "Neuf mois d'affilée", "Regarde au moins un épisode 270 jours de suite.",
      "Nine-month streak", "Watch at least one episode 270 days in a row."],
    ["streak-365", "m", "calendarCheck", "365 J", count("streak", 365),
      "Un an d'affilée", "Regarde au moins un épisode chaque jour pendant un an.",
      "One-year streak", "Watch at least one episode every day for a year."],
  ],

  /* ── Profil et collection ─────────────────────────────────────────────────
     Tenir sa liste, noter, ranger — et collectionner les badges eux-mêmes. */
  profile: [
    ["rated-50", "u", "starList", "50", count("rated", 50),
      "Critique", "Note 50 anime.",
      "Critic", "Rate 50 anime."],
    ["rated-200", "r", "starList", "200", count("rated", 200),
      "Critique averti", "Note 200 anime.",
      "Seasoned critic", "Rate 200 anime."],
    ["fav-1", "c", "heart", "1", count("favourites", 1),
      "Premier coup de cœur", "Mets un anime en favori.",
      "First favourite", "Add an anime to your favourites."],
    ["fav-10", "u", "heart", "10", count("favourites", 10),
      "Dix coups de cœur", "Mets 10 anime en favoris.",
      "Ten favourites", "Add 10 anime to your favourites."],
    ["first-rating", "c", "starList", "1", count("rated", 1),
      "Premier avis", "Note ton premier anime.",
      "First rating", "Rate your first anime."],
    ["avatar", "c", "selfie", "", flag("avatar"),
      "Photo de profil", "Choisis ta propre photo de profil.",
      "Profile picture", "Set your own profile picture."],
    ["share-link", "c", "copyLink", "", flag("copyLink"),
      "Lien partagé", "Partage ou copie le lien d'un anime.",
      "Link shared", "Share or copy an anime's link."],
    ["settings", "c", "gear", "", flag("settings"),
      "Petits réglages", "Ouvre les paramètres.",
      "Settings check", "Open the settings."],
    ["custom-list", "c", "listPlus", "", flag("customList"),
      "Liste sur mesure", "Crée une liste personnalisée.",
      "Custom list", "Create a custom list."],
    ["one-year-here", "r", "cake", "", { k: "accountAge", days: 365, n: 365 },
      "Un an déjà", "Ton compte AniScroll a un an.",
      "A year already", "Your AniScroll account turns one."],
    ["badges-50", "e", "hexCluster", "50", count("badges", 50),
      "Collectionneur", "Obtiens 50 badges.",
      "Collector", "Earn 50 badges."],
    ["badges-75", "l", "hexCluster", "75", count("badges", 75),
      "Grand collectionneur", "Obtiens 75 badges.",
      "Master collector", "Earn 75 badges."],
    ["legendary-5", "l", "trophy", "5", { k: "rarityCount", rarity: "l", n: 5 },
      "Cinq légendaires", "Obtiens 5 badges légendaires.",
      "Five legendaries", "Earn 5 legendary badges."],
    ["showcase-open", "c", "gridFull", "", flag("badgesTab"),
      "Salle des trophées", "Ouvre ta page de badges.",
      "Trophy room", "Open your badges page."],
    ["secret-50", "l", "question", "50", { k: "secretCount", n: 50 },
      "Chasseur de secrets", "Obtiens 50 badges secrets.",
      "Secret hunter", "Earn 50 secret badges."],
    ["complete", "m", "hexCluster", "100 %", { k: "allBadges", n: 0 },
      "Collection complète", "Obtiens tous les autres badges.",
      "Full collection", "Earn every other badge."],
  ],

  /* ── Secret ───────────────────────────────────────────────────────────────
     Hors progression ET HORS TOTAL : ils ne comptent pas dans les 101 badges
     annoncés. Leur nom s'affiche, leur condition reste floutée tant qu'ils ne
     sont pas obtenus — et le texte réel n'est PAS rendu dans le DOM. */
  secret: [
    ["anilist-linked", "u", "link", "", flag("anilistLinked"),
      "Compte AniList lié", "Lie ton compte AniList.",
      "AniList linked", "Link your AniList account."],
    ["staff", "m", "shieldCheck", "STAFF", { k: "granted", n: 1 },
      "Équipe AniScroll", "Réservé à l'équipe d'AniScroll.",
      "AniScroll team", "Only for the AniScroll team."],
    ["beta", "l", "bookmark", "BETA", { k: "granted", n: 1 },
      "Là depuis la bêta", "Ton compte date de la bêta.",
      "Here since the beta", "Your account dates back to the beta."],
    ["changelog", "c", "film", "", flag("changelog"),
      "Lu jusqu'au bout", "Fais défiler le journal des mises à jour jusqu'en bas.",
      "Read to the end", "Scroll the changelog all the way to the bottom."],
    ["dead-end", "u", "screenBroken", "404", counter("notFound", 3),
      "Perdu ?", "Tombe trois fois sur la page 404.",
      "Lost?", "Land on the 404 page three times."],
    ["konami", "e", "dpad", "", flag("konami"),
      "Code secret", "Tape le code Konami.",
      "Secret code", "Enter the Konami code."],
    ["devtools", "r", "console", "", flag("devtools"),
      "Heu, qu’est ce que tu fais ?", "Ouvre la console développeur.",
      "Hey, what are you doing?", "Open the developer console."],
    ["dmca", "r", "gavel", "3 MIN", flag("dmca"),
      "Je vous assure qu’il n’y a rien d’illégal", "Reste trois minutes sur la page DMCA.",
      "I assure you there's nothing illegal", "Stay on the DMCA page for three minutes."],
    ["recursive", "r", "loupeSelf", "", flag("recursive"),
      "AnimeCeption", "Cherche « AniScroll » sur AniScroll.",
      "AnimeCeption", "Search for \"AniScroll\" on AniScroll."],
    ["not-here", "u", "noEntry", "", flag("notHere"),
      "Y’a d’autres sites pour ça…", "Cherche « hentai ». Ce n'est pas ici.",
      "There are other sites for that...", "Search for \"hentai\". Wrong site."],
    ["polyglot", "u", "translate", "10", flag("polyglot"),
      "Faut se descider", "Change la langue du site 10 fois en une minute.",
      "Make up your mind", "Switch the site language 10 times in one minute."],
    ["oldest", "r", "oldest", "", flag("oldest"),
      "Le doyen", "Ouvre la fiche de l'anime le plus ancien du catalogue.",
      "The elder", "Open the page of the oldest anime in the catalogue."],
    ["self-search", "c", "selfie", "", flag("selfSearch"),
      "Narcissique", "Cherche ton propre pseudo.",
      "Narcissist", "Search for your own username."],
    ["pin-mythic", "u", "showcase", "", flag("pinMythic"),
      "Frimeur", "Épingle un badge mythique sur ton profil.",
      "Show-off", "Pin a mythic badge to your profile."],

    ["one-piece", "m", "compass", "", works("onePiece"),
      "Le One Piece", "Termine One Piece.",
      "The One Piece", "Finish One Piece."],
    ["hokage", "m", "ninja", "", works("naruto"),
      "Ninja", "Termine Naruto et Naruto Shippuden.",
      "Ninja", "Finish Naruto and Naruto Shippuden."],
    ["boruto", "l", "scroll", "", works("boruto"),
      "Nouvelle génération", "Termine Boruto.",
      "New Generation", "Finish Boruto."],
    ["super-saiyan", "m", "aura", "", works("dragonBall"),
      "Super Saiyan", "Termine Dragon Ball, Dragon Ball Z et Dragon Ball Super.",
      "Super Saiyan", "Finish Dragon Ball, Dragon Ball Z and Dragon Ball Super."],
    ["hashira", "e", "blade", "", works("demonSlayer"),
      "Pourfendeur", "Termine Demon Slayer, films compris.",
      "Slayer", "Finish Demon Slayer, films included."],
    ["walls", "l", "wall", "", works("aot"),
      "Au-delà des murs", "Termine L'Attaque des Titans.",
      "Beyond the walls", "Finish Attack on Titan."],
    ["hunter-licence", "l", "crown", "", works("hxh"),
      "Licence de Hunter", "Termine Hunter x Hunter.",
      "Hunter licence", "Finish Hunter x Hunter."],
    ["bankai", "l", "skull", "", works("bleach"),
      "Bankai", "Termine Bleach, Thousand-Year Blood War compris.",
      "Bankai", "Finish Bleach, Thousand-Year Blood War included."],
    ["equivalent-exchange", "l", "spell", "", works("fmab"),
      "Alchimiste", "Termine Fullmetal Alchemist: Brotherhood.",
      "Alchemist", "Finish Fullmetal Alchemist: Brotherhood."],
    ["conan-1000", "m", "sleuth", "1 000", worksEpisodes("conan", 1000),
      "Mille enquêtes", "Dépasse les 1 000 épisodes de Détective Conan.",
      "A thousand cases", "Get past 1,000 episodes of Detective Conan."],
    ["pokemon-500", "m", "cat", "500", worksEpisodes("pokemon", 500),
      "Maître Pokémon", "Dépasse les 500 épisodes de Pokémon.",
      "Pokémon Master", "Get past 500 episodes of Pokémon."],
    ["plus-ultra", "e", "titan", "", works("mha"),
      "Le Tout-Puissant", "Termine My Hero Academia.",
      "The all might", "Finish My Hero Academia."],
    ["death-note", "e", "pen", "", works("deathNote"),
      "Le carnet", "Termine Death Note.",
      "The Notebook", "Finish Death Note."],
    ["jujutsu", "e", "spiral", "", works("jjk"),
      "Extension du territoire", "Termine Jujutsu Kaisen.",
      "Domain Expansion", "Finish Jujutsu Kaisen."],
    ["chainsaw", "r", "chain", "", works("chainsawMan"),
      "Pochita", "Termine Chainsaw Man.",
      "Pochita", "Finish Chainsaw Man."],
    ["rank-s", "r", "gun", "", works("opm"),
      "Un coup suffit", "Termine One Punch Man.",
      "One punch is enough", "Finish One Punch Man."],
    ["black-clover", "e", "spell", "", works("blackClover"),
      "Roi des sorciers", "Termine Black Clover.",
      "Wizard King", "Finish Black Clover."],
    ["steins-gate", "e", "clockRed", "", works("steinsGate"),
      "Savant fou", "Termine Steins;Gate.",
      "Mad scientist", "Finish Steins;Gate."],
    ["re-zero", "e", "clockRed", "", works("reZero"),
      "Retour à la vie", "Termine Re:Zero.",
      "Back to Life", "Finish Re:Zero."],
    ["sao", "r", "guild", "", works("sao"),
      "Déconnexion impossible", "Termine Sword Art Online.",
      "No logout button", "Finish Sword Art Online."],
    ["slime", "r", "slime", "", works("slime"),
      "Slime", "Termine Moi, quand je me réincarne en Slime.",
      "Slime", "Finish That Time I Got Reincarnated as a Slime."],
    ["shield-hero", "r", "wall", "", works("shieldHero"),
      "Héros au bouclier", "Termine The Rising of the Shield Hero.",
      "Shield Hero", "Finish The Rising of the Shield Hero."],
    ["mushoku", "r", "scroll", "", works("mushoku"),
      "Seconde vie", "Termine Mushoku Tensei.",
      "Second life", "Finish Mushoku Tensei."],
    ["overlord", "r", "crown", "", works("overlord"),
      "Seigneur de Nazarick", "Termine Overlord.",
      "Lord of Nazarick", "Finish Overlord."],
    ["konosuba", "r", "guild", "", works("konosuba"),
      "Explosion !", "Termine Konosuba.",
      "Explosion!", "Finish Konosuba."],
    ["frieren", "e", "sunflower", "", works("frieren"),
      "Après l'aventure", "Termine Frieren.",
      "After the adventure", "Finish Frieren."],
    ["solo-leveling", "r", "gun", "", works("soloLeveling"),
      "Monarque des ombres", "Termine Solo Leveling.",
      "Shadow Monarch", "Finish Solo Leveling."],
    ["code-geass", "l", "mechaG", "", works("codeGeass"),
      "Le pouvoir du Geass", "Termine Code Geass.",
      "Power of Geass", "Finish Code Geass."],
    ["evangelion", "l", "mechaG", "", works("evangelion"),
      "Pilote d'EVA", "Termine Neon Genesis Evangelion.",
      "EVA pilot", "Finish Neon Genesis Evangelion."],
    ["bebop", "l", "bounty", "", works("bebop"),
      "Chasseur de primes", "Termine Cowboy Bebop.",
      "Bounty hunter", "Finish Cowboy Bebop."],
    ["champloo", "e", "blade", "", works("champloo"),
      "Le samouraï tournesol", "Termine Samurai Champloo.",
      "The sunflower samurai", "Finish Samurai Champloo."],
    ["ghost-shell", "l", "space", "", works("gits"),
      "Section 9", "Termine Ghost in the Shell: Stand Alone Complex.",
      "Section 9", "Finish Ghost in the Shell: Stand Alone Complex."],
    ["trigun", "e", "gun", "", works("trigun"),
      "Le typhon humanoïde", "Termine Trigun.",
      "The Humanoid Typhoon", "Finish Trigun."],
    ["berserk", "l", "skull", "", works("berserk"),
      "Le guerrier noir", "Termine Berserk.",
      "The Black Swordsman", "Finish Berserk."],
    ["monster", "l", "sleuth", "", works("monster"),
      "Le monstre sans nom", "Termine Monster.",
      "The nameless monster", "Finish Monster."],
    ["vinland", "e", "blade", "", works("vinland"),
      "Cap sur le Vinland", "Termine Vinland Saga.",
      "Bound for Vinland", "Finish Vinland Saga."],
    ["kingdom", "e", "crown", "", works("kingdom"),
      "Grand général", "Termine Kingdom.",
      "Great General", "Finish Kingdom."],
    ["ngnl", "r", "card", "", works("ngnl"),
      "Blank ne perd jamais", "Termine No Game No Life.",
      "Blank never loses", "Finish No Game No Life."],
    ["yugioh", "l", "card", "", works("yugioh"),
      "C'est l'heure du duel", "Termine Yu-Gi-Oh! Duel Monsters.",
      "It's time to duel", "Finish Yu-Gi-Oh! Duel Monsters."],
    ["haikyu", "e", "volley", "", works("haikyu"),
      "Les corbeaux de Karasuno", "Termine Haikyu!!.",
      "Karasuno's crows", "Finish Haikyu!!."],
    ["kuroko", "e", "hoop", "", works("kuroko"),
      "Sixième homme fantôme", "Termine Kuroko's Basket.",
      "Phantom sixth man", "Finish Kuroko's Basketball."],
    ["blue-lock", "r", "ball", "", works("blueLock"),
      "Buteur égoïste", "Termine Blue Lock.",
      "Egoist striker", "Finish Blue Lock."],
    ["yowamushi", "e", "bike", "", works("yowamushi"),
      "Roi de la montagne", "Termine Yowamushi Pedal.",
      "King of the Mountain", "Finish Yowamushi Pedal."],
    ["slam-dunk", "l", "hoop", "", works("slamDunk"),
      "Le roi du rebond", "Termine Slam Dunk.",
      "Rebound king", "Finish Slam Dunk."],
    ["food-wars", "e", "pot", "", works("foodWars"),
      "Duel de cuisine", "Termine Food Wars.",
      "Cooking duel", "Finish Food Wars."],
    ["assassination", "r", "school", "", works("ansatsu"),
      "Objectif : Koro-sensei", "Termine Assassination Classroom.",
      "Target: Koro-sensei", "Finish Assassination Classroom."],
    ["fruits-basket", "e", "gearHeart", "", works("fruitsBasket"),
      "La malédiction du zodiaque", "Termine Fruits Basket.",
      "The zodiac curse", "Finish Fruits Basket."],
    ["toradora", "r", "gearHeart", "", works("toradora"),
      "Le tigre de poche", "Termine Toradora!.",
      "Palmtop Tiger", "Finish Toradora!."],
    ["clannad", "e", "teapot", "", works("clannad"),
      "La grande famille dango", "Termine Clannad et After Story.",
      "Big Dango Family", "Finish Clannad and After Story."],
    ["your-lie", "e", "note", "", works("yourLie"),
      "Duo piano-violon", "Termine Your Lie in April.",
      "Piano and violin", "Finish Your Lie in April."],
    /* Ghibli se lit dans le STUDIO, pas dans une liste d'ids : une liste aurait
       vieilli à la sortie du film suivant, et le studio est déjà mis en cache
       sur l'entrée de liste. */
    ["ghibli-1", "u", "movies", "", { k: "studioNamed", name: "Studio Ghibli", n: 1 },
      "Premier Ghibli", "Termine un film du studio Ghibli.",
      "First Ghibli", "Finish a Studio Ghibli film."],
    ["ghibli-10", "l", "movies", "10", { k: "studioNamed", name: "Studio Ghibli", n: 10 },
      "Ghibli par cœur", "Termine 10 films du studio Ghibli.",
      "Ghibli by heart", "Finish 10 Studio Ghibli films."],
    ["shinkai", "e", "twilight", "", works("shinkai"),
      "Intégrale Shinkai", "Termine tous les films de Makoto Shinkai.",
      "Complete Shinkai", "Finish every Makoto Shinkai film."],
    ["gintama", "m", "tape", "", works("gintama"),
      "Homme à tout faire", "Termine Gintama.",
      "Odd Jobs", "Finish Gintama."],
    ["mirai-nikki", "r", "diary", "", works("miraiNikki"),
      "Journal du futur", "Termine Mirai Nikki.",
      "Future diary", "Finish Mirai Nikki."],
    ["jojo", "m", "aura", "", works("jojo"),
      "Héritage Joestar", "Termine toutes les parties de JoJo's Bizarre Adventure.",
      "Joestar Legacy", "Finish every part of JoJo's Bizarre Adventure."],
    ["spy-family", "r", "gearHeart", "", works("spyFamily"),
      "Opération Strix", "Termine Spy x Family.",
      "Operation Strix", "Finish Spy x Family."],
    ["dr-stone", "e", "spell", "", works("drStone"),
      "Royaume de la science", "Termine Dr. Stone.",
      "Kingdom of Science", "Finish Dr. Stone."],
    ["tokyo-ghoul", "e", "skull", "", works("tokyoGhoul"),
      "Demi-goule", "Termine Tokyo Ghoul.",
      "Half-ghoul", "Finish Tokyo Ghoul."],
    ["parasyte", "r", "slime", "", works("parasyte"),
      "La main droite", "Termine Parasyte.",
      "The right hand", "Finish Parasyte."],
    ["neverland", "r", "scroll", "", works("neverland"),
      "La grande évasion", "Termine The Promised Neverland.",
      "The great escape", "Finish The Promised Neverland."],
  ],
};
