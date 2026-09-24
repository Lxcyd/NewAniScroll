/**
 * Le catalogue des badges — 176 définitions.
 *
 * FICHIER GÉNÉRÉ — ne pas éditer à la main.
 * Source : tools/badges/catalog.data.mjs, régénéré par
 * `node tools/badges/gen-catalog.mjs`, qui écrit aussi les libellés dans
 * locales/fr.json et locales/en.json.
 *
 * L'`id` est l'identité du badge : il est écrit dans les données de
 * l'utilisateur et ne doit JAMAIS changer. Les libellés, eux, vivent en i18n
 * sous `badges.<id>.name` et `badges.<id>.cond`.
 */

/** c(ommon) u(ncommon) r(are) e(pic) l(egendary) m(ythic). */
export type Rarity = "c" | "u" | "r" | "e" | "l" | "m";

export type Family =
  | "episodes"
  | "time"
  | "sessions"
  | "finished"
  | "discovery"
  | "genres"
  | "franchise"
  | "regularity"
  | "profile"
  | "secret";

/**
 * Ce que l'évaluateur doit mesurer. `n` est l'objectif quand il est connu
 * d'avance ; les métriques dont la cible dépend des données (tous les genres,
 * tous les lecteurs, toute la collection) portent `n: 0` et la calculent à
 * l'exécution — cf. lib/badges/evaluate.ts.
 */
export type Metric = { k: string; n: number; [param: string]: unknown };

export type BadgeDef = {
  id: string;
  family: Family;
  rarity: Rarity;
  icon: string;
  /** Ce qui s'écrit sur la plaque du jeton. Vide = pas de plaque. */
  tag: string;
  metric: Metric;
  /** L'échelle de paliers à laquelle il appartient, s'il y en a une. */
  ladder?: string;
  secret?: true;
};

export const BADGES: BadgeDef[] = [
  { id: "ep-1", family: "episodes", rarity: "c", icon: "screen3", tag: "1", metric: {"k":"count","of":"episodes","n":1}, ladder: "episodes" },
  { id: "ep-25", family: "episodes", rarity: "u", icon: "screen3", tag: "25", metric: {"k":"count","of":"episodes","n":25}, ladder: "episodes" },
  { id: "ep-250", family: "episodes", rarity: "r", icon: "screen3", tag: "250", metric: {"k":"count","of":"episodes","n":250}, ladder: "episodes" },
  { id: "ep-1000", family: "episodes", rarity: "e", icon: "screen3", tag: "1 000", metric: {"k":"count","of":"episodes","n":1000}, ladder: "episodes" },
  { id: "ep-5000", family: "episodes", rarity: "l", icon: "screen3", tag: "5 000", metric: {"k":"count","of":"episodes","n":5000}, ladder: "episodes" },
  { id: "ep-10000", family: "episodes", rarity: "m", icon: "screen3", tag: "10 000", metric: {"k":"count","of":"episodes","n":10000}, ladder: "episodes" },
  { id: "resume", family: "episodes", rarity: "c", icon: "resume", tag: "", metric: {"k":"flag","name":"resume","n":1} },
  { id: "spotlight", family: "episodes", rarity: "c", icon: "spotlight", tag: "", metric: {"k":"flag","name":"spotlight","n":1} },
  { id: "no-pause", family: "episodes", rarity: "u", icon: "noPause", tag: "", metric: {"k":"flag","name":"noPause","n":1} },
  { id: "burst-20", family: "episodes", rarity: "r", icon: "burst", tag: "20", metric: {"k":"window","ms":86400000,"n":20} },
  { id: "burst-50", family: "episodes", rarity: "e", icon: "speed", tag: "50", metric: {"k":"window","ms":604800000,"n":50} },
  { id: "night-12", family: "episodes", rarity: "e", icon: "flame", tag: "12", metric: {"k":"night","n":12} },
  { id: "late-night", family: "episodes", rarity: "u", icon: "moon", tag: "", metric: {"k":"hourWindow","from":2,"to":5,"n":1} },
  { id: "midnight", family: "episodes", rarity: "r", icon: "dialMoon", tag: "00:00", metric: {"k":"midnight","n":1} },
  { id: "by-the-end", family: "episodes", rarity: "u", icon: "swap", tag: "", metric: {"k":"onlyLastEpisode","n":1} },
  { id: "lunch", family: "episodes", rarity: "c", icon: "cutlery", tag: "", metric: {"k":"hourWindow","from":12,"to":14,"n":1} },
  { id: "airday-50", family: "episodes", rarity: "r", icon: "broadcast", tag: "50", metric: {"k":"counter","name":"onAirDay","n":50} },
  { id: "w2g", family: "episodes", rarity: "u", icon: "screenTwin", tag: "", metric: {"k":"flag","name":"w2g","n":1} },
  { id: "oav", family: "episodes", rarity: "u", icon: "screenPlus", tag: "", metric: {"k":"flag","name":"oav","n":1} },
  { id: "never-op", family: "episodes", rarity: "r", icon: "skipOff", tag: "", metric: {"k":"neverSkipOp","n":1} },
  { id: "time-10h", family: "time", rarity: "c", icon: "hourglass", tag: "10 H", metric: {"k":"count","of":"minutes","n":600}, ladder: "time" },
  { id: "time-1d", family: "time", rarity: "u", icon: "hourglass", tag: "1 J", metric: {"k":"count","of":"minutes","n":1440}, ladder: "time" },
  { id: "time-7d", family: "time", rarity: "r", icon: "hourglass", tag: "7 J", metric: {"k":"count","of":"minutes","n":10080}, ladder: "time" },
  { id: "time-30d", family: "time", rarity: "e", icon: "hourglass", tag: "30 J", metric: {"k":"count","of":"minutes","n":43200}, ladder: "time" },
  { id: "time-100d", family: "time", rarity: "l", icon: "hourglass", tag: "100 J", metric: {"k":"count","of":"minutes","n":144000}, ladder: "time" },
  { id: "time-365d", family: "time", rarity: "m", icon: "hourglass", tag: "365 J", metric: {"k":"count","of":"minutes","n":525600}, ladder: "time" },
  { id: "session-6h", family: "sessions", rarity: "r", icon: "dialMoon", tag: "6 H", metric: {"k":"session","weekend":false,"n":6} },
  { id: "session-12h", family: "sessions", rarity: "e", icon: "weekend", tag: "12 H", metric: {"k":"session","weekend":true,"n":12} },
  { id: "fin-1", family: "finished", rarity: "c", icon: "bookmarkCheck", tag: "1", metric: {"k":"count","of":"completed","n":1}, ladder: "finished" },
  { id: "fin-5", family: "finished", rarity: "u", icon: "bookmarkCheck", tag: "5", metric: {"k":"count","of":"completed","n":5}, ladder: "finished" },
  { id: "fin-25", family: "finished", rarity: "r", icon: "bookmarkCheck", tag: "25", metric: {"k":"count","of":"completed","n":25}, ladder: "finished" },
  { id: "fin-75", family: "finished", rarity: "e", icon: "bookmarkCheck", tag: "75", metric: {"k":"count","of":"completed","n":75}, ladder: "finished" },
  { id: "fin-200", family: "finished", rarity: "l", icon: "bookmarkCheck", tag: "200", metric: {"k":"count","of":"completed","n":200}, ladder: "finished" },
  { id: "fin-500", family: "finished", rarity: "m", icon: "bookmarkCheck", tag: "500", metric: {"k":"count","of":"completed","n":500}, ladder: "finished" },
  { id: "first-add", family: "discovery", rarity: "c", icon: "bookmark", tag: "", metric: {"k":"listSize","n":1} },
  { id: "curious-10", family: "discovery", rarity: "c", icon: "curious", tag: "10", metric: {"k":"counter","name":"animeOpened","n":10} },
  { id: "hidden-gem", family: "discovery", rarity: "u", icon: "gem", tag: "", metric: {"k":"popularityUnder","max":5000,"n":1} },
  { id: "archive-1990", family: "discovery", rarity: "u", icon: "layers", tag: "", metric: {"k":"yearBefore","year":1990,"n":1} },
  { id: "pioneer-1975", family: "discovery", rarity: "e", icon: "history", tag: "", metric: {"k":"yearBefore","year":1975,"n":1} },
  { id: "decades", family: "discovery", rarity: "l", icon: "timeline", tag: "", metric: {"k":"years","from":1970,"n":0} },
  { id: "big-three", family: "discovery", rarity: "u", icon: "three", tag: "", metric: {"k":"worksEpisodes","key":"bigThree","n":1} },
  { id: "planning", family: "discovery", rarity: "c", icon: "calendarPlus", tag: "", metric: {"k":"planningUnaired","n":1} },
  { id: "two-voices", family: "discovery", rarity: "u", icon: "speech", tag: "", metric: {"k":"flag","name":"bothLangs","n":1} },
  { id: "blind-pick", family: "discovery", rarity: "c", icon: "shuffle", tag: "", metric: {"k":"flag","name":"random","n":1} },
  { id: "studio-10", family: "discovery", rarity: "r", icon: "clapper", tag: "10", metric: {"k":"studio","n":10} },
  { id: "rewatch-1", family: "discovery", rarity: "r", icon: "loop", tag: "", metric: {"k":"count","of":"rewatched","n":1} },
  { id: "rewatch-10", family: "discovery", rarity: "e", icon: "loop", tag: "10", metric: {"k":"count","of":"rewatched","n":10} },
  { id: "thrice", family: "discovery", rarity: "e", icon: "again3", tag: "3", metric: {"k":"repeatSame","times":3,"n":1} },
  { id: "comeback", family: "discovery", rarity: "u", icon: "flame", tag: "", metric: {"k":"flag","name":"comeback","n":1} },
  { id: "day-one", family: "discovery", rarity: "r", icon: "dayD", tag: "", metric: {"k":"flag","name":"dayOne","n":1} },
  { id: "one-sitting", family: "discovery", rarity: "r", icon: "flame", tag: "", metric: {"k":"sameDayFinish","n":1} },
  { id: "movies-30", family: "discovery", rarity: "e", icon: "cinema", tag: "30", metric: {"k":"format","name":"MOVIE","n":30} },
  { id: "alphabet", family: "discovery", rarity: "l", icon: "alphabet", tag: "A-Z", metric: {"k":"alphabet","n":26} },
  { id: "long-title", family: "discovery", rarity: "r", icon: "longTitle", tag: "100+", metric: {"k":"titleLength","min":100,"n":1} },
  { id: "all-players", family: "discovery", rarity: "r", icon: "players", tag: "", metric: {"k":"hosts","n":0} },
  { id: "halloween", family: "discovery", rarity: "u", icon: "phantom", tag: "31/10", metric: {"k":"onDate","month":10,"day":31,"genre":"Horror","n":1} },
  { id: "valentine", family: "discovery", rarity: "u", icon: "heart", tag: "14/02", metric: {"k":"onDate","month":2,"day":14,"genre":"Romance","n":1} },
  { id: "april-fool", family: "discovery", rarity: "u", icon: "fishHook", tag: "01/04", metric: {"k":"onDate","month":4,"day":1,"genre":"Comedy","n":1} },
  { id: "g-action", family: "genres", rarity: "r", icon: "fist", tag: "30", metric: {"k":"genre","name":"Action","n":30} },
  { id: "g-romance", family: "genres", rarity: "r", icon: "partnerHeart", tag: "20", metric: {"k":"genre","name":"Romance","n":20} },
  { id: "g-horror", family: "genres", rarity: "r", icon: "horror", tag: "15", metric: {"k":"genre","name":"Horror","n":15} },
  { id: "g-mecha", family: "genres", rarity: "r", icon: "robot", tag: "10", metric: {"k":"genre","name":"Mecha","n":10} },
  { id: "g-slice", family: "genres", rarity: "r", icon: "leaf", tag: "20", metric: {"k":"genre","name":"Slice of Life","n":20} },
  { id: "g-isekai", family: "genres", rarity: "r", icon: "reborn", tag: "15", metric: {"k":"tag","name":"Isekai","n":15} },
  { id: "g-fantasy", family: "genres", rarity: "r", icon: "castle", tag: "20", metric: {"k":"genre","name":"Fantasy","n":20} },
  { id: "g-scifi", family: "genres", rarity: "r", icon: "rocket", tag: "15", metric: {"k":"genre","name":"Sci-Fi","n":15} },
  { id: "g-mystery", family: "genres", rarity: "r", icon: "magnifier", tag: "15", metric: {"k":"genre","name":"Mystery","n":15} },
  { id: "g-drama", family: "genres", rarity: "r", icon: "teardrop", tag: "20", metric: {"k":"genre","name":"Drama","n":20} },
  { id: "g-comedy", family: "genres", rarity: "r", icon: "laugh", tag: "25", metric: {"k":"genre","name":"Comedy","n":25} },
  { id: "g-sports", family: "genres", rarity: "r", icon: "volley", tag: "10", metric: {"k":"genre","name":"Sports","n":10} },
  { id: "g-music", family: "genres", rarity: "r", icon: "note", tag: "10", metric: {"k":"genre","name":"Music","n":10} },
  { id: "g-psycho", family: "genres", rarity: "r", icon: "knightPiece", tag: "10", metric: {"k":"genre","name":"Psychological","n":10} },
  { id: "g-thriller", family: "genres", rarity: "r", icon: "eye", tag: "10", metric: {"k":"genre","name":"Thriller","n":10} },
  { id: "g-school", family: "genres", rarity: "r", icon: "school", tag: "20", metric: {"k":"tag","name":"School","n":20} },
  { id: "g-food", family: "genres", rarity: "r", icon: "chef", tag: "5", metric: {"k":"tag","name":"Food","n":5} },
  { id: "all-genres", family: "genres", rarity: "e", icon: "genresAll", tag: "", metric: {"k":"allGenres","n":0} },
  { id: "all-tags", family: "genres", rarity: "m", icon: "tagsAll", tag: "", metric: {"k":"allTags","n":0} },
  { id: "saga-2", family: "franchise", rarity: "r", icon: "rings", tag: "", metric: {"k":"franchise","seasons":2,"n":1} },
  { id: "saga-4", family: "franchise", rarity: "e", icon: "rings", tag: "4", metric: {"k":"franchise","seasons":4,"n":1} },
  { id: "streak-7", family: "regularity", rarity: "u", icon: "calendarCheck", tag: "7 J", metric: {"k":"count","of":"streak","n":7}, ladder: "streak" },
  { id: "streak-30", family: "regularity", rarity: "u", icon: "calendarCheck", tag: "30 J", metric: {"k":"count","of":"streak","n":30}, ladder: "streak" },
  { id: "streak-90", family: "regularity", rarity: "r", icon: "calendarCheck", tag: "90 J", metric: {"k":"count","of":"streak","n":90}, ladder: "streak" },
  { id: "streak-180", family: "regularity", rarity: "e", icon: "calendarCheck", tag: "180 J", metric: {"k":"count","of":"streak","n":180}, ladder: "streak" },
  { id: "streak-270", family: "regularity", rarity: "l", icon: "calendarCheck", tag: "270 J", metric: {"k":"count","of":"streak","n":270}, ladder: "streak" },
  { id: "streak-365", family: "regularity", rarity: "m", icon: "calendarCheck", tag: "365 J", metric: {"k":"count","of":"streak","n":365}, ladder: "streak" },
  { id: "rated-50", family: "profile", rarity: "u", icon: "starList", tag: "50", metric: {"k":"count","of":"rated","n":50}, ladder: "rated" },
  { id: "rated-200", family: "profile", rarity: "r", icon: "starList", tag: "200", metric: {"k":"count","of":"rated","n":200}, ladder: "rated" },
  { id: "fav-1", family: "profile", rarity: "c", icon: "heart", tag: "1", metric: {"k":"count","of":"favourites","n":1}, ladder: "favourite" },
  { id: "fav-10", family: "profile", rarity: "u", icon: "heart", tag: "10", metric: {"k":"count","of":"favourites","n":10}, ladder: "favourite" },
  { id: "first-rating", family: "profile", rarity: "c", icon: "starList", tag: "1", metric: {"k":"count","of":"rated","n":1}, ladder: "rated" },
  { id: "avatar", family: "profile", rarity: "c", icon: "selfie", tag: "", metric: {"k":"flag","name":"avatar","n":1} },
  { id: "share-link", family: "profile", rarity: "c", icon: "copyLink", tag: "", metric: {"k":"flag","name":"copyLink","n":1} },
  { id: "settings", family: "profile", rarity: "c", icon: "gear", tag: "", metric: {"k":"flag","name":"settings","n":1} },
  { id: "custom-list", family: "profile", rarity: "c", icon: "listPlus", tag: "", metric: {"k":"flag","name":"customList","n":1} },
  { id: "one-year-here", family: "profile", rarity: "r", icon: "cake", tag: "", metric: {"k":"accountAge","days":365,"n":365} },
  { id: "badges-50", family: "profile", rarity: "e", icon: "hexCluster", tag: "50", metric: {"k":"count","of":"badges","n":50}, ladder: "collection" },
  { id: "badges-75", family: "profile", rarity: "l", icon: "hexCluster", tag: "75", metric: {"k":"count","of":"badges","n":75}, ladder: "collection" },
  { id: "legendary-5", family: "profile", rarity: "l", icon: "trophy", tag: "5", metric: {"k":"rarityCount","rarity":"l","n":5} },
  { id: "showcase-open", family: "profile", rarity: "c", icon: "gridFull", tag: "", metric: {"k":"flag","name":"badgesTab","n":1} },
  { id: "secret-50", family: "profile", rarity: "l", icon: "question", tag: "50", metric: {"k":"secretCount","n":50} },
  { id: "complete", family: "profile", rarity: "m", icon: "hexCluster", tag: "100 %", metric: {"k":"allBadges","n":0} },
  { id: "anilist-linked", family: "secret", rarity: "u", icon: "link", tag: "", metric: {"k":"flag","name":"anilistLinked","n":1}, secret: true },
  { id: "staff", family: "secret", rarity: "m", icon: "shieldCheck", tag: "STAFF", metric: {"k":"granted","n":1}, secret: true },
  { id: "beta", family: "secret", rarity: "l", icon: "bookmark", tag: "BETA", metric: {"k":"granted","n":1}, secret: true },
  { id: "changelog", family: "secret", rarity: "c", icon: "film", tag: "", metric: {"k":"flag","name":"changelog","n":1}, secret: true },
  { id: "dead-end", family: "secret", rarity: "u", icon: "screenBroken", tag: "404", metric: {"k":"counter","name":"notFound","n":3}, secret: true },
  { id: "konami", family: "secret", rarity: "e", icon: "dpad", tag: "", metric: {"k":"flag","name":"konami","n":1}, secret: true },
  { id: "devtools", family: "secret", rarity: "r", icon: "console", tag: "", metric: {"k":"flag","name":"devtools","n":1}, secret: true },
  { id: "dmca", family: "secret", rarity: "r", icon: "gavel", tag: "3 MIN", metric: {"k":"flag","name":"dmca","n":1}, secret: true },
  { id: "recursive", family: "secret", rarity: "r", icon: "loupeSelf", tag: "", metric: {"k":"flag","name":"recursive","n":1}, secret: true },
  { id: "not-here", family: "secret", rarity: "u", icon: "noEntry", tag: "", metric: {"k":"flag","name":"notHere","n":1}, secret: true },
  { id: "polyglot", family: "secret", rarity: "u", icon: "translate", tag: "10", metric: {"k":"flag","name":"polyglot","n":1}, secret: true },
  { id: "oldest", family: "secret", rarity: "r", icon: "oldest", tag: "", metric: {"k":"flag","name":"oldest","n":1}, secret: true },
  { id: "self-search", family: "secret", rarity: "c", icon: "selfie", tag: "", metric: {"k":"flag","name":"selfSearch","n":1}, secret: true },
  { id: "pin-mythic", family: "secret", rarity: "u", icon: "showcase", tag: "", metric: {"k":"flag","name":"pinMythic","n":1}, secret: true },
  { id: "one-piece", family: "secret", rarity: "m", icon: "compass", tag: "", metric: {"k":"works","key":"onePiece","mode":"all","n":1}, secret: true },
  { id: "hokage", family: "secret", rarity: "m", icon: "ninja", tag: "", metric: {"k":"works","key":"naruto","mode":"all","n":1}, secret: true },
  { id: "boruto", family: "secret", rarity: "l", icon: "scroll", tag: "", metric: {"k":"works","key":"boruto","mode":"all","n":1}, secret: true },
  { id: "super-saiyan", family: "secret", rarity: "m", icon: "aura", tag: "", metric: {"k":"works","key":"dragonBall","mode":"all","n":1}, secret: true },
  { id: "hashira", family: "secret", rarity: "e", icon: "blade", tag: "", metric: {"k":"works","key":"demonSlayer","mode":"all","n":1}, secret: true },
  { id: "walls", family: "secret", rarity: "l", icon: "wall", tag: "", metric: {"k":"works","key":"aot","mode":"all","n":1}, secret: true },
  { id: "hunter-licence", family: "secret", rarity: "l", icon: "crown", tag: "", metric: {"k":"works","key":"hxh","mode":"all","n":1}, secret: true },
  { id: "bankai", family: "secret", rarity: "l", icon: "skull", tag: "", metric: {"k":"works","key":"bleach","mode":"all","n":1}, secret: true },
  { id: "equivalent-exchange", family: "secret", rarity: "l", icon: "spell", tag: "", metric: {"k":"works","key":"fmab","mode":"all","n":1}, secret: true },
  { id: "conan-1000", family: "secret", rarity: "m", icon: "sleuth", tag: "1 000", metric: {"k":"worksEpisodes","key":"conan","n":1000}, secret: true },
  { id: "pokemon-500", family: "secret", rarity: "m", icon: "cat", tag: "500", metric: {"k":"worksEpisodes","key":"pokemon","n":500}, secret: true },
  { id: "plus-ultra", family: "secret", rarity: "e", icon: "titan", tag: "", metric: {"k":"works","key":"mha","mode":"all","n":1}, secret: true },
  { id: "death-note", family: "secret", rarity: "e", icon: "pen", tag: "", metric: {"k":"works","key":"deathNote","mode":"all","n":1}, secret: true },
  { id: "jujutsu", family: "secret", rarity: "e", icon: "spiral", tag: "", metric: {"k":"works","key":"jjk","mode":"all","n":1}, secret: true },
  { id: "chainsaw", family: "secret", rarity: "r", icon: "chain", tag: "", metric: {"k":"works","key":"chainsawMan","mode":"all","n":1}, secret: true },
  { id: "rank-s", family: "secret", rarity: "r", icon: "gun", tag: "", metric: {"k":"works","key":"opm","mode":"all","n":1}, secret: true },
  { id: "black-clover", family: "secret", rarity: "e", icon: "spell", tag: "", metric: {"k":"works","key":"blackClover","mode":"all","n":1}, secret: true },
  { id: "steins-gate", family: "secret", rarity: "e", icon: "clockRed", tag: "", metric: {"k":"works","key":"steinsGate","mode":"all","n":1}, secret: true },
  { id: "re-zero", family: "secret", rarity: "e", icon: "clockRed", tag: "", metric: {"k":"works","key":"reZero","mode":"all","n":1}, secret: true },
  { id: "sao", family: "secret", rarity: "r", icon: "guild", tag: "", metric: {"k":"works","key":"sao","mode":"all","n":1}, secret: true },
  { id: "slime", family: "secret", rarity: "r", icon: "slime", tag: "", metric: {"k":"works","key":"slime","mode":"all","n":1}, secret: true },
  { id: "shield-hero", family: "secret", rarity: "r", icon: "wall", tag: "", metric: {"k":"works","key":"shieldHero","mode":"all","n":1}, secret: true },
  { id: "mushoku", family: "secret", rarity: "r", icon: "scroll", tag: "", metric: {"k":"works","key":"mushoku","mode":"all","n":1}, secret: true },
  { id: "overlord", family: "secret", rarity: "r", icon: "crown", tag: "", metric: {"k":"works","key":"overlord","mode":"all","n":1}, secret: true },
  { id: "konosuba", family: "secret", rarity: "r", icon: "guild", tag: "", metric: {"k":"works","key":"konosuba","mode":"all","n":1}, secret: true },
  { id: "frieren", family: "secret", rarity: "e", icon: "sunflower", tag: "", metric: {"k":"works","key":"frieren","mode":"all","n":1}, secret: true },
  { id: "solo-leveling", family: "secret", rarity: "r", icon: "gun", tag: "", metric: {"k":"works","key":"soloLeveling","mode":"all","n":1}, secret: true },
  { id: "code-geass", family: "secret", rarity: "l", icon: "mechaG", tag: "", metric: {"k":"works","key":"codeGeass","mode":"all","n":1}, secret: true },
  { id: "evangelion", family: "secret", rarity: "l", icon: "mechaG", tag: "", metric: {"k":"works","key":"evangelion","mode":"all","n":1}, secret: true },
  { id: "bebop", family: "secret", rarity: "l", icon: "bounty", tag: "", metric: {"k":"works","key":"bebop","mode":"all","n":1}, secret: true },
  { id: "champloo", family: "secret", rarity: "e", icon: "blade", tag: "", metric: {"k":"works","key":"champloo","mode":"all","n":1}, secret: true },
  { id: "ghost-shell", family: "secret", rarity: "l", icon: "space", tag: "", metric: {"k":"works","key":"gits","mode":"all","n":1}, secret: true },
  { id: "trigun", family: "secret", rarity: "e", icon: "gun", tag: "", metric: {"k":"works","key":"trigun","mode":"all","n":1}, secret: true },
  { id: "berserk", family: "secret", rarity: "l", icon: "skull", tag: "", metric: {"k":"works","key":"berserk","mode":"all","n":1}, secret: true },
  { id: "monster", family: "secret", rarity: "l", icon: "sleuth", tag: "", metric: {"k":"works","key":"monster","mode":"all","n":1}, secret: true },
  { id: "vinland", family: "secret", rarity: "e", icon: "blade", tag: "", metric: {"k":"works","key":"vinland","mode":"all","n":1}, secret: true },
  { id: "kingdom", family: "secret", rarity: "e", icon: "crown", tag: "", metric: {"k":"works","key":"kingdom","mode":"all","n":1}, secret: true },
  { id: "ngnl", family: "secret", rarity: "r", icon: "card", tag: "", metric: {"k":"works","key":"ngnl","mode":"all","n":1}, secret: true },
  { id: "yugioh", family: "secret", rarity: "l", icon: "card", tag: "", metric: {"k":"works","key":"yugioh","mode":"all","n":1}, secret: true },
  { id: "haikyu", family: "secret", rarity: "e", icon: "volley", tag: "", metric: {"k":"works","key":"haikyu","mode":"all","n":1}, secret: true },
  { id: "kuroko", family: "secret", rarity: "e", icon: "hoop", tag: "", metric: {"k":"works","key":"kuroko","mode":"all","n":1}, secret: true },
  { id: "blue-lock", family: "secret", rarity: "r", icon: "ball", tag: "", metric: {"k":"works","key":"blueLock","mode":"all","n":1}, secret: true },
  { id: "yowamushi", family: "secret", rarity: "e", icon: "bike", tag: "", metric: {"k":"works","key":"yowamushi","mode":"all","n":1}, secret: true },
  { id: "slam-dunk", family: "secret", rarity: "l", icon: "hoop", tag: "", metric: {"k":"works","key":"slamDunk","mode":"all","n":1}, secret: true },
  { id: "food-wars", family: "secret", rarity: "e", icon: "pot", tag: "", metric: {"k":"works","key":"foodWars","mode":"all","n":1}, secret: true },
  { id: "assassination", family: "secret", rarity: "r", icon: "school", tag: "", metric: {"k":"works","key":"ansatsu","mode":"all","n":1}, secret: true },
  { id: "fruits-basket", family: "secret", rarity: "e", icon: "gearHeart", tag: "", metric: {"k":"works","key":"fruitsBasket","mode":"all","n":1}, secret: true },
  { id: "toradora", family: "secret", rarity: "r", icon: "gearHeart", tag: "", metric: {"k":"works","key":"toradora","mode":"all","n":1}, secret: true },
  { id: "clannad", family: "secret", rarity: "e", icon: "teapot", tag: "", metric: {"k":"works","key":"clannad","mode":"all","n":1}, secret: true },
  { id: "your-lie", family: "secret", rarity: "e", icon: "note", tag: "", metric: {"k":"works","key":"yourLie","mode":"all","n":1}, secret: true },
  { id: "ghibli-1", family: "secret", rarity: "u", icon: "movies", tag: "", metric: {"k":"studioNamed","name":"Studio Ghibli","n":1}, secret: true },
  { id: "ghibli-10", family: "secret", rarity: "l", icon: "movies", tag: "10", metric: {"k":"studioNamed","name":"Studio Ghibli","n":10}, secret: true },
  { id: "shinkai", family: "secret", rarity: "e", icon: "twilight", tag: "", metric: {"k":"works","key":"shinkai","mode":"all","n":1}, secret: true },
  { id: "gintama", family: "secret", rarity: "m", icon: "tape", tag: "", metric: {"k":"works","key":"gintama","mode":"all","n":1}, secret: true },
  { id: "mirai-nikki", family: "secret", rarity: "r", icon: "diary", tag: "", metric: {"k":"works","key":"miraiNikki","mode":"all","n":1}, secret: true },
  { id: "jojo", family: "secret", rarity: "m", icon: "aura", tag: "", metric: {"k":"works","key":"jojo","mode":"all","n":1}, secret: true },
  { id: "spy-family", family: "secret", rarity: "r", icon: "gearHeart", tag: "", metric: {"k":"works","key":"spyFamily","mode":"all","n":1}, secret: true },
  { id: "dr-stone", family: "secret", rarity: "e", icon: "spell", tag: "", metric: {"k":"works","key":"drStone","mode":"all","n":1}, secret: true },
  { id: "tokyo-ghoul", family: "secret", rarity: "e", icon: "skull", tag: "", metric: {"k":"works","key":"tokyoGhoul","mode":"all","n":1}, secret: true },
  { id: "parasyte", family: "secret", rarity: "r", icon: "slime", tag: "", metric: {"k":"works","key":"parasyte","mode":"all","n":1}, secret: true },
  { id: "neverland", family: "secret", rarity: "r", icon: "scroll", tag: "", metric: {"k":"works","key":"neverland","mode":"all","n":1}, secret: true },
];

export const BY_ID: Record<string, BadgeDef> = Object.fromEntries(
  BADGES.map((b) => [b.id, b]),
);

/**
 * Les échelles, du plus petit palier au plus grand.
 *
 * L'onglet n'affiche qu'un badge par échelle — le premier non atteint — et
 * range les autres dans le dépli.
 */
export const LADDERS: Record<string, string[]> = {
  "episodes": [
    "ep-1",
    "ep-25",
    "ep-250",
    "ep-1000",
    "ep-5000",
    "ep-10000"
  ],
  "finished": [
    "fin-1",
    "fin-5",
    "fin-25",
    "fin-75",
    "fin-200",
    "fin-500"
  ],
  "time": [
    "time-10h",
    "time-1d",
    "time-7d",
    "time-30d",
    "time-100d",
    "time-365d"
  ],
  "streak": [
    "streak-7",
    "streak-30",
    "streak-90",
    "streak-180",
    "streak-270",
    "streak-365"
  ],
  "rated": [
    "first-rating",
    "rated-50",
    "rated-200"
  ],
  "collection": [
    "badges-50",
    "badges-75"
  ],
  "favourite": [
    "fav-1",
    "fav-10"
  ]
};

/** Les badges hors secret : ceux qui comptent dans le total annoncé. */
export const MAIN = BADGES.filter((b) => !b.secret);
export const SECRETS = BADGES.filter((b) => b.secret);

/** L'ordre des raretés, du socle au sommet. */
export const RARITY_ORDER: Rarity[] = ["c", "u", "r", "e", "l", "m"];
