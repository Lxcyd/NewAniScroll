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
  /** Dernier épisode ouvert à peine quelques secondes (missclic) : « Vu
   *  récemment » le tait, « Regarde en ce moment » le reprend quand même. */
  glance?: boolean;
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
  for (const row of rows) {
    /* UNE CARTE PAR JOURNÉE. Les épisodes enchaînés le même jour tiennent sur
       une carte (« Épisodes 1–3 ») ; un épisode vu un autre jour ouvre la sienne,
       à sa date. L'historique ne connaît que le dernier épisode : les cartes
       plus anciennes n'ont donc ni `watchId` (elles mènent à la fiche) ni
       vignette d'épisode (elles prennent la couverture). */
    const key = (ep: number) => `${row.aniId}:${ep}`;
    /* Un missclic sur le dernier épisode ouvert garde sa ligne (la reprise en a
       besoin) mais ne s'étend à rien : les cartes repartent de l'épisode d'avant. */
    const glance = !!map[key(row.episode)] && !watched(map[key(row.episode)]);
    let last = row.episode;
    let first = true;
    for (;;) {
      const from = first && glance ? last : runStart(map, row.aniId, last);
      const at = Number(map[key(last)]?.updatedAt);
      out.push(
        first
          ? {
              /* La date de la PROGRESSION quand il y en a une : l'historique est
                 re-daté à chaque ouverture, même quand l'épisode, déjà terminé,
                 garde la sienne (cf. `rewatching`, lib/watch/progress.ts). */
              ...decorate(at > 0 ? { ...row, at } : row, map, from),
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

function decorate(row: HistoryRow, map: ProgressMap, runFrom: number): ActivityRow {
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
function runStart(map: ProgressMap, aniId: number, episode: number): number {
  const day = dayOf(map, aniId, episode);
  let first = episode;
  while (first > 1 && watched(map[`${aniId}:${first - 1}`])) {
    const prev = dayOf(map, aniId, first - 1);
    if (day != null && prev != null && prev !== day) break;
    first--;
  }
  return first;
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

export function watchStreak(map: ProgressMap, now = Date.now()): number {
  const days = new Set<number>();
  for (const e of Object.values(map || {})) {
    const at = Number(e?.updatedAt);
    // La table vient d'un navigateur : une entrée sans date, ou datée de
    // n'importe quoi, ne doit pas inventer un jour de lecture.
    // Un missclic de dix secondes n'entretient pas la flamme.
    if (Number.isFinite(at) && at > 0 && watched(e)) days.add(startOfDay(at));
  }
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
 */
export type WatchDay = { n: number; a: number[] };
export type WatchDays = Record<string, WatchDay>;

export function dayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const j = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${j}`;
}

export function watchDays(map: ProgressMap, now = Date.now(), maxDays = 400): WatchDays {
  const since = now - maxDays * 86_400_000;
  const per = new Map<string, Map<number, number>>();
  for (const [k, e] of Object.entries(map || {})) {
    const at = Number(e?.updatedAt);
    if (!(Number.isFinite(at) && at > since && at <= now + 86_400_000) || !watched(e)) continue;
    const aniId = Number(k.split(":")[0]);
    if (!Number.isFinite(aniId) || aniId <= 0) continue;
    const day = dayKey(at);
    let byAnime = per.get(day);
    if (!byAnime) per.set(day, (byAnime = new Map()));
    byAnime.set(aniId, (byAnime.get(aniId) ?? 0) + 1);
  }
  const out: WatchDays = {};
  per.forEach((byAnime, day) => {
    let n = 0;
    byAnime.forEach((c) => (n += c));
    const a = Array.from(byAnime.entries())
      .sort((x, y) => y[1] - x[1])
      .map(([id]) => id);
    out[day] = { n, a };
  });
  return out;
}

/** Les deux catégories dont dépend l'activité, et la série qu'elles portent. */
export function activityFromCloud(
  payloads: { recent?: unknown; progress?: unknown },
  limit = 12,
): { rows: ActivityRow[]; streak: number; days: WatchDays } {
  /* La table est déballée UNE fois et servie aux deux : les lignes en tirent
     leur avancement, la série ses jours. La reparser pour chacun coûterait un
     `JSON.parse` de plus sur un objet qui grandit à chaque épisode vu. */
  const map = progressFromCloud(payloads.progress);
  return {
    rows: decorateRows(historyFromCloud(payloads.recent, limit), map),
    /* Le fuseau est celui du SERVEUR (UTC en production), pas celui du
       propriétaire : sa journée peut donc basculer quelques heures trop tôt ou
       trop tard sur le profil vu par un visiteur. Chez lui, la série est
       recalculée dans son navigateur, donc juste (cf. DeviceBlocks.tsx). */
    streak: watchStreak(map),
    /* Même réserve de fuseau que la série : chez lui, le calendrier est
       recompté dans son navigateur. */
    days: watchDays(map),
  };
}
