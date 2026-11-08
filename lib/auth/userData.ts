/**
 * Server-side store for the categories of user data we back up.
 *
 * One row per (user, kind), JSON payload plus a revision. Conflict rule is
 * last-writer-wins PER CATEGORY, not per site: a device that only changed the
 * player settings can push them without touching the list it hasn't seen.
 * That is why `prefs` and `player` are separate kinds.
 */

import { usersDb as db } from "../db/turso-users";

export const DATA_KINDS = [
  "list", // aniscroll:localList
  "progress", // aniscroll:progress
  "queue", // aniscroll:queue
  "prefs", // every aniscroll:* settings key
  "favourites",
  "recent", // recently watched
  "player", // playerPrefs, keybindings, autoplay, ambient lights, volume…
  /* Les badges obtenus et les faits qui les nourrissent. Une catégorie à part
     et non un fourre-tout dans `prefs`, pour la même raison que `player` :
     débloquer un badge ne doit pas pousser tous les réglages du site, et
     surtout c'est la SEULE catégorie qui se FUSIONNE au lieu de s'écraser —
     deux appareils qui débloquent chacun un badge doivent garder les deux
     (cf. lib/badges/store.ts et le crochet de fusion de lib/list/cloudSync.ts). */
  "badges",
] as const;

export type DataKind = (typeof DATA_KINDS)[number];

export function isDataKind(v: unknown): v is DataKind {
  return typeof v === "string" && (DATA_KINDS as readonly string[]).includes(v);
}

/** Refusal threshold per category. A list this big is a bug, not a library. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

export type StoredKind = { kind: DataKind; payload: unknown; rev: number; updatedAt: number };

function toStored(rows: { kind: unknown; payload: unknown; rev: unknown; updated_at: unknown }[]) {
  return rows.flatMap((row) => {
    const kind = String(row.kind);
    if (!isDataKind(kind)) return [];
    try {
      return [
        {
          kind,
          payload: JSON.parse(String(row.payload)),
          rev: Number(row.rev),
          updatedAt: Number(row.updated_at),
        },
      ];
    } catch {
      // A payload we can't parse is worse than none: skip it rather than
      // hand the client something that will throw on the other side.
      return [];
    }
  });
}

export async function getAllData(userId: string): Promise<StoredKind[]> {
  const client = await db();
  if (!client) return [];
  const res = await client.execute({
    sql: `SELECT kind, payload, rev, updated_at FROM user_data WHERE user_id = ?`,
    args: [userId],
  });
  return toStored(res.rows as any);
}

/**
 * Les seules catégories demandées.
 *
 * `getAllData` ramène aussi `list`, qui monte à MAX_PAYLOAD_BYTES — un mégaoctet
 * traversé jusqu'au rendu pour rien. Les pages qui n'ont besoin que d'une ou
 * deux catégories passent par ici : la page de profil est rendue à chaque
 * visite, sans cache, et le volume qu'elle déplace est payé à chaque fois.
 */
export async function getData(
  userId: string,
  kinds: DataKind[],
): Promise<StoredKind[]> {
  if (!kinds.length) return [];
  const client = await db();
  if (!client) return [];
  const res = await client.execute({
    sql: `SELECT kind, payload, rev, updated_at
            FROM user_data
           WHERE user_id = ? AND kind IN (${kinds.map(() => "?").join(",")})`,
    args: [userId, ...kinds],
  });
  return toStored(res.rows as any);
}

/**
 * DEUX APPAREILS NE S'EFFACENT PLUS (08/11/2026, Luc : « Vu récemment » sans
 * les épisodes 10-11 d'Aristocrat). Chaque envoi remplaçait la catégorie
 * entière : aniscroll.com y avait mis les épisodes 10 et 11, puis le serveur
 * local, connecté au même compte avec un stockage qui s'arrêtait au 9, a
 * renvoyé sa copie à 12:43 et les a effacés.
 *
 * `progress` : réunion des deux tables, et pour un même épisode la date la plus
 * récente l'emporte. Sans perte possible : aucune entrée ne s'efface seule, le
 * seul effacement est « tout effacer », qui envoie une table vide — elle
 * remplace alors tout, comme avant.
 *
 * `recent` et `list` : une ligne par anime. Pour un anime présent des deux
 * côtés, la plus récente l'emporte ; une ligne ABSENTE de l'envoi reste une
 * suppression (on retire un anime de son historique, de sa liste), donc elle
 * n'est pas recopiée. La liste aussi : une copie périmée renvoyée par le
 * serveur local remettait Aristocrat à 7 dans la liste du compte, que la prod
 * relisait puis renvoyait à AniList.
 */
type Timed = { updatedAt?: unknown; createdAt?: unknown };
const stamp = (v: Timed | undefined, field: "updatedAt" | "createdAt") => {
  const x = v?.[field];
  const n = typeof x === "number" ? x : typeof x === "string" ? Date.parse(x) : NaN;
  return Number.isFinite(n) ? n : 0;
};
export function mergeTimed(kind: "progress" | "recent" | "list", stored: unknown, incoming: unknown): unknown {
  const key = kind === "progress" ? "aniscroll:progress" : kind === "list" ? "aniscroll:localList" : "artplayer_settings";
  const field = kind === "recent" ? "createdAt" : "updatedAt";
  const s = (stored as Record<string, unknown>)?.[key];
  const i = (incoming as Record<string, unknown>)?.[key];
  if (typeof s !== "string" || typeof i !== "string") return incoming;
  const old = JSON.parse(s) as Record<string, Timed>;
  const next = JSON.parse(i) as Record<string, Timed>;
  if (!old || typeof old !== "object" || !next || typeof next !== "object") return incoming;
  if (kind === "progress" && !Object.keys(next).length) return incoming;
  const out: Record<string, Timed> = kind === "progress" ? { ...old, ...next } : { ...next };
  for (const [k, v] of Object.entries(old)) {
    if (k in next && stamp(v, field) > stamp(next[k], field)) out[k] = v;
  }
  return { ...(incoming as object), [key]: JSON.stringify(out) };
}

/**
 * Write one category. `rev` is stamped server-side (previous + 1) so two
 * devices can't argue about numbering. Returns the new revision, or null when
 * the payload is refused.
 */
export async function putData(
  userId: string,
  kind: DataKind,
  payload: unknown
): Promise<number | null> {
  const client = await db();
  if (!client) return null;

  if (kind === "progress" || kind === "recent" || kind === "list") {
    const prev = await client.execute({
      sql: `SELECT payload FROM user_data WHERE user_id = ? AND kind = ?`,
      args: [userId, kind],
    });
    const raw = prev.rows[0]?.payload;
    if (raw != null) {
      try {
        payload = mergeTimed(kind, JSON.parse(String(raw)), payload);
      } catch {
        /* copie illisible : l'envoi la remplace, comme avant */
      }
    }
  }

  const json = JSON.stringify(payload ?? null);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) return null;

  const now = Date.now();
  /* `WHERE … IS NOT` : un contenu identique ne réécrit rien et ne monte pas la
     révision. Les favoris étaient recopiés à chaque vue du profil par son
     propriétaire — 834 révisions pour 16 favoris (23/10/2026). */
  await client.execute({
    sql: `INSERT INTO user_data (user_id, kind, payload, rev, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(user_id, kind) DO UPDATE
            SET payload = excluded.payload,
                rev = user_data.rev + 1,
                updated_at = excluded.updated_at
          WHERE user_data.payload IS NOT excluded.payload`,
    args: [userId, kind, json, now],
  });

  const res = await client.execute({
    sql: `SELECT rev FROM user_data WHERE user_id = ? AND kind = ?`,
    args: [userId, kind],
  });
  return Number(res.rows[0]?.rev ?? 1);
}

/* ── LA COPIE ANILIST DU COMPTE (23/10/2026) ─────────────────────────────────
 *
 * La liste AniList complète (MediaListCollection du profil : entrées, stats,
 * favoris, personnages), telle qu'AniList l'a rendue la dernière fois qu'il a
 * répondu. Elle sert le profil quand AniList est en panne, quelle qu'en soit la
 * durée — la copie Upstash, elle, meurt au bout de 24 h ou avec le quota.
 *
 * Une ligne de `user_data` HORS de DATA_KINDS : `toStored` l'écarte, donc la
 * synchro des appareils (GET /api/v2/account/sync) ne la voit jamais. Gzip +
 * base64 (~1/8 de la taille). Écrite seulement quand elle change (même garde que
 * putData) : une lecture de ligne, et une écriture par modification réelle.
 */
const SNAPSHOT_KIND = "anilist_snapshot";

export async function putAnilistSnapshot(userId: string, z: string): Promise<void> {
  const client = await db();
  if (!client) return;
  const payload = JSON.stringify({ at: Date.now(), z });
  await client.execute({
    sql: `INSERT INTO user_data (user_id, kind, payload, rev, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(user_id, kind) DO UPDATE
            SET payload = excluded.payload,
                rev = user_data.rev + 1,
                updated_at = excluded.updated_at
          WHERE json_extract(user_data.payload, '$.z') IS NOT ?`,
    args: [userId, SNAPSHOT_KIND, payload, Date.now(), z],
  });
}

/* ── LE FIL D'ACTIVITÉ ANILIST DU COMPTE (03/11/2026, Luc) ────────────────────
 *
 * Chaque épisode marqué vu sur AniList, avec son heure : « A regardé l'épisode 4
 * de … ». C'est le seul historique daté qu'AniList garde, et il remonte à la
 * création du compte AniList. Il remplit la heatmap, le calendrier, l'objectif,
 * le bingo et le binge pour tout ce qui a été vu ailleurs que sur AniScroll.
 *
 * Lu par le navigateur du propriétaire (lib/anilist/feedImport.ts) puis rangé
 * ici, HORS de DATA_KINDS comme la copie AniList : la synchro des appareils ne
 * le voit pas. `e` = [secondes, id AniList, épisode], du plus récent au plus
 * ancien ; `last` = l'id de la dernière activité lue, pour ne relire ensuite que
 * les nouvelles.
 */
const FEED_KIND = "anilist_feed";
export type FeedEvent = [number, number, number];
/** `oldest` : la date (s) la plus ancienne déjà lue ; `done` : tout le passé est lu. */
export type AnilistFeed = { last: number; e: FeedEvent[]; oldest?: number; done?: boolean };
/** ~22 octets l'épisode : 40 000 épisodes tiennent sous le Mo. */
export const FEED_MAX_EVENTS = 40_000;

export async function getAnilistFeed(userId: string): Promise<AnilistFeed | null> {
  const client = await db();
  if (!client) return null;
  const res = await client.execute({
    sql: `SELECT payload FROM user_data WHERE user_id = ? AND kind = ?`,
    args: [userId, FEED_KIND],
  });
  const raw = res.rows[0]?.payload;
  if (raw == null) return null;
  try {
    const p = JSON.parse(String(raw));
    return Array.isArray(p?.e) && typeof p?.last === "number" ? p : null;
  } catch {
    return null;
  }
}

export async function putAnilistFeed(userId: string, feed: AnilistFeed): Promise<void> {
  const client = await db();
  if (!client) return;
  const json = JSON.stringify(feed);
  await client.execute({
    sql: `INSERT INTO user_data (user_id, kind, payload, rev, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(user_id, kind) DO UPDATE
            SET payload = excluded.payload,
                rev = user_data.rev + 1,
                updated_at = excluded.updated_at
          WHERE user_data.payload IS NOT excluded.payload`,
    args: [userId, FEED_KIND, json, Date.now()],
  });
}

export async function getAnilistSnapshot(
  userId: string,
): Promise<{ at: number; z: string } | null> {
  const client = await db();
  if (!client) return null;
  const res = await client.execute({
    sql: `SELECT payload FROM user_data WHERE user_id = ? AND kind = ?`,
    args: [userId, SNAPSHOT_KIND],
  });
  const raw = res.rows[0]?.payload;
  if (raw == null) return null;
  try {
    const p = JSON.parse(String(raw));
    return typeof p?.z === "string" && typeof p?.at === "number" ? p : null;
  } catch {
    return null;
  }
}
