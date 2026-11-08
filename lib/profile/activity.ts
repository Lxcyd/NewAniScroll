/**
 * L'activité de lecture d'un profil, reconstruite CÔTÉ SERVEUR.
 *
 * Les blocs « Regarde en ce moment » et « Vu récemment » lisaient le
 * localStorage du navigateur qui affiche la page. Sur le profil d'un autre, ils
 * montraient donc la lecture du VISITEUR sous le nom du propriétaire — c'est
 * pourquoi `visibleTo` les masquait, et c'est ce que ce fichier répare.
 *
 * Rien n'est collecté ici : les deux stores dont ils dépendent sont déjà
 * sauvegardés sur le compte par lib/list/cloudSync.ts —
 * `artplayer_settings` sous la catégorie `recent`, `aniscroll:progress` sous la
 * catégorie `progress`. Il n'y a qu'à les déballer.
 *
 * La forme d'un payload est celle que `readKind` écrit : les chaînes brutes du
 * localStorage, indexées par leur clé de stockage. D'où deux étages à défaire,
 * exactement comme `localListFromCloudPayload` le fait pour la liste (voir
 * lib/profile/sources.ts) : la clé, puis le JSON qu'elle porte.
 */

import { rowsFromRaw, type HistoryRow } from "./history";
import { GLANCE_SECONDS, isCompleted, type ProgressEntry } from "../watch/progress";

/** Une ligne d'historique, augmentée de son avancement. */
export type ActivityRow = HistoryRow & {
  /** Avancement dans l'épisode, 0 quand la durée est inconnue. */
  pct: number;
  /** Minutes restantes, `null` quand la durée est inconnue. */
  minutesLeft: number | null;
  done: boolean;
  /**
   * LE PREMIER ÉPISODE DE LA SÉRIE CONSÉCUTIVE qui se termine sur `episode`.
   * Vaut `episode` quand il n'y a rien avant : la ligne parle alors d'un seul
   * épisode. Six épisodes d'affilée donnent `runFrom: 1` sur une ligne dont
   * l'épisode est 6, ce que le widget écrit « Épisodes 1–6 ».
   */
  runFrom: number;
  /** Carte d'un jour plus ancien, reconstruite depuis la table de progression :
   *  pas la dernière lecture de l'anime, donc rien à reprendre. */
  older?: boolean;
  /** Dernier épisode ouvert moins d'une minute (missclic, ou jamais lancé) :
   *  « Vu récemment » et « Reprendre la lecture » le taisent tous deux
   *  (08/11/2026, Luc). */
  glance?: boolean;
  /**
   * LE DERNIER ÉPISODE VU, quand celui de l'historique n'a jamais été lancé
   * (08/11/2026, Luc : « barre à 0 alors que j'ai tout fini ») — l'épisode
   * suivant ouvert d'office à la fin du précédent, sans aucune progression.
   * La carte parle de celui-ci (« Épisodes 7–9 », terminé) ; son lien mène
   * toujours à `episode`, le prochain à regarder.
   */
  lastSeen?: number;
};

export type ProgressMap = Record<string, ProgressEntry>;

/**
 * Sous une minute RÉELLEMENT regardée, un épisode n'est pas « vu » — même
 * « terminé » : un clic au bout de la barre le termine en 10 s. Il ne compte ni
 * dans une série d'épisodes, ni dans la flamme. Les entrées d'avant le compteur
 * `watched` retombent sur la position.
 */
const GLANCE_S = GLANCE_SECONDS;

function watched(p: ProgressEntry | null | undefined): boolean {
  if (!p) return false;
  if (typeof p.watched === "number") return p.watched >= GLANCE_S;
  return isCompleted(p) || Number(p.time) >= GLANCE_S;
}

/** Le JSON porté par une clé de stockage, dans le payload d'une catégorie. */
function unwrap(payload: unknown, key: string): unknown {
  const raw = (payload as any)?.[key];
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** L'historique du profil, du plus récent au plus ancien. */
export function historyFromCloud(payload: unknown, limit = 12): HistoryRow[] {
  return rowsFromRaw(unwrap(payload, "artplayer_settings"), limit);
}

/**
 * La table de progression du profil, indexée `aniId:episode`.
 *
 * Un objet vide est une valeur normale et non une absence : `clearAllProgress`
 * écrit `"{}"` plutôt que de supprimer la clé, précisément parce que `readKind`
 * saute une clé absente et n'aurait donc jamais poussé l'effacement.
 */
export function progressFromCloud(payload: unknown): ProgressMap {
  const parsed = unwrap(payload, "aniscroll:progress");
  return parsed && typeof parsed === "object" ? (parsed as ProgressMap) : {};
}

/**
 * Le jumeau serveur du `decorate()` qui vivait dans DeviceBlocks.
 *
 * Il prend la table en paramètre au lieu d'appeler `getProgress`, qui lit le
 * localStorage et renvoie donc toujours `null` hors navigateur — l'avancement
 * de tout le monde serait resté à zéro sans que rien n'échoue.
 */
export function decorateRows(rows: HistoryRow[], map: ProgressMap): ActivityRow[] {
  const out: ActivityRow[] = [];
  const others = watchedTimes(map);
  const queue = [...rows];
  for (let qi = 0; qi < queue.length; qi++) {
    const row = queue[qi];
    /* UNE CARTE PAR JOURNÉE. Les épisodes enchaînés le même jour tiennent sur
       une carte (« Épisodes 1–3 ») ; un épisode vu un autre jour ouvre la sienne,
       à sa date. L'historique ne connaît que le dernier épisode : les cartes
       plus anciennes n'ont donc ni `watchId` (elles mènent à la fiche) ni
       vignette d'épisode (elles prennent la couverture). */
    const key = (ep: number) => `${row.aniId}:${ep}`;
    /* Un missclic sur le dernier épisode ouvert garde sa ligne (la reprise en a
       besoin) mais ne s'étend à rien : les cartes repartent de l'épisode d'avant. */
    /* LE DERNIER ÉPISODE VU de la carte (cf. `lastSeen`) :
       - celui de l'historique s'il a été regardé ;
       - sinon, s'il a été ouvert sans être lancé juste après un épisode vu,
         ce dernier ;
       - puis on PROLONGE tant que l'épisode suivant est vu (08/11/2026, Luc) :
         regardé ailleurs ou marqué sur AniList (cf. `withFeed`), il n'est pas
         dans l'historique de cet appareil, qui s'arrêtait au 9 d'Aristocrat
         quand AniList disait 11. */
    const own = map[key(row.episode)];
    let end: number | null = watched(own)
      ? row.episode
      : !own && row.episode > 1 && watched(map[key(row.episode - 1)])
        ? row.episode - 1
        : null;
    if (end != null) while (watched(map[key(end + 1)])) end++;
    const lastSeen = end != null && end !== row.episode ? end : null;
    /* MOINS D'UNE MINUTE, OU JAMAIS LANCÉ, NE COMPTE PAS (08/11/2026, Luc :
       « ne compte pas un anime regardé moins de 1 minute »). Un épisode ouvert
       sans aucune progression enregistrée n'était pas pris pour un missclic —
       seul celui ouvert quelques secondes l'était — et gardait sa carte, barre
       vide (Apothecary ép. 1, King's Avatar ép. 4). */
    const glance = end == null;
    /* ROUVERT MOINS D'UNE MINUTE : RIEN NE CHANGE (08/11/2026, Luc). Le
       lecteur a remplacé la ligne de l'anime à l'ouverture, mais a gardé la
       dernière vraiment regardée (`before`, lib/profile/history.ts) : la ligne
       ouverte est marquée `glance` (et tue partout), et les cartes repartent
       de celle d'avant, comme si on n'avait rien ouvert. */
    if (glance && row.before) {
      out.push({ ...decorate(row, map, row.episode), glance });
      queue.push(row.before);
      continue;
    }
    let last = row.episode;
    let first = true;
    for (;;) {
      const from = first && glance ? last : runStart(map, row.aniId, first && lastSeen ? lastSeen : last, others);
      const at = Number(map[key(first && lastSeen ? lastSeen : last)]?.updatedAt);
      out.push(
        first
          ? {
              /* La date de la PROGRESSION quand il y en a une : l'historique est
                 re-daté à chaque ouverture, même quand l'épisode, déjà terminé,
                 garde la sienne (cf. `rewatching`, lib/watch/progress.ts). */
              ...(lastSeen
                ? {
                    ...decorate({ ...row, episode: lastSeen, ...(at > 0 ? { at } : {}) }, map, from),
                    episode: row.episode,
                    lastSeen,
                    /* Une carte qui dépasse l'épisode de l'historique ne peut
                       plus rouvrir celui-ci (déjà vu) : elle mène à la fiche. */
                    ...(lastSeen > row.episode ? { watchId: null } : {}),
                  }
                : decorate(at > 0 ? { ...row, at } : row, map, from)),
              ...(glance ? { glance } : {}),
            }
          : {
              ...decorate(
                { ...row, episode: last, watchId: null, image: null, episodeTitle: null, at },
                map,
                from,
              ),
              older: true,
            },
      );
      if (from <= 1 || !watched(map[key(from - 1)])) break;
      last = from - 1;
      first = false;
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

function decorate(full: HistoryRow, map: ProgressMap, runFrom: number): ActivityRow {
  /* `before` ne sert qu'au calcul : il ne voyage pas jusqu'à la page. */
  const { before: _before, ...row } = full;
  const p = map[`${row.aniId}:${row.episode}`] ?? null;
  const pct =
    p && p.duration > 0 ? Math.min(100, Math.round((p.time / p.duration) * 100)) : 0;
  const minutesLeft =
    p && p.duration > 0 ? Math.max(0, Math.round((p.duration - p.time) / 60)) : null;
  return { ...row, pct, minutesLeft, done: isCompleted(p), runFrom };
}

/** Le jour local d'un épisode de la table, `null` quand il n'est pas daté. */
function dayOf(map: ProgressMap, aniId: number, episode: number): number | null {
  const at = Number(map[`${aniId}:${episode}`]?.updatedAt);
  return Number.isFinite(at) && at > 0 ? startOfDay(at) : null;
}

/**
 * Jusqu'où remonte la série d'épisodes qui se termine sur celui-ci.
 *
 * LA SÉRIE S'ARRÊTE AU CHANGEMENT DE JOUR : l'épisode 1 vu il y a deux
 * semaines et le 3 hier ne font pas « Épisodes 1–3 », mais deux cartes. Une
 * entrée non datée ne coupe rien (ancienne table).
 *
 * L'HISTORIQUE NE GARDE QU'UNE LIGNE PAR ANIME — le dernier épisode ouvert.
 * Impossible d'y lire « j'ai enchaîné les six premiers ». La table de
 * progression, elle, a une entrée PAR ÉPISODE (`aniId:episode`) : il suffit de
 * redescendre tant que le précédent y figure.
 *
 * UNE SÉRIE CONSÉCUTIVE, ET PAS LE MINIMUM DE CE QUI EXISTE. Prendre le plus
 * petit épisode vu de l'anime donnerait « 1–10 » à qui a vu les six premiers il
 * y a un an et le dixième ce matin : la ligne annoncerait un enchaînement qui
 * n'a pas eu lieu. En remontant pas à pas, un trou arrête le compte — c'est bien
 * la série qu'on est en train de regarder qui est décrite, et rien d'autre.
 *
 * La boucle est bornée par sa nature : elle ne descend que vers 1.
 */
/*
 * UN AUTRE ANIME ENTRE DEUX ÉPISODES COUPE LA SÉRIE (08/11/2026, Luc). « 5–8 »,
 * puis un épisode d'un autre anime le même jour, puis on reprend le premier :
 * trois cartes — la reprise a la sienne, à sa date — et pas une carte « 5–10 »
 * qui raconterait un enchaînement qui n'a pas eu lieu. `others` : les dates des
 * épisodes vus, avec leur anime (cf. `watchedTimes`).
 */
function runStart(map: ProgressMap, aniId: number, episode: number, others: [number, number][]): number {
  const day = dayOf(map, aniId, episode);
  let first = episode;
  while (first > 1 && watched(map[`${aniId}:${first - 1}`])) {
    const prev = dayOf(map, aniId, first - 1);
    if (day != null && prev != null && prev !== day) break;
    const a = Number(map[`${aniId}:${first - 1}`]?.updatedAt);
    const b = Number(map[`${aniId}:${first}`]?.updatedAt);
    if (a > 0 && b > 0 && others.some(([t, id]) => id !== aniId && t > Math.min(a, b) && t < Math.max(a, b))) break;
    first--;
  }
  return first;
}

/**
 * LA TABLE DE PROGRESSION, COMPLÉTÉE PAR LE FIL ANILIST (08/11/2026, Luc : « tu
 * ne peux pas réparer avec AniList, il manque les premiers épisodes et les
 * derniers »). Un épisode que le fil dit vu et que la table ne connaît pas —
 * regardé ailleurs, sur un autre site ou avant AniScroll, ou coché sur AniList
 * — y entre comme TERMINÉ, daté de sa première mention dans le fil (les
 * suivantes peuvent être des réécritures : le 07/11, AniList a reçu deux fois un
 * retour à l'épisode 7). La table l'emporte toujours quand elle a l'épisode :
 * elle porte la vraie position et la vraie durée.
 *
 * `since` : ne garder que les épisodes plus récents (ms), pour ce qu'on envoie
 * au navigateur du propriétaire.
 */
export function withFeed(map: ProgressMap, feed?: FeedEvent[] | null, since = 0): ProgressMap {
  if (!feed?.length) return map;
  const out: ProgressMap = { ...map };
  const added = new Set<string>();
  for (const f of feed) {
    if (!Array.isArray(f)) continue;
    const at = Number(f[0]) * 1000;
    const aniId = Number(f[1]);
    const ep = Number(f[2]);
    if (!(at > since) || !(aniId > 0) || !(ep > 0)) continue;
    const k = `${aniId}:${ep}`;
    if (map[k] && watched(map[k])) continue;
    if (added.has(k) && Number(out[k].updatedAt) <= at) continue;
    added.add(k);
    out[k] = { time: 1440, duration: 1440, updatedAt: at, watched: 1440 };
  }
  return out;
}

/** Les épisodes vus de la table, `[date, anime]`. */
function watchedTimes(map: ProgressMap): [number, number][] {
  const out: [number, number][] = [];
  for (const [k, e] of Object.entries(map || {})) {
    const at = Number(e?.updatedAt);
    if (at > 0 && watched(e)) out.push([at, Number(k.split(":")[0])]);
  }
  return out;
}

/**
 * LA SÉRIE : depuis combien de jours d'affilée a-t-on regardé quelque chose.
 *
 * ELLE SE LIT DANS LA TABLE DE PROGRESSION, PAS DANS L'HISTORIQUE. Celui-ci ne
 * garde qu'UNE ligne par anime (le dernier épisode ouvert) et n'en garde que
 * douze : il ne peut pas répondre « ai-je regardé quelque chose mardi ? » —
 * douze lignes ne peuvent pas décrire trente jours. La table de progression, au
 * contraire, a une entrée par ÉPISODE et chacune porte la date de sa dernière
 * écriture : c'est un vrai journal des jours de lecture.
 *
 * LE JOUR EST CELUI DU CALENDRIER LOCAL, et pas une tranche de 24 h : la série
 * répond à « hier, aujourd'hui », ce que les gens comptent en couchers de
 * soleil et pas en heures écoulées. D'où `setHours(0,0,0,0)` pour dater, et un
 * pas en arrière par `setDate(-1)` PLUTÔT QUE PAR SOUSTRACTION DE 86 400 000 :
 * deux fois l'an un jour local ne dure pas 24 h, et le pas fixe tomberait à
 * 23 h ou 01 h du jour précédent — jamais sur son minuit, donc une série cassée
 * net au changement d'heure.
 *
 * LA JOURNÉE EN COURS NE COMPTE PAS CONTRE SOI. Ne rien avoir regardé
 * aujourd'hui ne casse pas la série : la journée n'est pas finie. Le compte
 * part donc d'aujourd'hui s'il y a une trace, sinon d'hier — et seulement si
 * hier en a une, faute de quoi la série est bien à zéro.
 */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayBefore(ms: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * LES ÉPISODES DATÉS, toutes sources confondues (03/11/2026, Luc).
 *
 * La table de progression (ce qui a été vu SUR AniScroll) et le fil d'activité
 * AniList (tout ce qui a été marqué vu sur AniList, avec l'heure, depuis la
 * création du compte AniList — cf. lib/anilist/feedImport.ts). Un épisode
 * présent dans les deux ne compte qu'une fois : regardé ici, il est aussi
 * poussé sur AniList, qui en écrit une ligne à quelques minutes près. La ligne
 * AniList est donc écartée quand la table a le même épisode dans les 12 h.
 *
 * Le fil ne connaît pas la durée : 24 min, regardées en entier.
 */
export type FeedEvent = [number, number, number];
/** `ep` : le numéro de l'épisode (0 si illisible). */
type Watch = { at: number; aniId: number; dur: number; seen: number; ep: number };

function watchesOf(map: ProgressMap, feed?: FeedEvent[] | null): Watch[] {
  const out: Watch[] = [];
  const here = new Map<string, number>();
  for (const [k, e] of Object.entries(map || {})) {
    const at = Number(e?.updatedAt);
    // La table vient d'un navigateur : une entrée sans date, ou datée de
    // n'importe quoi, ne doit pas inventer un jour de lecture.
    // Un missclic de dix secondes ne compte pas.
    if (!(Number.isFinite(at) && at > 0) || !watched(e)) continue;
    const aniId = Number(k.split(":")[0]);
    if (!Number.isFinite(aniId) || aniId <= 0) continue;
    const dur = Number(e.duration) > 0 ? Number(e.duration) : 24 * 60;
    const seen = typeof e.watched === "number" ? e.watched : Math.min(Number(e.time) || 0, dur);
    out.push({ at, aniId, dur, seen, ep: Number(k.split(":")[1]) || 0 });
    here.set(k, at);
  }
  for (const f of feed || []) {
    if (!Array.isArray(f)) continue;
    const at = Number(f[0]) * 1000;
    const aniId = Number(f[1]);
    if (!(at > 0) || !(aniId > 0)) continue;
    const mine = here.get(`${aniId}:${f[2]}`);
    if (mine != null && Math.abs(mine - at) < 12 * 3_600_000) continue;
    out.push({ at, aniId, dur: 24 * 60, seen: 24 * 60, ep: Number(f[2]) || 0 });
  }
  return out;
}

export function watchStreak(map: ProgressMap, now = Date.now(), feed?: FeedEvent[] | null): number {
  const days = new Set<number>();
  for (const w of watchesOf(map, feed)) days.add(startOfDay(w.at));
  if (!days.size) return 0;

  const today = startOfDay(now);
  let cursor = days.has(today) ? today : dayBefore(today);
  let n = 0;
  while (days.has(cursor)) {
    n++;
    cursor = dayBefore(cursor);
  }
  return n;
}

/**
 * LE JOURNAL DES JOURS REGARDÉS, pour le calendrier du profil.
 *
 * Même source que la flamme : chaque épisode de la table porte la date de sa
 * dernière écriture. Un épisode compte le jour où il a été vu (une minute
 * réelle au moins, comme partout) ; revu plus tard, il passe au jour du
 * revisionnage — la table ne garde qu'une date par épisode.
 *
 * La clé est le jour LOCAL « AAAA-MM-JJ ». `a` liste les animes du jour, le
 * plus regardé d'abord, TOUS (Luc, 25/10) : la case montre le premier, les
 * autres en anneaux autour d'elle au survol. Bornée à `maxDays` en arrière : c'est ce qui voyage dans la page
 * d'un visiteur, et un an suffit à un calendrier qu'on feuillette mois par mois.
 *
 * À égalité d'épisodes, l'anime vu le PREMIER dans la journée passe devant
 * (02/11/2026, Luc) — avant, l'ordre interne de la table décidait.
 */
export type WatchDay = {
  n: number;
  a: number[];
  /** Épisodes de chaque anime de `a`, dans le même ordre. Absent des jours
   *  servis avant le 02/11/2026. */
  c?: number[];
  /** Le plus haut numéro d'épisode vu ce jour-là, pour chaque anime de `a`
   *  (06/11/2026) : le bingo y lit si le DERNIER épisode a été vu pendant la
   *  période, ce qui seul fait un anime « terminé » pendant la période. */
  e?: number[];
  /** Le plus BAS numéro d'épisode vu ce jour-là, même ordre (06/11/2026) : un
   *  jour dont tous les épisodes dépassent la fiche AniList est un essai. */
  f?: number[];
};
export type WatchDays = Record<string, WatchDay>;

export function dayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const j = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${j}`;
}

/* 1000 jours (03/11/2026) : avec le fil AniList, la heatmap remonte près de trois ans
   en arrière. Le journal voyage dans la page des visiteurs : ~40 octets par
   jour regardé, une vingtaine de Ko au pire. */
export function watchDays(
  map: ProgressMap,
  now = Date.now(),
  maxDays = 1000,
  feed?: FeedEvent[] | null,
): WatchDays {
  const since = now - maxDays * 86_400_000;
  const per = new Map<string, Map<number, { c: number; first: number; e: number; f: number }>>();
  for (const { at, aniId, ep } of watchesOf(map, feed)) {
    if (!(at > since && at <= now + 86_400_000)) continue;
    const day = dayKey(at);
    let byAnime = per.get(day);
    if (!byAnime) per.set(day, (byAnime = new Map()));
    const cur = byAnime.get(aniId);
    if (cur) {
      cur.c += 1;
      cur.first = Math.min(cur.first, at);
      cur.e = Math.max(cur.e, ep);
      cur.f = Math.min(cur.f, ep);
    } else byAnime.set(aniId, { c: 1, first: at, e: ep, f: ep });
  }
  const out: WatchDays = {};
  per.forEach((byAnime, day) => {
    let n = 0;
    byAnime.forEach((v) => (n += v.c));
    const sorted = Array.from(byAnime.entries()).sort((x, y) => y[1].c - x[1].c || x[1].first - y[1].first);
    out[day] = { n, a: sorted.map(([id]) => id), c: sorted.map(([, v]) => v.c), e: sorted.map(([, v]) => v.e), f: sorted.map(([, v]) => v.f) };
  });
  return out;
}

/**
 * LA JOURNÉE RECORD (03/11/2026, Luc) : le jour où l'on a vu le plus
 * d'épisodes. Elle remplace « le plus long binge » le même jour : une ligne
 * AniList « épisodes 1 - 8 » date les huit épisodes de la même seconde, et
 * une session calculée à la minute près n'avait plus de sens. Le jour, lui, est
 * juste quelle que soit la source.
 *
 * Le jour LOCAL (fuseau du serveur côté visiteur, cf. la réserve plus bas). À
 * égalité d'épisodes, le plus de minutes, puis le plus récent. `a` liste les
 * animes du jour, le plus regardé d'abord ; `o` dans l'ordre où on les a vus.
 * Le type garde son nom `Binge` : le bloc s'appelle toujours `binge`.
 */
export type Binge = {
  n: number;
  minutes: number;
  start: number;
  end: number;
  a: number[];
  /** Épisodes de chaque anime de `a`, dans le même ordre (absent avant le 03/11). */
  c?: number[];
  /** Les animes dans l'ORDRE DE VISIONNAGE (premier épisode vu d'abord). */
  o?: number[];
};

export function busiestDay(map: ProgressMap, feed?: FeedEvent[] | null): Binge | null {
  const eps = watchesOf(map, feed);
  if (!eps.length) return null;
  eps.sort((x, y) => x.at - y.at);
  const byDay = new Map<string, Watch[]>();
  for (const w of eps) {
    const k = dayKey(w.at);
    const list = byDay.get(k);
    if (list) list.push(w);
    else byDay.set(k, [w]);
  }
  let best: Binge | null = null;
  byDay.forEach((run) => {
    const per = new Map<number, number>();
    const order: number[] = [];
    let secs = 0;
    for (const r of run) {
      if (!per.has(r.aniId)) order.push(r.aniId);
      per.set(r.aniId, (per.get(r.aniId) ?? 0) + 1);
      secs += r.seen;
    }
    const minutes = Math.round(secs / 60);
    const end = run[run.length - 1].at;
    const b = best as Binge | null;
    if (b && (run.length < b.n || (run.length === b.n && (minutes < b.minutes || (minutes === b.minutes && end < b.end)))))
      return;
    const sorted = Array.from(per.entries()).sort((x, y) => y[1] - x[1]);
    best = {
      n: run.length,
      minutes,
      start: run[0].at - run[0].dur * 1000,
      end,
      a: sorted.map(([id]) => id),
      c: sorted.map(([, c]) => c),
      o: order,
    };
  });
  return best;
}

/** Les deux catégories dont dépend l'activité, et la série qu'elles portent. */
export function activityFromCloud(
  payloads: { recent?: unknown; progress?: unknown; feed?: FeedEvent[] | null },
  limit = 12,
): { rows: ActivityRow[]; streak: number; days: WatchDays; binge: Binge | null } {
  const feed = payloads.feed;
  /* La table est déballée UNE fois et servie aux deux : les lignes en tirent
     leur avancement, la série ses jours. La reparser pour chacun coûterait un
     `JSON.parse` de plus sur un objet qui grandit à chaque épisode vu. */
  const map = progressFromCloud(payloads.progress);
  return {
    rows: decorateRows(historyFromCloud(payloads.recent, limit), withFeed(map, feed)),
    /* Le fuseau est celui du SERVEUR (UTC en production), pas celui du
       propriétaire : sa journée peut donc basculer quelques heures trop tôt ou
       trop tard sur le profil vu par un visiteur. Chez lui, la série est
       recalculée dans son navigateur, donc juste (cf. DeviceBlocks.tsx). */
    streak: watchStreak(map, Date.now(), feed),
    /* Même réserve de fuseau que la série : chez lui, le calendrier est
       recompté dans son navigateur. Le fil AniList s'y ajoute (03/11/2026). */
    days: watchDays(map, Date.now(), 1000, feed),
    binge: busiestDay(map, feed),
  };
}
