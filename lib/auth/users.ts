/**
 * Every read and write on the `users` table. No SQL about accounts lives
 * anywhere else — the API routes, NextAuth and the admin panel all go through
 * here, which is what keeps `password_hash` from leaking into a response by
 * accident (see toPublicUser).
 */

import type { Row } from "@libsql/client";
import { ensureUsersSchema, getUsersClient } from "../db/turso-users";
import { mintTag, ulid } from "./ids";
import { open, seal } from "./secretBox";
import { normalizeUsername, sanitizeUsername } from "./username";

export type UserRecord = {
  id: string;
  tag: string;
  username: string | null;
  usernameLower: string | null;
  email: string | null;
  emailVerifiedAt: number | null;
  passwordHash: string | null;
  anilistId: number | null;
  anilistName: string | null;
  /** The AniScroll picture. Nothing sets it yet — see lib/auth/avatar.ts. */
  avatarUrl: string | null;
  /** AniList's, ours to display only: it goes when the link goes. */
  anilistAvatarUrl: string | null;
  /** The profile banner the owner pinned, JSON `{url, animeId, title}`.
   *  Null means the profile follows its favourite anime. */
  profileBanner: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
  createdAt: number;
  lastSeenAt: number;
};

/** What a client is ever allowed to see. Never carries `passwordHash`. */
export type PublicUser = Omit<UserRecord, "passwordHash" | "usernameLower">;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : v == null ? null : Number(v);
}

function toRecord(row: Row): UserRecord {
  return {
    id: String(row.id),
    tag: String(row.tag),
    username: str(row.username),
    usernameLower: str(row.username_lower),
    email: str(row.email),
    emailVerifiedAt: num(row.email_verified_at),
    passwordHash: str(row.password_hash),
    anilistId: num(row.anilist_id),
    anilistName: str(row.anilist_name),
    avatarUrl: str(row.avatar_url),
    anilistAvatarUrl: str(row.anilist_avatar_url),
    profileBanner: str(row.profile_banner),
    role: row.role === "admin" ? "admin" : "user",
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

export function toPublicUser(u: UserRecord): PublicUser {
  const { passwordHash, usernameLower, ...rest } = u;
  return rest;
}

/** Display name: the AniList name when linked, else the AniScroll pseudo. */
export function displayName(u: UserRecord | PublicUser): string {
  return u.anilistName || u.username || `Guest#${u.tag}`;
}

async function db() {
  const client = getUsersClient();
  if (!client) return null;
  await ensureUsersSchema();
  return client;
}

const SELECT = `SELECT * FROM users`;

async function findOne(sql: string, args: unknown[]): Promise<UserRecord | null> {
  const client = await db();
  if (!client) return null;
  const res = await client.execute({ sql, args: args as any });
  return res.rows.length ? toRecord(res.rows[0]) : null;
}

export function findById(id: string) {
  return findOne(`${SELECT} WHERE id = ?`, [id]);
}

export function findByEmail(email: string) {
  return findOne(`${SELECT} WHERE email_lower = ?`, [email.trim().toLowerCase()]);
}

/**
 * Pseudos are NOT unique — the tag is what makes an identity unique, so two
 * accounts may both be "Lucyd". This returns a row only when exactly one
 * matches; on a shared pseudo it returns null and the caller must be given the
 * tag as well (see findByIdentifier).
 */
export async function findByUsername(username: string) {
  const client = await db();
  if (!client) return null;
  const res = await client.execute({
    sql: `${SELECT} WHERE username_lower = ? LIMIT 2`,
    args: [normalizeUsername(username)],
  });
  return res.rows.length === 1 ? toRecord(res.rows[0]) : null;
}

export function findByAnilistId(anilistId: number) {
  return findOne(`${SELECT} WHERE anilist_id = ?`, [anilistId]);
}

/** The public half of an identity — what a profile URL carries. */
export function findByTag(tag: string) {
  return findOne(`${SELECT} WHERE tag = ?`, [tag.trim().toUpperCase()]);
}

/**
 * Login accepts, in one field: the e-mail, the pseudo, or the pseudo with its
 * tag (`Lucyd#000000`, or `-` in place of `#` since a URL cannot carry one).
 * A bare pseudo only works while nobody else has claimed it — once shared, the
 * tag is the part that says which of them you are.
 */
export async function findByIdentifier(identifier: string) {
  const value = identifier.trim();
  if (value.includes("@")) return findByEmail(value);

  const tagged = /^(.+)[#-]([0-9A-Za-z]{6})$/.exec(value);
  if (tagged) {
    const record = await findByTag(tagged[2]);
    if (record && record.usernameLower === normalizeUsername(tagged[1])) {
      return record;
    }
    return null;
  }
  return findByUsername(value);
}

/**
 * Insert a row, retrying only on a tag collision — the tag is the one thing
 * that has to be unique. A duplicate e-mail is a real error and propagates;
 * a duplicate pseudo is not an error at all.
 */
async function insertUser(
  fields: Partial<UserRecord> & { username?: string | null }
): Promise<UserRecord> {
  const client = await db();
  if (!client) throw new Error("users-db-unavailable");

  const now = Date.now();
  const id = ulid(now);
  const username = fields.username ?? null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const tag = mintTag();
    try {
      await client.execute({
        sql: `INSERT INTO users (
                id, tag, username, username_lower, email, email_lower,
                email_verified_at, password_hash, anilist_id, anilist_name,
                avatar_url, anilist_avatar_url, role, status,
                created_at, last_seen_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          id,
          tag,
          username,
          username ? normalizeUsername(username) : null,
          fields.email ?? null,
          fields.email ? fields.email.trim().toLowerCase() : null,
          fields.emailVerifiedAt ?? null,
          fields.passwordHash ?? null,
          fields.anilistId ?? null,
          fields.anilistName ?? null,
          fields.avatarUrl ?? null,
          fields.anilistAvatarUrl ?? null,
          fields.role ?? "user",
          fields.status ?? "active",
          now,
          now,
        ],
      });
      const created = await findById(id);
      if (!created) throw new Error("users-insert-lost");
      return created;
    } catch (err: any) {
      const message = String(err?.message || err);
      if (attempt < 4 && /users\.tag|UNIQUE.*tag/i.test(message)) continue;
      throw err;
    }
  }
  throw new Error("users-tag-exhausted");
}

/** Full AniScroll account: pseudo + e-mail + password. */
export function createAccount(params: {
  username: string;
  email: string;
  passwordHash: string;
}) {
  return insertUser({
    username: params.username,
    email: params.email,
    passwordHash: params.passwordHash,
  });
}

/**
 * Turn an AniList display name into a pseudo, or null when it doesn't survive
 * our shape rules. Nothing is checked against other accounts: an AniList name
 * someone else already uses here is fine, the tags differ.
 */
function usernameFrom(anilistName: string | null): string | null {
  return sanitizeUsername(anilistName);
}

/**
 * AniList-only account: no e-mail (the AniList API exposes none) and no
 * password, but a real row all the same — id, tag, and the AniList pseudo
 * claimed as the AniScroll one when it is free. Its data is backed up like any
 * other account's, and signing in again with the same AniList id lands on this
 * very row (findByAnilistId), which is what brings everything back.
 */
export async function createAnilistAccount(params: {
  anilistId: number;
  anilistName: string | null;
  avatarUrl: string | null;
}) {
  return insertUser({
    username: usernameFrom(params.anilistName),
    anilistId: params.anilistId,
    anilistName: params.anilistName,
    anilistAvatarUrl: params.avatarUrl,
  });
}

/**
 * Give a pseudo to an AniList row that still has none, because it predates
 * this behaviour. Silent on every failure: it runs on the login path.
 */
export async function backfillUsername(user: UserRecord): Promise<UserRecord> {
  if (user.username || !user.anilistName) return user;
  try {
    const candidate = usernameFrom(user.anilistName);
    if (!candidate) return user;
    return (await setUsername(user.id, candidate)) ?? user;
  } catch {
    return user;
  }
}

/**
 * Attach an AniList identity to an existing AniScroll account.
 * Throws "anilist-already-linked" when that AniList id belongs to someone
 * else — the refusal the plan asks to surface readably.
 */
export async function attachAniList(
  userId: string,
  params: { anilistId: number; anilistName: string | null; avatarUrl: string | null }
): Promise<UserRecord | null> {
  const client = await db();
  if (!client) return null;

  const owner = await findByAnilistId(params.anilistId);
  if (owner && owner.id !== userId) throw new Error("anilist-already-linked");

  await client.execute({
    // Into the AniList column, never over the account's own picture.
    sql: `UPDATE users
             SET anilist_id = ?, anilist_name = ?, anilist_avatar_url = ?
           WHERE id = ?`,
    args: [params.anilistId, params.anilistName, params.avatarUrl, userId],
  });
  return findById(userId);
}

/**
 * The AniList access token and custom lists, kept ON THE ACCOUNT.
 *
 * They used to exist only inside the session cookie, minted by the OAuth
 * round-trip — so an account with AniList linked, signed in with its password,
 * showed "Not connected" in the sync panel and could not push anything. The
 * link belongs to the account, so its credential has to as well.
 *
 * Deliberately not part of UserRecord: `toPublicUser` only strips the password
 * hash, and /api/v2/account/me?export=1 hands the record to the browser. A
 * bearer token for someone's AniList account has no business in there.
 */
export async function setAnilistSession(
  userId: string,
  params: { token?: string | null; lists?: unknown }
): Promise<void> {
  const client = await db();
  if (!client) return;
  const sealed = params.token ? seal(params.token) : null;
  await client.execute({
    sql: `UPDATE users
             SET anilist_token = COALESCE(?, anilist_token),
                 anilist_lists = COALESCE(?, anilist_lists)
           WHERE id = ?`,
    args: [
      sealed,
      Array.isArray(params.lists) ? JSON.stringify(params.lists) : null,
      userId,
    ],
  });
}

export async function getAnilistSession(
  userId: string
): Promise<{ token: string | null; lists: string[] }> {
  const client = await db();
  if (!client) return { token: null, lists: [] };
  const res = await client.execute({
    sql: `SELECT anilist_token, anilist_lists FROM users WHERE id = ?`,
    args: [userId],
  });
  const row = res.rows[0];
  if (!row) return { token: null, lists: [] };
  let lists: string[] = [];
  try {
    const parsed = JSON.parse(str(row.anilist_lists) || "[]");
    if (Array.isArray(parsed)) lists = parsed;
  } catch {}
  return { token: open(str(row.anilist_token)), lists };
}

/**
 * Unlink AniList. Refused when it is the only way in — an account with no
 * password would become unreachable.
 */
export async function detachAniList(userId: string): Promise<UserRecord | null> {
  const client = await db();
  if (!client) return null;
  const user = await findById(userId);
  if (!user) return null;
  if (!user.passwordHash) throw new Error("anilist-only-account");

  await client.execute({
    // The AniList picture goes with the link — the account would otherwise
    // keep wearing the face of something it no longer has. Its own avatar_url
    // is untouched: that one was never AniList's to take.
    sql: `UPDATE users
             SET anilist_id = NULL, anilist_name = NULL, anilist_avatar_url = NULL,
                 anilist_token = NULL, anilist_lists = NULL
           WHERE id = ?`,
    args: [userId],
  });
  return findById(userId);
}

/**
 * Upgrade an AniList-only row into a full account (the "compte AniScroll
 * par-dessus" case). The AniScroll side takes precedence from here on.
 */
export async function upgradeToAccount(
  userId: string,
  params: { username: string; email: string; passwordHash: string }
): Promise<UserRecord | null> {
  const client = await db();
  if (!client) return null;
  await client.execute({
    sql: `UPDATE users
             SET username = ?, username_lower = ?, email = ?, email_lower = ?,
                 password_hash = ?, email_verified_at = NULL
           WHERE id = ?`,
    args: [
      params.username,
      normalizeUsername(params.username),
      params.email,
      params.email.trim().toLowerCase(),
      params.passwordHash,
      userId,
    ],
  });
  return findById(userId);
}

export async function setUsername(userId: string, username: string) {
  const client = await db();
  if (!client) return null;
  await client.execute({
    sql: `UPDATE users SET username = ?, username_lower = ? WHERE id = ?`,
    args: [username, normalizeUsername(username), userId],
  });
  return findById(userId);
}

/**
 * Pin (or, with null, un-pin) the profile banner. The value is a JSON string
 * so the column stays one field whatever we end up remembering alongside the
 * URL; the URL itself is validated by the caller (isAllowedBannerUrl).
 */
export async function setProfileBanner(userId: string, value: string | null) {
  const client = await db();
  if (!client) return;
  await client.execute({
    sql: `UPDATE users SET profile_banner = ? WHERE id = ?`,
    args: [value, userId],
  });
}

export async function setPasswordHash(userId: string, passwordHash: string) {
  const client = await db();
  if (!client) return;
  await client.execute({
    sql: `UPDATE users SET password_hash = ? WHERE id = ?`,
    args: [passwordHash, userId],
  });
}

export async function markEmailVerified(userId: string) {
  const client = await db();
  if (!client) return;
  await client.execute({
    sql: `UPDATE users SET email_verified_at = ? WHERE id = ?`,
    args: [Date.now(), userId],
  });
}

export async function setStatus(userId: string, status: "active" | "disabled") {
  const client = await db();
  if (!client) return;
  await client.execute({
    sql: `UPDATE users SET status = ? WHERE id = ?`,
    args: [status, userId],
  });
}

/** Best-effort presence stamp — never blocks a login. */
export async function touchLastSeen(userId: string): Promise<void> {
  try {
    const client = await db();
    if (!client) return;
    await client.execute({
      sql: `UPDATE users SET last_seen_at = ? WHERE id = ?`,
      args: [Date.now(), userId],
    });
  } catch {}
}

export async function deleteAccount(userId: string): Promise<void> {
  const client = await db();
  if (!client) return;
  await client.execute({ sql: `DELETE FROM user_data WHERE user_id = ?`, args: [userId] });
  await client.execute({ sql: `DELETE FROM auth_tokens WHERE user_id = ?`, args: [userId] });
  await client.execute({ sql: `DELETE FROM users WHERE id = ?`, args: [userId] });
}

/** Admin listing: paginated, searchable, with the stored payload size. */
export async function listUsers(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ users: (PublicUser & { dataBytes: number })[]; total: number }> {
  const client = await db();
  if (!client) return { users: [], total: 0 };

  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const q = params.q?.trim().toLowerCase();
  const where = q
    ? `WHERE username_lower LIKE ? OR email_lower LIKE ? OR tag LIKE ?
         OR LOWER(anilist_name) LIKE ?`
    : "";
  const like = q ? [`%${q}%`, `%${q}%`, `%${q.toUpperCase()}%`, `%${q}%`] : [];

  const countRes = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM users ${where}`,
    args: like as any,
  });
  const total = Number(countRes.rows[0]?.n ?? 0);

  const res = await client.execute({
    sql: `SELECT u.*,
                 COALESCE((SELECT SUM(LENGTH(d.payload)) FROM user_data d
                            WHERE d.user_id = u.id), 0) AS data_bytes
            FROM users u ${where ? where.replace(/\b(username_lower|email_lower|tag|anilist_name)\b/g, "u.$1") : ""}
           ORDER BY u.created_at DESC
           LIMIT ? OFFSET ?`,
    args: [...like, limit, offset] as any,
  });

  return {
    users: res.rows.map((row) => ({
      ...toPublicUser(toRecord(row)),
      dataBytes: Number(row.data_bytes ?? 0),
    })),
    total,
  };
}
