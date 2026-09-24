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
      "Le pilote", "Regarde ton premier épisode.",
      "The pilot", "Watch your first episode."],
    ["ep-25", "u", "screen3", "25", count("episodes", 25),
      "Une saison dans les pattes", "Regarde 25 épisodes.",
      "A season under your belt", "Watch 25 episodes."],
    ["ep-250", "r", "screen3", "250", count("episodes", 250),
      "Pilier du canapé", "Regarde 250 épisodes.",
      "Couch regular", "Watch 250 episodes."],
    ["ep-1000", "e", "screen3", "1 000", count("episodes", 1000),
      "Le cap des mille", "Regarde 1 000 épisodes.",
      "The thousand mark", "Watch 1,000 episodes."],
    ["ep-5000", "l", "screen3", "5 000", count("episodes", 5000),
      "Otaku certifié", "Regarde 5 000 épisodes.",
      "Certified otaku", "Watch 5,000 episodes."],
    ["ep-10000", "m", "screen3", "10 000", count("episodes", 10000),
      "Tu dors quand ?", "Regarde 10 000 épisodes.",
      "When do you sleep?", "Watch 10,000 episodes."],

    ["resume", "c", "resume", "", flag("resume"),
      "Où j'en étais ?", "Reprends un épisode là où tu l'avais laissé.",
      "Where was I?", "Pick an episode back up where you left off."],
    ["spotlight", "c", "spotlight", "", flag("spotlight"),
      "Vendu !", "Lance un épisode depuis le carrousel de l'accueil.",
      "Sold!", "Start an episode from the home page carousel."],
    ["no-pause", "u", "noPause", "", flag("noPause"),
      "Même pas pour le frigo", "Regarde un épisode entier sans jamais mettre pause.",
      "Not even a snack break", "Watch a whole episode without pausing once."],
    ["burst-20", "r", "burst", "20", window_(86_400_000, 20),
      "Journée pyjama", "Regarde 20 épisodes en 24 heures.",
      "Pyjama day", "Watch 20 episodes within 24 hours."],
    ["burst-50", "e", "speed", "50", window_(7 * 86_400_000, 50),
      "Vacances bien employées", "Regarde 50 épisodes en 7 jours.",
      "Holiday well spent", "Watch 50 episodes within 7 days."],
    ["night-12", "e", "flame", "12", night(12),
      "Encore un, et au lit", "Enchaîne 12 épisodes dans la même séance.",
      "Just one more", "Watch 12 episodes in a single sitting."],
    ["late-night", "u", "moon", "", hourWin(2, 5),
      "Insomnie", "Lance un épisode entre 2 h et 5 h du matin.",
      "Can't sleep", "Start an episode between 2 and 5 a.m."],
    ["midnight", "r", "dialMoon", "00:00", midnight(),
      "Pile à minuit", "Lance un épisode à 00 h 00 pile.",
      "Midnight on the dot", "Start an episode at exactly 00:00."],
    /* DERIVE, et non enregistre au vol : la liste et la table de progression
       portent deja de quoi repondre (le dernier episode vu, et lui seul). Un
       drapeau pose par le lecteur ne vaudrait que pour l'avenir ; ceci vaut
       aussi pour ce qui a deja ete regarde. */
    ["by-the-end", "u", "swap", "", { k: "onlyLastEpisode", n: 1 },
      "Spoiler assumé", "Regarde le dernier épisode d'un anime sans avoir vu les autres.",
      "Self-spoiler", "Watch the last episode of an anime without having seen any of the others."],
    ["lunch", "c", "cutlery", "", hourWin(12, 14),
      "Pause déj", "Lance un épisode entre midi et 14 h.",
      "Working lunch", "Start an episode between noon and 2 p.m."],
    ["airday-50", "r", "broadcast", "50", counter("onAirDay", 50),
      "Accro au simulcast", "Regarde 50 épisodes le jour même de leur diffusion.",
      "Simulcast addict", "Watch 50 episodes on the day they air."],
    ["w2g", "u", "screenTwin", "", flag("w2g"),
      "Pop-corn partagé", "Termine un épisode dans une salle Watch2Gether.",
      "Shared popcorn", "Finish an episode in a Watch2Gether room."],
    ["oav", "u", "screenPlus", "", flag("oav"),
      "Les bonus aussi", "Regarde un OAV ou un épisode spécial.",
      "Extras too", "Watch an OVA or a special."],
    ["never-op", "r", "skipOff", "", { k: "neverSkipOp", n: 1 },
      "L'opening, c'est sacré", "Termine un anime sans jamais passer l'opening.",
      "Never skip the opening", "Finish an anime without ever skipping the opening."],
  ],

  /* ── Temps cumulé ─────────────────────────────────────────────────────────
     Une seule échelle, en MINUTES en interne. Les minutes sont mesurées (la
     durée réelle du fichier, relevée par le lecteur), jamais estimées sur une
     moyenne : un temps inventé sur un profil est un chiffre faux. */
  time: [
    ["time-10h", "c", "hourglass", "10 H", count("minutes", 600),
      "Échauffement", "Cumule 10 heures de visionnage.",
      "Warming up", "Watch 10 hours in total."],
    ["time-1d", "u", "hourglass", "1 J", count("minutes", 1440),
      "24 heures chrono", "Cumule 24 heures de visionnage.",
      "Around the clock", "Watch 24 hours in total."],
    ["time-7d", "r", "hourglass", "7 J", count("minutes", 7 * 1440),
      "Une semaine de ta vie", "Cumule 7 jours de visionnage, soit 168 heures.",
      "A week of your life", "Watch 7 days' worth in total, or 168 hours."],
    ["time-30d", "e", "hourglass", "30 J", count("minutes", 30 * 1440),
      "Un mois devant l'écran", "Cumule 30 jours de visionnage, soit 720 heures.",
      "A month of screen time", "Watch 30 days' worth in total, or 720 hours."],
    ["time-100d", "l", "hourglass", "100 J", count("minutes", 100 * 1440),
      "On ne compte plus", "Cumule 100 jours de visionnage, soit 2 400 heures.",
      "Lost count", "Watch 100 days' worth in total, or 2,400 hours."],
    ["time-365d", "m", "hourglass", "365 J", count("minutes", 365 * 1440),
      "Un an de ta vie", "Cumule 365 jours de visionnage. Oui, une année entière.",
      "A year of your life", "Watch 365 days' worth in total. Yes, a whole year."],
  ],

  /* ── Sessions ─────────────────────────────────────────────────────────────
     Ce qui se joue en une seule traite. La séance est une GRAPPE d'activité,
     pas une date : une soirée qui passe minuit reste une soirée. */
  sessions: [
    ["session-6h", "r", "dialMoon", "6 H", session(6),
      "Scotché", "Tiens 6 heures d'affilée dans la même séance.",
      "Glued to the screen", "Watch for 6 hours in a single sitting."],
    ["session-12h", "e", "weekend", "12 H", session(12, true),
      "Week-end sous la couette", "Tiens une séance de 12 heures pendant le week-end.",
      "Duvet weekend", "Watch for 12 hours in one sitting over the weekend."],
  ],

  /* ── Anime terminés ───────────────────────────────────────────────────────
     « Terminé » = le statut COMPLETED de la liste, celui qu'AniList et la liste
     locale partagent. Le re-visionnage (REPEATING) compte aussi : on ne
     re-regarde que ce qu'on a fini une fois — même raison que FINISHED dans
     lib/profile/insights.ts. */
  finished: [
    ["fin-1", "c", "bookmarkCheck", "1", count("completed", 1),
      "Générique de fin", "Termine ton premier anime.",
      "Roll credits", "Finish your first anime."],
    ["fin-5", "u", "bookmarkCheck", "5", count("completed", 5),
      "Ça devient une habitude", "Termine 5 anime.",
      "Becoming a habit", "Finish 5 anime."],
    ["fin-25", "r", "bookmarkCheck", "25", count("completed", 25),
      "Jamais à moitié", "Termine 25 anime.",
      "Never halfway", "Finish 25 anime."],
    ["fin-75", "e", "bookmarkCheck", "75", count("completed", 75),
      "Connaisseur", "Termine 75 anime.",
      "Connoisseur", "Finish 75 anime."],
    ["fin-200", "l", "bookmarkCheck", "200", count("completed", 200),
      "Vétéran", "Termine 200 anime.",
      "Veteran", "Finish 200 anime."],
    ["fin-500", "m", "bookmarkCheck", "500", count("completed", 500),
      "Encyclopédie ambulante", "Termine 500 anime.",
      "Walking encyclopedia", "Finish 500 anime."],
  ],

  /* ── Découverte ───────────────────────────────────────────────────────────
     Fouiller le catalogue au-delà des sorties du moment. Plusieurs de ces
     badges ont besoin de métadonnées d'œuvre (année, studio, format,
     popularité) que la liste locale ne porte pas d'origine : tant qu'elles
     manquent, le badge est « pas encore mesurable » et jamais « 0 % ». */
  discovery: [
    ["first-add", "c", "bookmark", "", { k: "listSize", n: 1 },
      "C'est noté", "Ajoute ton premier anime à ta liste.",
      "Noted", "Add your first anime to your list."],
    ["curious-10", "c", "curious", "10", counter("animeOpened", 10),
      "Lèche-vitrine", "Ouvre la fiche de 10 anime différents.",
      "Window shopping", "Open 10 different anime pages."],
    ["hidden-gem", "u", "gem", "", { k: "popularityUnder", max: 5000, n: 1 },
      "Avant que ce soit cool", "Termine un anime suivi par moins de 5 000 personnes.",
      "Before it was cool", "Finish an anime followed by fewer than 5,000 people."],
    ["archive-1990", "u", "layers", "", { k: "yearBefore", year: 1990, n: 1 },
      "Époque VHS", "Termine un anime sorti avant 1990.",
      "VHS era", "Finish an anime released before 1990."],
    ["pioneer-1975", "e", "history", "", { k: "yearBefore", year: 1975, n: 1 },
      "Archéologue", "Termine un anime sorti avant 1975.",
      "Archaeologist", "Finish an anime released before 1975."],
    ["decades", "l", "timeline", "", { k: "decades", from: 1970, n: 6 },
      "Toutes les époques", "Termine un anime de chaque décennie depuis les années 70.",
      "Every era", "Finish an anime from every decade since the 1970s."],
    ["big-three", "u", "three", "", works("bigThree", "any"),
      "Un des Big Three", "Termine One Piece, Naruto ou Bleach.",
      "One of the Big Three", "Finish One Piece, Naruto or Bleach."],
    /* Derive du statut de diffusion mis en cache, pas observe a l'ajout : ainsi
       le badge vaut aussi pour ce qui est deja dans la liste. */
    ["planning", "c", "calendarPlus", "", { k: "planningUnaired", n: 1 },
      "Vivement la sortie", "Ajoute à ta liste un anime pas encore sorti.",
      "Can't wait", "Add an anime that hasn't aired yet to your list."],
    ["two-voices", "u", "speech", "", flag("bothLangs"),
      "VO ou VF ?", "Regarde le même épisode en VO et en VF.",
      "Sub or dub?", "Watch the same episode both subbed and dubbed."],
    ["blind-pick", "c", "shuffle", "", flag("random"),
      "Au pif", "Lance un anime tiré au hasard.",
      "Lucky dip", "Start an anime picked at random."],
    ["studio-10", "r", "clapper", "10", { k: "studio", n: 10 },
      "Studio préféré", "Termine 10 anime du même studio.",
      "Favourite studio", "Finish 10 anime from the same studio."],
    ["rewatch-1", "r", "loop", "", count("rewatched", 1),
      "On remet ça", "Revois un anime que tu avais déjà terminé.",
      "Once more", "Rewatch an anime you'd already finished."],
    ["rewatch-10", "e", "loop", "10", count("rewatched", 10),
      "Toujours pas lassé", "Revois 10 anime que tu avais déjà terminés.",
      "Never gets old", "Rewatch 10 anime you'd already finished."],
    ["thrice", "e", "again3", "3", { k: "repeatSame", times: 3, n: 1 },
      "Jamais deux sans trois", "Termine le même anime trois fois.",
      "Third time's the charm", "Finish the same anime three times."],
    ["comeback", "u", "flame", "", flag("comeback"),
      "Retour aux affaires", "Reprends un anime laissé de côté plus de 30 jours.",
      "Back at it", "Pick an anime back up after more than 30 days away."],
    ["day-one", "r", "dayD", "", flag("dayOne"),
      "Pas une minute de retard", "Regarde le dernier épisode d'un anime le jour de sa diffusion.",
      "Right on time", "Watch an anime's final episode on the day it airs."],
    /* Commence et termine le meme jour : les deux dates sont sur l'entree de
       liste, il n'y a rien a observer en direct. */
    ["one-sitting", "r", "flame", "", { k: "sameDayFinish", n: 1 },
      "Plié en une journée", "Commence et termine un anime le même jour.",
      "Done in a day", "Start and finish an anime on the same day."],
    ["movies-30", "e", "cinema", "30", format("MOVIE", 30),
      "Cinéphile", "Termine 30 films.",
      "Film buff", "Finish 30 films."],
    ["alphabet", "l", "alphabet", "A-Z", { k: "alphabet", n: 26 },
      "De A à Z", "Termine un anime pour chaque lettre de l'alphabet.",
      "A to Z", "Finish an anime for every letter of the alphabet."],
    ["long-title", "r", "longTitle", "100+", { k: "titleLength", min: 100, n: 1 },
      "Titre de light novel", "Termine un anime dont le titre dépasse 100 caractères.",
      "Light novel title", "Finish an anime whose title runs past 100 characters."],
    ["all-players", "r", "players", "", { k: "hosts", n: 0 },
      "Tous essayés", "Regarde un épisode sur chacun des lecteurs proposés.",
      "Tried them all", "Watch an episode on every player on offer."],
    ["halloween", "u", "skullNight", "31/10", onDate(10, 31, "Horror"),
      "Un bonbon ou un sort", "Regarde un anime d'horreur le 31 octobre.",
      "Trick or treat", "Watch a horror anime on 31 October."],
    ["valentine", "u", "heart", "14/02", onDate(2, 14, "Romance"),
      "Rencard du 14", "Regarde une romance le 14 février.",
      "Valentine's date", "Watch a romance on 14 February."],
    ["april-fool", "u", "fishHook", "01/04", onDate(4, 1, "Comedy"),
      "Sans blague", "Regarde une comédie le 1er avril.",
      "No joke", "Watch a comedy on 1 April."],
  ],

  /* ── Genres ───────────────────────────────────────────────────────────────
     Un badge par famille, sur les anime TERMINÉS. Les noms de genres sont ceux
     d'AniList, en anglais, parce que c'est ce que portent les données — la
     traduction se fait à l'affichage (lib/i18n/genreLabel.ts). */
  genres: [
    ["g-action", "r", "fist", "30", genre("Action", 30),
      "Ça castagne", "Termine 30 anime d'action.",
      "Throwing hands", "Finish 30 action anime."],
    ["g-romance", "r", "partnerHeart", "20", genre("Romance", 20),
      "Fleur bleue", "Termine 20 romances.",
      "Big softie", "Finish 20 romances."],
    ["g-horror", "r", "horror", "15", genre("Horror", 15),
      "Même pas peur", "Termine 15 anime d'horreur.",
      "Not even scared", "Finish 15 horror anime."],
    ["g-mecha", "r", "robot", "10", genre("Mecha", 10),
      "Dans le cockpit", "Termine 10 anime de mecha.",
      "In the cockpit", "Finish 10 mecha anime."],
    ["g-slice", "r", "leaf", "20", genre("Slice of Life", 20),
      "La vie tranquille", "Termine 20 slice of life.",
      "The quiet life", "Finish 20 slice-of-life anime."],
    ["g-isekai", "r", "reborn", "15", { k: "tag", name: "Isekai", n: 15 },
      "Merci Truck-kun", "Termine 15 isekai.",
      "Thanks, Truck-kun", "Finish 15 isekai."],
    ["g-fantasy", "r", "castle", "20", genre("Fantasy", 20),
      "Épée et magie", "Termine 20 anime de fantasy.",
      "Swords and spells", "Finish 20 fantasy anime."],
    ["g-scifi", "r", "rocket", "15", genre("Sci-Fi", 15),
      "Tête dans les étoiles", "Termine 15 anime de science-fiction.",
      "Head in the stars", "Finish 15 sci-fi anime."],
    ["g-mystery", "r", "magnifier", "15", genre("Mystery", 15),
      "Qui a fait le coup ?", "Termine 15 anime de mystère.",
      "Whodunit", "Finish 15 mystery anime."],
    ["g-drama", "r", "teardrop", "20", genre("Drama", 20),
      "Une poussière dans l'œil", "Termine 20 drames.",
      "Something in my eye", "Finish 20 dramas."],
    ["g-comedy", "r", "laugh", "25", genre("Comedy", 25),
      "Mort de rire", "Termine 25 comédies.",
      "Dying of laughter", "Finish 25 comedies."],
    ["g-sports", "r", "volley", "10", genre("Sports", 10),
      "Sportif de canapé", "Termine 10 anime de sport.",
      "Armchair athlete", "Finish 10 sports anime."],
    ["g-music", "r", "note", "10", genre("Music", 10),
      "En rythme", "Termine 10 anime musicaux.",
      "On the beat", "Finish 10 music anime."],
    ["g-psycho", "r", "knightPiece", "10", genre("Psychological", 10),
      "Prise de tête", "Termine 10 anime psychologiques.",
      "Mind games", "Finish 10 psychological anime."],
    ["g-thriller", "r", "eye", "10", genre("Thriller", 10),
      "Tenu en haleine", "Termine 10 thrillers.",
      "Edge of your seat", "Finish 10 thrillers."],
    ["g-school", "r", "school", "20", { k: "tag", name: "School", n: 20 },
      "Délégué de classe", "Termine 20 anime scolaires.",
      "Class rep", "Finish 20 school anime."],
    ["g-food", "r", "chef", "5", { k: "tag", name: "Food", n: 5 },
      "Ça donne faim", "Termine 5 anime de cuisine.",
      "Now I'm hungry", "Finish 5 cooking anime."],
    ["all-genres", "e", "genresAll", "", { k: "allGenres", n: 0 },
      "Touche-à-tout", "Termine au moins un anime dans chaque genre du catalogue.",
      "Jack of all genres", "Finish at least one anime in every genre in the catalogue."],
    ["all-tags", "m", "tagsAll", "", { k: "allTags", n: 0 },
      "Rien ne t'échappe", "Couvre chaque tag du catalogue avec au moins un anime terminé.",
      "Nothing gets past you", "Cover every tag in the catalogue with at least one finished anime."],
  ],

  /* ── Franchises ───────────────────────────────────────────────────────────
     Aller au bout d'une saga. La chaîne des saisons est reconstruite côté
     client à partir des relations AniList déjà en cache sur les entrées de la
     liste (`relIds`), sans interroger notre propre base. */
  franchise: [
    ["saga-2", "r", "rings", "", { k: "franchise", seasons: 2, n: 1 },
      "Jusqu'à la dernière saison", "Termine toutes les saisons d'une franchise (au moins 2).",
      "Every last season", "Finish every season of a franchise (at least 2)."],
    ["saga-4", "e", "rings", "4", { k: "franchise", seasons: 4, n: 1 },
      "La totale", "Termine toutes les saisons d'une franchise qui en compte au moins 4.",
      "The whole saga", "Finish every season of a franchise that has at least 4."],
  ],

  /* ── Régularité ───────────────────────────────────────────────────────────
     La série de jours consécutifs. Jours CALENDAIRES locaux : elle survit au
     changement d'heure et au voyage (cf. lib/badges/localtime.ts). */
  regularity: [
    ["streak-7", "u", "calendarCheck", "7 J", count("streak", 7),
      "Semaine sans faute", "Regarde au moins un épisode 7 jours de suite.",
      "Perfect week", "Watch at least one episode 7 days in a row."],
    ["streak-30", "u", "calendarCheck", "30 J", count("streak", 30),
      "Rendez-vous quotidien", "Regarde au moins un épisode 30 jours de suite.",
      "Daily ritual", "Watch at least one episode 30 days in a row."],
    ["streak-90", "r", "calendarCheck", "90 J", count("streak", 90),
      "Habitude bien ancrée", "Regarde au moins un épisode 90 jours de suite.",
      "Set in your ways", "Watch at least one episode 90 days in a row."],
    ["streak-180", "e", "calendarCheck", "180 J", count("streak", 180),
      "Six mois sans faiblir", "Regarde au moins un épisode 180 jours de suite.",
      "Six months, no gaps", "Watch at least one episode 180 days in a row."],
    ["streak-270", "l", "calendarCheck", "270 J", count("streak", 270),
      "Inarrêtable", "Regarde au moins un épisode 270 jours de suite.",
      "Unstoppable", "Watch at least one episode 270 days in a row."],
    ["streak-365", "m", "calendarCheck", "365 J", count("streak", 365),
      "365 sur 365", "Regarde au moins un épisode chaque jour pendant un an.",
      "365 out of 365", "Watch at least one episode every day for a year."],
  ],

  /* ── Profil et collection ─────────────────────────────────────────────────
     Tenir sa liste, noter, ranger — et collectionner les badges eux-mêmes. */
  profile: [
    ["rated-50", "u", "starList", "50", count("rated", 50),
      "Avis tranché", "Note 50 anime.",
      "Opinionated", "Rate 50 anime."],
    ["rated-200", "r", "starList", "200", count("rated", 200),
      "Le jury a délibéré", "Note 200 anime.",
      "The jury has spoken", "Rate 200 anime."],
    ["fav-1", "c", "heart", "1", count("favourites", 1),
      "Premier coup de cœur", "Mets un anime en favori.",
      "First crush", "Add an anime to your favourites."],
    ["fav-10", "u", "heart", "10", count("favourites", 10),
      "Cœur d'artichaut", "Mets 10 anime en favoris.",
      "Falls in love easily", "Add 10 anime to your favourites."],
    ["first-rating", "c", "starList", "1", count("rated", 1),
      "Premier avis", "Note ton premier anime.",
      "First verdict", "Rate your first anime."],
    ["avatar", "c", "selfie", "", flag("avatar"),
      "Nouvelle tête", "Choisis ta propre photo de profil.",
      "New face", "Set your own profile picture."],
    ["share-link", "c", "copyLink", "", flag("copyLink"),
      "Fais tourner", "Partage ou copie le lien d'un anime.",
      "Pass it on", "Share or copy an anime's link."],
    ["settings", "c", "gear", "", flag("settings"),
      "Bidouilleur", "Ouvre les paramètres.",
      "Tinkerer", "Open the settings."],
    ["custom-list", "c", "listPlus", "", flag("customList"),
      "Maniaque du rangement", "Crée une liste personnalisée.",
      "Neat freak", "Create a custom list."],
    ["one-year-here", "r", "cake", "", { k: "accountAge", days: 365, n: 365 },
      "Un an déjà", "Ton compte AniScroll a un an.",
      "A year already", "Your AniScroll account turns one."],
    ["badges-50", "e", "hexCluster", "50", count("badges", 50),
      "Collectionneur", "Obtiens 50 badges.",
      "Collector", "Earn 50 badges."],
    ["badges-75", "l", "hexCluster", "75", count("badges", 75),
      "Accumulateur", "Obtiens 75 badges.",
      "Hoarder", "Earn 75 badges."],
    ["legendary-5", "l", "trophy", "5", { k: "rarityCount", rarity: "l", n: 5 },
      "Du lourd", "Obtiens 5 badges légendaires.",
      "Heavy hitter", "Earn 5 legendary badges."],
    ["showcase-open", "c", "gridFull", "", flag("badgesTab"),
      "Salle des trophées", "Ouvre ta page de badges.",
      "Trophy room", "Open your badges page."],
    ["secret-50", "l", "question", "50", { k: "secretCount", n: 50 },
      "Fouineur", "Obtiens 50 badges secrets.",
      "Snoop", "Earn 50 secret badges."],
    ["complete", "m", "hexCluster", "100 %", { k: "allBadges", n: 0 },
      "Le compte est bon", "Obtiens tous les autres badges.",
      "Full set", "Earn every other badge."],
  ],

  /* ── Secret ───────────────────────────────────────────────────────────────
     Hors progression ET HORS TOTAL : ils ne comptent pas dans les 101 badges
     annoncés. Leur nom s'affiche, leur condition reste floutée tant qu'ils ne
     sont pas obtenus — et le texte réel n'est PAS rendu dans le DOM. */
  secret: [
    ["anilist-linked", "u", "link", "", flag("anilistLinked"),
      "Bien branché", "Lie ton compte AniList.",
      "Plugged in", "Link your AniList account."],
    ["staff", "m", "shieldCheck", "STAFF", { k: "granted", n: 1 },
      "De la maison", "Réservé à l'équipe d'AniScroll.",
      "Part of the crew", "Only for the AniScroll team."],
    ["beta", "l", "bookmark", "BETA", { k: "granted", n: 1 },
      "Là depuis le début", "Ton compte date de la bêta.",
      "Here from the start", "Your account dates back to the beta."],
    ["changelog", "c", "film", "", flag("changelog"),
      "Lu jusqu'au bout", "Fais défiler le journal des mises à jour jusqu'en bas.",
      "Read to the end", "Scroll the changelog all the way to the bottom."],
    ["dead-end", "u", "screenBroken", "404", counter("notFound", 3),
      "Perdu ?", "Tombe trois fois sur la page 404.",
      "Lost?", "Land on the 404 page three times."],
    ["konami", "e", "dpad", "", flag("konami"),
      "Vieux réflexe de joueur", "Tape le code Konami.",
      "Old gamer reflex", "Enter the Konami code."],
    ["devtools", "r", "console", "", flag("devtools"),
      "Sous le capot", "Ouvre la console développeur.",
      "Under the hood", "Open the developer console."],
    ["dmca", "r", "gavel", "3 MIN", flag("dmca"),
      "Juriste en herbe", "Reste trois minutes sur la page DMCA.",
      "Budding lawyer", "Stay on the DMCA page for three minutes."],
    ["recursive", "r", "loupeSelf", "", flag("recursive"),
      "Mise en abyme", "Cherche « AniScroll » sur AniScroll.",
      "Meta", "Search for \"AniScroll\" on AniScroll."],
    ["not-here", "u", "noEntry", "", flag("notHere"),
      "Mauvaise adresse", "Cherche « hentai ». Ce n'est pas ici.",
      "Wrong address", "Search for \"hentai\". Wrong site."],
    ["polyglot", "u", "translate", "10", flag("polyglot"),
      "Polyglotte indécis", "Change la langue du site 10 fois en une minute.",
      "Undecided polyglot", "Switch the site language 10 times in one minute."],
    ["oldest", "r", "oldest", "", flag("oldest"),
      "Le doyen", "Ouvre la fiche de l'anime le plus ancien du catalogue.",
      "The oldest one", "Open the page of the oldest anime in the catalogue."],
    ["self-search", "c", "selfie", "", flag("selfSearch"),
      "Égo-surf", "Cherche ton propre pseudo.",
      "Ego surfing", "Search for your own username."],
    ["pin-mythic", "u", "showcase", "", flag("pinMythic"),
      "Frimeur", "Épingle un badge mythique sur ton profil.",
      "Show-off", "Pin a mythic badge to your profile."],

    ["one-piece", "m", "compass", "", works("onePiece"),
      "Le One Piece existe", "Termine One Piece.",
      "The One Piece is real", "Finish One Piece."],
    ["hokage", "m", "ninja", "", works("naruto"),
      "Dattebayo !", "Termine Naruto et Naruto Shippuden.",
      "Believe it!", "Finish Naruto and Naruto Shippuden."],
    ["boruto", "l", "scroll", "", works("boruto"),
      "Le fils du Hokage", "Termine Boruto.",
      "The Hokage's son", "Finish Boruto."],
    ["super-saiyan", "m", "aura", "", works("dragonBall"),
      "Plus de 9 000 !", "Termine Dragon Ball, Dragon Ball Z et Dragon Ball Super.",
      "Over 9,000!", "Finish Dragon Ball, Dragon Ball Z and Dragon Ball Super."],
    ["hashira", "e", "blade", "", works("demonSlayer"),
      "Respiration totale", "Termine Demon Slayer, films compris.",
      "Total Concentration", "Finish Demon Slayer, films included."],
    ["walls", "l", "wall", "", works("aot"),
      "Tatakae", "Termine L'Attaque des Titans.",
      "Tatakae", "Finish Attack on Titan."],
    ["hunter-licence", "l", "crown", "", works("hxh"),
      "Examen de Hunter réussi", "Termine Hunter x Hunter.",
      "Passed the Hunter Exam", "Finish Hunter x Hunter."],
    ["bankai", "l", "skull", "", works("bleach"),
      "Shinigami remplaçant", "Termine Bleach, Thousand-Year Blood War compris.",
      "Substitute Soul Reaper", "Finish Bleach, Thousand-Year Blood War included."],
    ["equivalent-exchange", "l", "spell", "", works("fmab"),
      "Alchimiste d'État", "Termine Fullmetal Alchemist: Brotherhood.",
      "State Alchemist", "Finish Fullmetal Alchemist: Brotherhood."],
    ["conan-1000", "m", "sleuth", "1 000", worksEpisodes("conan", 1000),
      "Il n'y a qu'une vérité", "Dépasse les 1 000 épisodes de Détective Conan.",
      "One truth prevails", "Get past 1,000 episodes of Detective Conan."],
    ["pokemon-500", "m", "cat", "500", worksEpisodes("pokemon", 500),
      "Maître Pokémon", "Dépasse les 500 épisodes de Pokémon.",
      "Pokémon Master", "Get past 500 episodes of Pokémon."],
    ["plus-ultra", "e", "titan", "", works("mha"),
      "Héros numéro un", "Termine My Hero Academia.",
      "Number one hero", "Finish My Hero Academia."],
    ["death-note", "e", "pen", "", works("deathNote"),
      "Tout est calculé", "Termine Death Note.",
      "Just as planned", "Finish Death Note."],
    ["jujutsu", "e", "spiral", "", works("jjk"),
      "Extension du territoire", "Termine Jujutsu Kaisen.",
      "Domain Expansion", "Finish Jujutsu Kaisen."],
    ["chainsaw", "r", "chain", "", works("chainsawMan"),
      "Pacte avec Pochita", "Termine Chainsaw Man.",
      "Pochita's deal", "Finish Chainsaw Man."],
    ["rank-s", "r", "gun", "", works("opm"),
      "Un coup suffit", "Termine One Punch Man.",
      "One punch is enough", "Finish One Punch Man."],
    ["black-clover", "e", "spell", "", works("blackClover"),
      "Ne jamais abandonner", "Termine Black Clover.",
      "Never give up", "Finish Black Clover."],
    ["steins-gate", "e", "clockRed", "", works("steinsGate"),
      "El Psy Kongroo", "Termine Steins;Gate.",
      "El Psy Kongroo", "Finish Steins;Gate."],
    ["re-zero", "e", "clockRed", "", works("reZero"),
      "Rem ou Emilia ?", "Termine Re:Zero.",
      "Rem or Emilia?", "Finish Re:Zero."],
    ["sao", "r", "guild", "", works("sao"),
      "Déconnexion impossible", "Termine Sword Art Online.",
      "No logout button", "Finish Sword Art Online."],
    ["slime", "r", "slime", "", works("slime"),
      "Juste un slime", "Termine Moi, quand je me réincarne en Slime.",
      "Just a slime", "Finish That Time I Got Reincarnated as a Slime."],
    ["shield-hero", "r", "wall", "", works("shieldHero"),
      "Accusé à tort", "Termine The Rising of the Shield Hero.",
      "Falsely accused", "Finish The Rising of the Shield Hero."],
    ["mushoku", "r", "scroll", "", works("mushoku"),
      "Cette fois, sérieusement", "Termine Mushoku Tensei.",
      "Serious this time", "Finish Mushoku Tensei."],
    ["overlord", "r", "crown", "", works("overlord"),
      "Seigneur de Nazarick", "Termine Overlord.",
      "Lord of Nazarick", "Finish Overlord."],
    ["konosuba", "r", "guild", "", works("konosuba"),
      "Explosion !", "Termine Konosuba.",
      "Explosion!", "Finish Konosuba."],
    ["frieren", "e", "sunflower", "", works("frieren"),
      "Himmel aurait fait pareil", "Termine Frieren.",
      "What Himmel would do", "Finish Frieren."],
    ["solo-leveling", "r", "gun", "", works("soloLeveling"),
      "Arise", "Termine Solo Leveling.",
      "Arise", "Finish Solo Leveling."],
    ["code-geass", "l", "mechaG", "", works("codeGeass"),
      "Je vous l'ordonne", "Termine Code Geass.",
      "I command you", "Finish Code Geass."],
    ["evangelion", "l", "mechaG", "", works("evangelion"),
      "Monte dans l'EVA", "Termine Neon Genesis Evangelion.",
      "Get in the robot", "Finish Neon Genesis Evangelion."],
    ["bebop", "l", "bounty", "", works("bebop"),
      "See you, space cowboy", "Termine Cowboy Bebop.",
      "See you, space cowboy", "Finish Cowboy Bebop."],
    ["champloo", "e", "blade", "", works("champloo"),
      "Le samouraï tournesol", "Termine Samurai Champloo.",
      "The sunflower samurai", "Finish Samurai Champloo."],
    ["ghost-shell", "l", "space", "", works("gits"),
      "Le net est vaste", "Termine Ghost in the Shell: Stand Alone Complex.",
      "The net is vast", "Finish Ghost in the Shell: Stand Alone Complex."],
    ["trigun", "e", "gun", "", works("trigun"),
      "Love and peace", "Termine Trigun.",
      "Love and peace", "Finish Trigun."],
    ["berserk", "l", "skull", "", works("berserk"),
      "Continuer de lutter", "Termine Berserk.",
      "Keep struggling", "Finish Berserk."],
    ["monster", "l", "sleuth", "", works("monster"),
      "Le monstre sans nom", "Termine Monster.",
      "The nameless monster", "Finish Monster."],
    ["vinland", "e", "blade", "", works("vinland"),
      "Je n'ai pas d'ennemis", "Termine Vinland Saga.",
      "I have no enemies", "Finish Vinland Saga."],
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
      "Vole haut", "Termine Haikyu!!.",
      "Fly high", "Finish Haikyu!!."],
    ["kuroko", "e", "hoop", "", works("kuroko"),
      "Sixième homme fantôme", "Termine Kuroko's Basket.",
      "Phantom sixth man", "Finish Kuroko's Basketball."],
    ["blue-lock", "r", "ball", "", works("blueLock"),
      "Égoïste", "Termine Blue Lock.",
      "Egoist", "Finish Blue Lock."],
    ["yowamushi", "e", "bike", "", works("yowamushi"),
      "En danseuse", "Termine Yowamushi Pedal.",
      "Out of the saddle", "Finish Yowamushi Pedal."],
    ["slam-dunk", "l", "hoop", "", works("slamDunk"),
      "Le roi du rebond", "Termine Slam Dunk.",
      "Rebound king", "Finish Slam Dunk."],
    ["food-wars", "e", "pot", "", works("foodWars"),
      "Shokugeki !", "Termine Food Wars.",
      "Shokugeki!", "Finish Food Wars."],
    ["assassination", "r", "school", "", works("ansatsu"),
      "Objectif : Koro-sensei", "Termine Assassination Classroom.",
      "Target: Koro-sensei", "Finish Assassination Classroom."],
    ["fruits-basket", "e", "gearHeart", "", works("fruitsBasket"),
      "Câlin interdit", "Termine Fruits Basket.",
      "No hugging", "Finish Fruits Basket."],
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
      "Tous les ciels de Shinkai", "Termine tous les films de Makoto Shinkai.",
      "Every Shinkai sky", "Finish every Makoto Shinkai film."],
    ["gintama", "m", "tape", "", works("gintama"),
      "Gin-san approuve", "Termine Gintama.",
      "Gin-san approves", "Finish Gintama."],
    ["mirai-nikki", "r", "diary", "", works("miraiNikki"),
      "Yandere en vue", "Termine Mirai Nikki.",
      "Yandere alert", "Finish Mirai Nikki."],
    ["jojo", "m", "aura", "", works("jojo"),
      "Ora ora ora", "Termine toutes les parties de JoJo's Bizarre Adventure.",
      "Ora ora ora", "Finish every part of JoJo's Bizarre Adventure."],
    ["spy-family", "r", "gearHeart", "", works("spyFamily"),
      "Waku waku", "Termine Spy x Family.",
      "Waku waku", "Finish Spy x Family."],
    ["dr-stone", "e", "spell", "", works("drStone"),
      "Royaume de la science", "Termine Dr. Stone.",
      "Kingdom of Science", "Finish Dr. Stone."],
    ["tokyo-ghoul", "e", "skull", "", works("tokyoGhoul"),
      "Mille moins sept", "Termine Tokyo Ghoul.",
      "1000 minus 7", "Finish Tokyo Ghoul."],
    ["parasyte", "r", "slime", "", works("parasyte"),
      "Salut, Migi", "Termine Parasyte.",
      "Hi, Migi", "Finish Parasyte."],
    ["neverland", "r", "scroll", "", works("neverland"),
      "La grande évasion", "Termine The Promised Neverland.",
      "The great escape", "Finish The Promised Neverland."],
  ],
};
