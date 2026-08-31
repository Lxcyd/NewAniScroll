/**
 * Server-side store for the categories of user data we back up.
 *
 * One row per (user, kind), JSON payload plus a revision. Conflict rule is
 * last-writer-wins PER CATEGORY, not per site: a device that only changed the
 * player settings can push them without touching the list it hasn't seen.
 * That is why `prefs` and `player` are separate kinds.
 */

import { ensureUsersSchema, getUsersClient } from "../db/turso-users";

export const DATA_KINDS = [
  "list", // aniscroll:localList
  "progress", // aniscroll:progress
  "queue", // aniscroll:queue
  "prefs", // every aniscroll:* settings key
  "favourites",
  "recent", // recently watched
  "player", // playerPrefs, keybindings, autoplay, ambient lights, volume…
] as const;

export type DataKind = (typeof DATA_KINDS)[number];

export function isDataKind(v: unknown): v is DataKind {
  return typeof v === "string" && (DATA_KINDS as readonly string[]).includes(v);
}

/** Refusal threshold per category. A list this big is a bug, not a library. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

export type StoredKind = { kind: DataKind; payload: unknown; rev: number; updatedAt: number };

async function db() {
  const client = getUsersClient();
  if (!client) return null;
  await ensureUsersSchema();
  return client;
}

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

  const json = JSON.stringify(payload ?? null);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) return null;

  const now = Date.now();
  await client.execute({
    sql: `INSERT INTO user_data (user_id, kind, payload, rev, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(user_id, kind) DO UPDATE
            SET payload = excluded.payload,
                rev = user_data.rev + 1,
                updated_at = excluded.updated_at`,
    args: [userId, kind, json, now],
  });

  const res = await client.execute({
    sql: `SELECT rev FROM user_data WHERE user_id = ? AND kind = ?`,
    args: [userId, kind],
  });
  return Number(res.rows[0]?.rev ?? 1);
}
