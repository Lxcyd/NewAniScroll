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
import { isCompleted, type ProgressEntry } from "../watch/progress";

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
};

export type ProgressMap = Record<string, ProgressEntry>;

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
  return rows.map((row) => {
    const p = map[`${row.aniId}:${row.episode}`] ?? null;
    const pct =
      p && p.duration > 0 ? Math.min(100, Math.round((p.time / p.duration) * 100)) : 0;
    const minutesLeft =
      p && p.duration > 0 ? Math.max(0, Math.round((p.duration - p.time) / 60)) : null;
    return {
      ...row,
      pct,
      minutesLeft,
      done: isCompleted(p),
      runFrom: runStart(map, row.aniId, row.episode),
    };
  });
}

/**
 * Jusqu'où remonte la série d'épisodes qui se termine sur celui-ci.
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
  let first = episode;
  while (first > 1 && map[`${aniId}:${first - 1}`]) first--;
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
    if (Number.isFinite(at) && at > 0) days.add(startOfDay(at));
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

/** Les deux catégories dont dépend l'activité, et la série qu'elles portent. */
export function activityFromCloud(
  payloads: { recent?: unknown; progress?: unknown },
  limit = 12,
): { rows: ActivityRow[]; streak: number } {
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
  };
}
