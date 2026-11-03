/**
 * LES AMIS D'ANISCROLL (03/11/2026, Luc : « uniquement sur le site, compte
 * AniScroll, AniList ou les deux »).
 *
 * Réciproques : une demande, puis une acceptation. Deux lignes par paire dans
 * `friends` (cf. lib/db/turso-users.ts), une par personne, pour que chaque
 * lecture passe par la clé primaire. Les invités n'ont pas de ligne `users` et
 * n'ont donc pas d'amis.
 *
 * L'identité publique est le TAG (6 caractères), comme dans l'adresse d'un
 * profil : l'identifiant interne ne sort jamais d'ici.
 *
 * LES GOÛTS, pour le widget « Affinité de goûts » : chaque propriétaire range
 * en ouvrant son profil un résumé de sa liste (`{ mediaId: note }`, catégorie
 * `taste` de user_data). Comparer ses amis coûte alors UNE lecture par la clé,
 * au lieu de recharger la liste AniList de chacun.
 */

import type { Row } from "@libsql/client";
import { usersDb as db } from "../db/turso-users";
import { pickAvatar } from "./avatar";
import { profileHref } from "../profile/href";

export type FriendState = "out" | "in" | "friend";
export type FriendCard = { tag: string; name: string; avatar: string | null; href: string; since: number };

const MAX_FRIENDS = 500;
const MAX_PENDING_OUT = 100;
const TASTE_KIND = "taste";
const MAX_TASTE_TITLES = 2000;

function cardOf(r: Row): FriendCard {
  const name = String(r.anilist_name || r.username || `Guest#${r.tag}`);
  return {
    tag: String(r.tag),
    name,
    avatar: pickAvatar({ avatarUrl: r.avatar_url, anilistAvatarUrl: r.anilist_avatar_url }),
    href: profileHref({ name, tag: r.tag }),
    since: Number(r.updated_at) || 0,
  };
}

const CARD_COLS = `u.tag, u.username, u.anilist_name, u.avatar_url, u.anilist_avatar_url`;

async function idOfTag(tag: string): Promise<string | null> {
  const client = await db();
  if (!client || !/^[0-9A-Za-z]{6}$/.test(tag)) return null;
  const r = await client.execute({
    sql: `SELECT id FROM users WHERE tag = ? AND status = 'active'`,
    args: [tag.toUpperCase()],
  });
  return r.rows[0] ? String(r.rows[0].id) : null;
}

/** Amis, demandes reçues, demandes envoyées. */
export async function listFriends(
  userId: string,
): Promise<{ friends: FriendCard[]; incoming: FriendCard[]; outgoing: FriendCard[] }> {
  const out = { friends: [] as FriendCard[], incoming: [] as FriendCard[], outgoing: [] as FriendCard[] };
  const client = await db();
  if (!client) return out;
  const r = await client.execute({
    sql: `SELECT f.state, f.updated_at, ${CARD_COLS}
          FROM friends f JOIN users u ON u.id = f.friend_id
          WHERE f.user_id = ? AND u.status = 'active'
          ORDER BY f.updated_at DESC LIMIT ?`,
    args: [userId, MAX_FRIENDS + MAX_PENDING_OUT + 200],
  });
  for (const row of r.rows) {
    const c = cardOf(row);
    if (row.state === "friend") out.friends.push(c);
    else if (row.state === "in") out.incoming.push(c);
    else out.outgoing.push(c);
  }
  out.friends.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Les amis d'un profil, pour qui le visite (acceptés seulement). */
export async function publicFriends(tag: string): Promise<FriendCard[]> {
  const id = await idOfTag(tag);
  if (!id) return [];
  return (await listFriends(id)).friends;
}

/** Où en est-on avec quelqu'un. */
export async function relation(userId: string, tag: string): Promise<FriendState | "none" | "self" | null> {
  const client = await db();
  const other = await idOfTag(tag);
  if (!client || !other) return null;
  if (other === userId) return "self";
  const r = await client.execute({
    sql: `SELECT state FROM friends WHERE user_id = ? AND friend_id = ?`,
    args: [userId, other],
  });
  return (r.rows[0]?.state as FriendState) ?? "none";
}

export type FriendAction = "request" | "accept" | "remove";

/**
 * Une demande ; accepter ; retirer (refuser, annuler ou ne plus être amis :
 * dans les trois cas, la paire disparaît). Rend le nouvel état.
 */
export async function act(userId: string, tag: string, action: FriendAction): Promise<FriendState | "none" | "error"> {
  const client = await db();
  const other = await idOfTag(tag);
  if (!client || !other || other === userId) return "error";
  const now = Date.now();
  const cur = (
    await client.execute({ sql: `SELECT state FROM friends WHERE user_id = ? AND friend_id = ?`, args: [userId, other] })
  ).rows[0]?.state as FriendState | undefined;

  if (action === "remove") {
    await client.batch(
      [
        { sql: `DELETE FROM friends WHERE user_id = ? AND friend_id = ?`, args: [userId, other] },
        { sql: `DELETE FROM friends WHERE user_id = ? AND friend_id = ?`, args: [other, userId] },
      ],
      "write",
    );
    return "none";
  }

  /* Demander à quelqu'un qui nous a déjà demandé, c'est accepter. */
  if (action === "accept" || (action === "request" && cur === "in")) {
    if (cur !== "in") return cur ?? "none";
    await client.batch(
      [
        { sql: `UPDATE friends SET state = 'friend', updated_at = ? WHERE user_id = ? AND friend_id = ?`, args: [now, userId, other] },
        { sql: `UPDATE friends SET state = 'friend', updated_at = ? WHERE user_id = ? AND friend_id = ?`, args: [now, other, userId] },
      ],
      "write",
    );
    return "friend";
  }

  if (cur) return cur; // déjà amis, ou demande déjà partie
  const pending = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM friends WHERE user_id = ? AND state = 'out'`,
    args: [userId],
  });
  if (Number(pending.rows[0]?.n) >= MAX_PENDING_OUT) return "error";
  await client.batch(
    [
      {
        sql: `INSERT OR IGNORE INTO friends (user_id, friend_id, state, created_at, updated_at) VALUES (?, ?, 'out', ?, ?)`,
        args: [userId, other, now, now],
      },
      {
        sql: `INSERT OR IGNORE INTO friends (user_id, friend_id, state, created_at, updated_at) VALUES (?, ?, 'in', ?, ?)`,
        args: [other, userId, now, now],
      },
    ],
    "write",
  );
  return "out";
}

/**
 * Chercher quelqu'un à ajouter : par tag (« #7F3A2C », ou « Pseudo#7F3A2C »),
 * sinon par début de pseudo. La recherche par pseudo est une plage sur
 * `idx_users_username` — jamais un LIKE, qui lirait toute la table.
 */
export async function searchUsers(userId: string, q: string): Promise<(FriendCard & { state: FriendState | "none" })[]> {
  const client = await db();
  if (!client) return [];
  const text = q.trim();
  if (text.length < 2) return [];
  const tagMatch = /#([0-9A-Za-z]{6})$/.exec(text) || /^([0-9A-Fa-f]{6})$/.exec(text);
  const rows = tagMatch
    ? (
        await client.execute({
          sql: `SELECT u.id, ${CARD_COLS}, 0 AS updated_at FROM users u WHERE u.tag = ? AND u.status = 'active'`,
          args: [tagMatch[1].toUpperCase()],
        })
      ).rows
    : (
        await client.execute({
          sql: `SELECT u.id, ${CARD_COLS}, 0 AS updated_at FROM users u
                WHERE u.username_lower >= ? AND u.username_lower < ? AND u.status = 'active'
                LIMIT 8`,
          args: [text.toLowerCase(), text.toLowerCase() + "￿"],
        })
      ).rows;
  const others = rows.filter((r) => String(r.id) !== userId);
  if (!others.length) return [];
  const states = await client.execute({
    sql: `SELECT friend_id, state FROM friends WHERE user_id = ? AND friend_id IN (${others.map(() => "?").join(",")})`,
    args: [userId, ...others.map((r) => String(r.id))],
  });
  const stateOf = new Map(states.rows.map((r) => [String(r.friend_id), r.state as FriendState]));
  return others.map((r) => ({ ...cardOf(r), state: stateOf.get(String(r.id)) ?? "none" }));
}

/* ── Les goûts ───────────────────────────────────────────────────────────── */

export type Taste = Record<string, number>;

export function cleanTaste(raw: unknown): Taste | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Taste = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{1,7}$/.test(k)) continue;
    const s = Number(v);
    if (!Number.isFinite(s) || s < 0 || s > 100) continue;
    out[k] = Math.round(s * 10) / 10;
    if (++n >= MAX_TASTE_TITLES) break;
  }
  return out;
}

export async function putTaste(userId: string, taste: Taste): Promise<void> {
  const client = await db();
  if (!client) return;
  await client.execute({
    sql: `INSERT INTO user_data (user_id, kind, payload, rev, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(user_id, kind) DO UPDATE
            SET payload = excluded.payload,
                rev = user_data.rev + 1,
                updated_at = excluded.updated_at
          WHERE user_data.payload IS NOT excluded.payload`,
    args: [userId, TASTE_KIND, JSON.stringify(taste), Date.now()],
  });
}

/** Les amis acceptés, chacun avec ses goûts (ceux qui n'en ont pas rangé sont omis). */
export async function friendTastes(userId: string): Promise<(FriendCard & { taste: Taste })[]> {
  const client = await db();
  if (!client) return [];
  const r = await client.execute({
    sql: `SELECT f.updated_at, ${CARD_COLS}, d.payload
          FROM friends f
          JOIN users u ON u.id = f.friend_id
          JOIN user_data d ON d.user_id = f.friend_id AND d.kind = '${TASTE_KIND}'
          WHERE f.user_id = ? AND f.state = 'friend' AND u.status = 'active'
          LIMIT ?`,
    args: [userId, MAX_FRIENDS],
  });
  const out: (FriendCard & { taste: Taste })[] = [];
  for (const row of r.rows) {
    try {
      const taste = cleanTaste(JSON.parse(String(row.payload)));
      if (taste) out.push({ ...cardOf(row), taste });
    } catch {
      /* goûts illisibles : cet ami est sauté */
    }
  }
  return out;
}

/* ── Fusions et suppressions de comptes ─────────────────────────────────── */

/** Un compte absorbé par un autre (users.attachOrAbsorbAniList) lui passe ses amis. */
export async function moveFriends(fromId: string, toId: string): Promise<void> {
  const client = await db();
  if (!client) return;
  await client.batch(
    [
      { sql: `UPDATE OR IGNORE friends SET user_id = ? WHERE user_id = ?`, args: [toId, fromId] },
      { sql: `UPDATE OR IGNORE friends SET friend_id = ? WHERE friend_id = ?`, args: [toId, fromId] },
      { sql: `DELETE FROM friends WHERE user_id = ? OR friend_id = ?`, args: [fromId, fromId] },
      /* Deux comptes qui étaient amis entre eux deviennent un seul. */
      { sql: `DELETE FROM friends WHERE user_id = ? AND friend_id = ?`, args: [toId, toId] },
    ],
    "write",
  );
}

export async function dropFriends(userId: string): Promise<void> {
  const client = await db();
  if (!client) return;
  await client.batch(
    [
      { sql: `DELETE FROM friends WHERE user_id = ?`, args: [userId] },
      { sql: `DELETE FROM friends WHERE friend_id = ?`, args: [userId] },
    ],
    "write",
  );
}
