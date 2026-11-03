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
import { checkThrottle } from "./throttle";

export type FriendState = "out" | "in" | "friend";
export type FriendCard = { tag: string; name: string; avatar: string | null; href: string; since: number };

const MAX_FRIENDS = 500;
const MAX_PENDING_OUT = 100;
/* Côté receveur aussi : sans plafond, une poignée de comptes pouvait noyer
   quelqu'un sous les demandes. Au-delà, les nouvelles demandes sont refusées. */
const MAX_PENDING_IN = 200;
const TASTE_KIND = "taste";
const MAX_TASTE_TITLES = 2000;
const TAG_RE = /^[0-9A-Za-z]{6}$/;

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
  if (!client || !TAG_RE.test(tag)) return null;
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
  /* Les amis d'abord : triées par date seule, des demandes reçues en masse
     poussaient les amis hors de la limite. */
  const r = await client.execute({
    sql: `SELECT f.state, f.updated_at, ${CARD_COLS}
          FROM friends f JOIN users u ON u.id = f.friend_id
          WHERE f.user_id = ? AND u.status = 'active'
          ORDER BY f.state = 'friend' DESC, f.updated_at DESC LIMIT ?`,
    args: [userId, MAX_FRIENDS + MAX_PENDING_OUT + MAX_PENDING_IN],
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

/**
 * Les amis d'un profil, pour qui le visite (acceptés seulement). Un profil
 * PRIVÉ (réglage du profil Prisma, comme pages/en/profile/[user].tsx) ne
 * montre ses amis qu'à son propriétaire : l'API les donnait à tout le monde.
 */
export async function publicFriends(tag: string, viewerId: string | null): Promise<FriendCard[]> {
  const client = await db();
  if (!client || !TAG_RE.test(tag)) return [];
  const r = await client.execute({
    sql: `SELECT id, username, anilist_name FROM users WHERE tag = ? AND status = 'active'`,
    args: [tag.toUpperCase()],
  });
  const row = r.rows[0];
  if (!row) return [];
  const id = String(row.id);
  if (id !== viewerId) {
    const key = String(row.anilist_name || row.username || "");
    if (key) {
      const { getUser } = await import("@/prisma/user");
      const viewed = await getUser(key, false).catch(() => null);
      if (viewed?.setting?.private === true) return [];
    }
  }
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
export async function act(
  userId: string,
  tag: string,
  action: FriendAction,
): Promise<FriendState | "none" | "error" | "full" | "throttled"> {
  const client = await db();
  const other = await idOfTag(tag);
  if (!client || !other || other === userId) return "error";
  const now = Date.now();
  const cur = (
    await client.execute({ sql: `SELECT state FROM friends WHERE user_id = ? AND friend_id = ?`, args: [userId, other] })
  ).rows[0]?.state as FriendState | undefined;
  const count = async (who: string, state: FriendState) =>
    Number(
      (
        await client.execute({
          sql: `SELECT COUNT(*) AS n FROM friends WHERE user_id = ? AND state = ?`,
          args: [who, state],
        })
      ).rows[0]?.n,
    ) || 0;

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
    if ((await count(userId, "friend")) >= MAX_FRIENDS || (await count(other, "friend")) >= MAX_FRIENDS) return "full";
    /* Les deux moitiés ensemble, et seulement si la paire est encore une
       demande des deux côtés : si l'autre a annulé entre-temps, rien ne
       bouge (avant, une moitié « friend » pouvait rester seule). */
    const res = await client.batch(
      [
        {
          sql: `UPDATE friends SET state = 'friend', updated_at = ?
                WHERE user_id = ? AND friend_id = ? AND state = 'out'
                  AND EXISTS (SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ? AND state = 'in')`,
          args: [now, other, userId, userId, other],
        },
        {
          sql: `UPDATE friends SET state = 'friend', updated_at = ?
                WHERE user_id = ? AND friend_id = ? AND state = 'in'
                  AND EXISTS (SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ? AND state = 'friend')`,
          args: [now, userId, other, other, userId],
        },
      ],
      "write",
    );
    if (res[0].rowsAffected) return "friend";
    return ((await relation(userId, tag)) as FriendState | "none" | null) ?? "none";
  }

  if (cur) return cur; // déjà amis, ou demande déjà partie
  if ((await count(userId, "out")) >= MAX_PENDING_OUT) return "full";
  if ((await count(other, "in")) >= MAX_PENDING_IN) return "full";
  if ((await count(userId, "friend")) >= MAX_FRIENDS) return "full";
  /* Anti-spam : 30 demandes par heure, et 3 par jour vers la MÊME personne
     (refuser supprime la paire ; sans ça, on pouvait redemander en boucle). */
  const [perHour, perPair] = await Promise.all([
    checkThrottle(`friend-req:${userId}`, 30, 3600_000),
    checkThrottle(`friend-pair:${userId}:${other}`, 3, 86400_000),
  ]);
  if (!perHour.ok || !perPair.ok) return "throttled";
  const ins = await client.batch(
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
  /* L'autre a demandé au même instant : sa demande est passée la première. */
  if (!ins[0].rowsAffected) return ((await relation(userId, tag)) as FriendState | "none" | null) ?? "none";
  return "out";
}

/**
 * Par début de nom : le pseudo AniScroll OU le nom AniList (03/11/2026 : un
 * compte AniList seul n'a souvent pas de pseudo, et « Lxcyd » restait
 * introuvable). Deux PLAGES, chacune sur son index — `idx_users_username` et
 * `idx_users_anilist_lower`, sur `lower(anilist_name)` : l'expression doit être
 * écrite exactement ainsi pour que SQLite prenne l'index.
 */
async function byName(client: NonNullable<Awaited<ReturnType<typeof db>>>, low: string): Promise<Row[]> {
  const hi = low + "\uffff";
  const [a, b] = await Promise.all([
    client.execute({
      sql: `SELECT u.id, ${CARD_COLS}, 0 AS updated_at FROM users u
            WHERE u.username_lower >= ? AND u.username_lower < ? AND u.status = 'active'
            LIMIT 8`,
      args: [low, hi],
    }),
    client.execute({
      sql: `SELECT u.id, ${CARD_COLS}, 0 AS updated_at FROM users u
            WHERE lower(u.anilist_name) >= ? AND lower(u.anilist_name) < ? AND u.status = 'active'
            LIMIT 8`,
      args: [low, hi],
    }),
  ]);
  const seen = new Set<string>();
  const out: Row[] = [];
  /* L'égalité exacte d'abord, puis l'ordre alphabétique. */
  for (const r of [...a.rows, ...b.rows]) {
    const id = String(r.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  const nameOf = (r: Row) => String(r.anilist_name || r.username || "").toLowerCase();
  out.sort((x, y) => Number(nameOf(y) === low) - Number(nameOf(x) === low) || nameOf(x).localeCompare(nameOf(y)));
  return out.slice(0, 8);
}

/**
 * Chercher quelqu'un à ajouter : par tag (« #7F3A2C », ou « Pseudo#7F3A2C »),
 * sinon par début de pseudo ou de nom AniList (`byName`) : des plages sur
 * index, jamais un LIKE, qui lirait toute la table.
 */
export async function searchUsers(userId: string, q: string): Promise<(FriendCard & { state: FriendState | "none" })[]> {
  const client = await db();
  if (!client) return [];
  const text = q.trim();
  if (text.length < 2) return [];
  const hashTag = /#([0-9A-Za-z]{6})$/.exec(text);
  /* « 7F3A2C » seul peut être un tag OU un début de nom (« facade ») : les deux. */
  const bareTag = hashTag ? null : /^([0-9A-Za-z]{6})$/.exec(text);
  const tag = (hashTag || bareTag)?.[1].toUpperCase();
  const [byTag, named] = await Promise.all([
    tag
      ? client
          .execute({
            sql: `SELECT u.id, ${CARD_COLS}, 0 AS updated_at FROM users u WHERE u.tag = ? AND u.status = 'active'`,
            args: [tag],
          })
          .then((r) => r.rows)
      : ([] as Row[]),
    hashTag ? ([] as Row[]) : byName(client, text.toLowerCase()),
  ]);
  const seenIds = new Set<string>();
  const rows = [...byTag, ...named].filter((r) => {
    const id = String(r.id);
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
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
      /* Si les deux comptes connaissaient la même personne, l'amitié acceptée
         gagne sur une simple demande (sinon le UPDATE OR IGNORE la perdait). */
      {
        sql: `UPDATE friends SET state = 'friend' WHERE user_id = ? AND friend_id IN
                (SELECT friend_id FROM friends WHERE user_id = ? AND state = 'friend')`,
        args: [toId, fromId],
      },
      {
        sql: `UPDATE friends SET state = 'friend' WHERE friend_id = ? AND user_id IN
                (SELECT user_id FROM friends WHERE friend_id = ? AND state = 'friend')`,
        args: [toId, fromId],
      },
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
