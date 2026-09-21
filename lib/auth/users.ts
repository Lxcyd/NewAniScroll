/**
 * Every read and write on the `users` table. No SQL about accounts lives
 * anywhere else — the API routes, NextAuth and the admin panel all go through
 * here, which is what keeps `password_hash` from leaking into a response by
 * accident (see toPublicUser).
 */

import type { Row } from "@libsql/client";
import { usersDb as db } from "../db/turso-users";
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
  /** La grille de widgets rangée par le propriétaire, JSON `[{i,x,y,w,h}]`.
   *  Publique comme la bannière : c'est ainsi que le profil se présente aux
   *  autres. Null = la disposition par défaut. */
  profileLayout: string | null;
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
    profileLayout: str(row.profile_layout),
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
 * Link AniList to an account, absorbing the half-identity in the way if there
 * is one.
 *
 * THE DEAD END THIS REPLACES. Accounts were added to a site that had only ever
 * known AniList sign-in, so a great many people already had an AniList-only row
 * — created by `createAnilistAccount` long before they made a password account.
 * Their first "link my AniList" from that new account hit `attachAniList`,
 * which found the old row and threw `anilist-already-linked`. Measured on
 * dev the 01/09/2026: OAUTH_CALLBACK_HANDLER_ERROR, twice in a row, on an
 * account that was the SAME PERSON both times. The only way out the site
 * offered was "sign out and use AniList directly", i.e. abandon the account you
 * just signed into.
 *
 * The refusal is right about one thing and wrong about the other. It is right
 * that an AniList id owned by a real second account — one with a password or an
 * e-mail, that someone can still sign into on its own — must never be taken
 * away, and that case still throws. It is wrong about a row that has NO way in
 * except this very AniList identity: nobody can ever sign into it again once
 * the identity moves, so keeping it is not protecting anyone, it is stranding
 * the data inside it.
 *
 * So that row is absorbed and deleted. Per category, the newest payload wins —
 * the same last-writer-wins rule lib/auth/userData.ts applies between two
 * devices, applied here between two rows of the same person. Everything the
 * target lacks and the source has (pseudo, picture, banner) is carried over,
 * `admin` survives on either side so a merge cannot demote anyone, and
 * `created_at` keeps the older of the two: the account has existed since the
 * first of the pair, not since the merge.
 *
 * One `batch(..., "write")`: the source has to be gone before the target can
 * claim `anilist_id`, which is UNIQUE, and half of that is not a state worth
 * leaving behind.
 */
export async function attachOrAbsorbAniList(
  userId: string,
  params: { anilistId: number; anilistName: string | null; avatarUrl: string | null }
): Promise<UserRecord | null> {
  const client = await db();
  if (!client) return null;

  const source = await findByAnilistId(params.anilistId);
  if (!source || source.id === userId) return attachAniList(userId, params);

  // A row someone can still sign into by itself is a second account, not a
  // stray half-identity. Refuse, as before — and a disabled one is refused too
  // rather than laundered into an active account.
  if (source.passwordHash || source.email || source.status === "disabled") {
    throw new Error("anilist-already-linked");
  }

  const target = await findById(userId);
  if (!target) throw new Error("anilist-already-linked");

  const stored = await client.execute({
    sql: `SELECT user_id, kind, payload, rev, updated_at
            FROM user_data WHERE user_id IN (?, ?)`,
    args: [userId, source.id],
  });
  const newest = new Map<string, Row>();
  for (const row of stored.rows) {
    const kind = String(row.kind);
    const held = newest.get(kind);
    if (!held || Number(row.updated_at) > Number(held.updated_at)) newest.set(kind, row);
  }

  const username = target.username ?? source.username;
  const statements: { sql: string; args: unknown[] }[] = [
    { sql: `DELETE FROM user_data WHERE user_id = ?`, args: [source.id] },
    { sql: `DELETE FROM auth_tokens WHERE user_id = ?`, args: [source.id] },
    { sql: `DELETE FROM users WHERE id = ?`, args: [source.id] },
  ];
  for (const [kind, row] of newest) {
    if (String(row.user_id) !== source.id) continue; // the target's own is newer
    statements.push({
      sql: `INSERT INTO user_data (user_id, kind, payload, rev, updated_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(user_id, kind) DO UPDATE
              SET payload = excluded.payload,
                  rev = user_data.rev + 1,
                  updated_at = excluded.updated_at`,
      args: [userId, kind, String(row.payload), Number(row.rev), Number(row.updated_at)],
    });
  }
  statements.push({
    sql: `UPDATE users
             SET anilist_id = ?, anilist_name = ?, anilist_avatar_url = ?,
                 username = ?, username_lower = ?,
                 avatar_url = COALESCE(avatar_url, ?),
                 profile_banner = COALESCE(profile_banner, ?),
                 profile_layout = COALESCE(profile_layout, ?),
                 role = ?,
                 created_at = MIN(created_at, ?)
           WHERE id = ?`,
    args: [
      params.anilistId,
      params.anilistName,
      params.avatarUrl,
      username,
      username ? normalizeUsername(username) : null,
      source.avatarUrl,
      source.profileBanner,
      source.profileLayout,
      target.role === "admin" || source.role === "admin" ? "admin" : target.role,
      source.createdAt,
      userId,
    ],
  });

  await client.batch(statements as any, "write");
  console.info(`[users] AniList-only account #${source.tag} absorbed into #${target.tag}`);
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

/**
 * La grille de widgets du profil, telle qu'elle sera servie aux visiteurs.
 * `null` remet la disposition par défaut. La validité de la forme est
 * vérifiée par l'appelant (isValidLayout) : ici, c'est une chaîne.
 */
export async function setProfileLayout(userId: string, value: string | null) {
  const client = await db();
  if (!client) return;
  await client.execute({
    sql: `UPDATE users SET profile_layout = ? WHERE id = ?`,
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

/* ── Admin panel ─────────────────────────────────────────────────────────── */

/** How someone gets into their account. Derived, never stored: it follows
 *  the two columns that actually decide it. */
export type AuthMethod = "password" | "anilist" | "both" | "none";

export type AdminUserRow = PublicUser & {
  dataBytes: number;
  authMethod: AuthMethod;
  /** Entries in the synced local list — the best single measure of use. */
  listCount: number;
};

export type UserFilters = {
  q?: string;
  role?: "user" | "admin";
  status?: "active" | "disabled";
  auth?: AuthMethod;
  verified?: "yes" | "no";
  sort?: "created" | "lastSeen" | "data" | "name";
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

const AUTH_SQL = `CASE
  WHEN u.password_hash IS NOT NULL AND u.anilist_id IS NOT NULL THEN 'both'
  WHEN u.password_hash IS NOT NULL THEN 'password'
  WHEN u.anilist_id IS NOT NULL THEN 'anilist'
  ELSE 'none' END`;

/* Whitelisted, so a query string can never reach ORDER BY as SQL. */
const SORTS: Record<NonNullable<UserFilters["sort"]>, string> = {
  created: "u.created_at",
  lastSeen: "u.last_seen_at",
  data: "data_bytes",
  name: "COALESCE(u.username_lower, LOWER(u.anilist_name), u.tag)",
};

/**
 * Admin listing: searchable, filterable, sortable, with what each account
 * stores. The list size comes out of the payload with json_each rather than
 * by shipping 750 KB of list back to Node to count it.
 */
export async function listUsers(
  params: UserFilters,
): Promise<{ users: AdminUserRow[]; total: number }> {
  const client = await db();
  if (!client) return { users: [], total: 0 };

  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const clauses: string[] = [];
  const args: unknown[] = [];

  const q = params.q?.trim().toLowerCase();
  if (q) {
    clauses.push(`(u.username_lower LIKE ? OR u.email_lower LIKE ? OR LOWER(u.tag) LIKE ?
                   OR LOWER(u.anilist_name) LIKE ? OR u.id = ?)`);
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, params.q!.trim());
  }
  if (params.role) { clauses.push("u.role = ?"); args.push(params.role); }
  if (params.status) { clauses.push("u.status = ?"); args.push(params.status); }
  if (params.auth) { clauses.push(`${AUTH_SQL} = ?`); args.push(params.auth); }
  if (params.verified === "yes") clauses.push("u.email_verified_at IS NOT NULL");
  if (params.verified === "no") clauses.push("u.email IS NOT NULL AND u.email_verified_at IS NULL");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const countRes = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM users u ${where}`,
    args: args as any,
  });
  const total = Number(countRes.rows[0]?.n ?? 0);

  const order = SORTS[params.sort ?? "created"] ?? SORTS.created;
  const dir = params.dir === "asc" ? "ASC" : "DESC";

  const res = await client.execute({
    sql: `SELECT u.*,
                 ${AUTH_SQL} AS auth_method,
                 COALESCE((SELECT SUM(LENGTH(d.payload)) FROM user_data d
                            WHERE d.user_id = u.id), 0) AS data_bytes,
                 COALESCE((SELECT COUNT(*) FROM user_data d,
                                  json_each(json_extract(d.payload, '$."aniscroll:localList"'))
                            WHERE d.user_id = u.id AND d.kind = 'list'
                              AND json_valid(d.payload)), 0) AS list_count
            FROM users u ${where}
           ORDER BY ${order} ${dir}, u.id
           LIMIT ? OFFSET ?`,
    args: [...args, limit, offset] as any,
  });

  return {
    users: res.rows.map((row) => ({
      ...toPublicUser(toRecord(row)),
      dataBytes: Number(row.data_bytes ?? 0),
      authMethod: String(row.auth_method) as AuthMethod,
      listCount: Number(row.list_count ?? 0),
    })),
    total,
  };
}

/** Headline numbers for the Users tab. One query, one row. */
export async function userStats() {
  const client = await db();
  if (!client) return null;
  const now = Date.now();
  const day = 86_400_000;
  const r = await client.execute({
    sql: `SELECT
            COUNT(*)                                                   AS total,
            SUM(role = 'admin')                                        AS admins,
            SUM(status = 'disabled')                                   AS disabled,
            SUM(last_seen_at >= ?)                                     AS active24h,
            SUM(last_seen_at >= ?)                                     AS active7d,
            SUM(last_seen_at >= ?)                                     AS active30d,
            SUM(created_at >= ?)                                       AS new7d,
            SUM(created_at >= ?)                                       AS new30d,
            SUM(anilist_id IS NOT NULL)                                AS anilistLinked,
            SUM(password_hash IS NOT NULL)                             AS withPassword,
            SUM(email IS NOT NULL AND email_verified_at IS NULL)       AS unverified
          FROM users`,
    args: [now - day, now - 7 * day, now - 30 * day, now - 7 * day, now - 30 * day],
  });
  const extra = await client.execute(`
    SELECT
      (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM user_data)                          AS dataBytes,
      (SELECT COUNT(*) FROM user_data d LEFT JOIN users u ON u.id = d.user_id
        WHERE u.id IS NULL)                                                               AS orphanRows,
      (SELECT COUNT(*) FROM auth_tokens WHERE expires_at > ${now} AND used_at IS NULL)   AS liveTokens`);
  const row = { ...(r.rows[0] as any), ...(extra.rows[0] as any) };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) out[k] = Number(v ?? 0);
  return out;
}

/**
 * Everything the detail drawer shows about one account, beyond the row.
 * Payloads are summarised here, server-side: the drawer needs "682 anime, 40
 * watching", not the 750 KB list itself.
 */
export async function userDetail(userId: string) {
  const client = await db();
  if (!client) return null;
  const user = await findById(userId);
  if (!user) return null;

  const data = await client.execute({
    sql: `SELECT kind, payload, rev, updated_at FROM user_data WHERE user_id = ? ORDER BY kind`,
    args: [userId],
  });
  const kinds = data.rows.map((row: any) => {
    const payload = String(row.payload ?? "");
    let parsed: any = null;
    try { parsed = JSON.parse(payload); } catch {}
    const inner = (key: string) => {
      const v = parsed?.[key];
      if (typeof v !== "string") return v;
      try { return JSON.parse(v); } catch { return v; }
    };
    let summary: Record<string, unknown> = {};
    if (row.kind === "list") {
      const list = inner("aniscroll:localList") || {};
      const byStatus: Record<string, number> = {};
      let scored = 0;
      let episodes = 0;
      for (const e of Object.values<any>(list)) {
        byStatus[e?.status || "?"] = (byStatus[e?.status || "?"] || 0) + 1;
        if (Number(e?.score) > 0) scored++;
        episodes += Number(e?.progress) || 0;
      }
      summary = { entries: Object.keys(list).length, byStatus, scored, episodes };
    } else if (row.kind === "progress") {
      const p = inner("aniscroll:progress") || {};
      const vals = Object.values<any>(p);
      const last = vals.reduce((m, v) => Math.max(m, Number(v?.updatedAt) || 0), 0);
      const seconds = vals.reduce((s, v) => s + (Number(v?.time) || 0), 0);
      summary = { episodes: vals.length, lastWatchedAt: last || null, hoursWatched: +(seconds / 3600).toFixed(1) };
    } else if (row.kind === "favourites") {
      summary = { count: Array.isArray(parsed) ? parsed.length : 0 };
    } else if (parsed && typeof parsed === "object") {
      summary = { keys: Object.keys(parsed) };
    }
    return {
      kind: String(row.kind),
      bytes: payload.length,
      rev: Number(row.rev ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      summary,
    };
  });

  const now = Date.now();
  const tokens = await client.execute({
    sql: `SELECT kind,
                 SUM(expires_at > ? AND used_at IS NULL) AS live,
                 COUNT(*) AS total
            FROM auth_tokens WHERE user_id = ? GROUP BY kind`,
    args: [now, userId],
  });

  return {
    user: toPublicUser(user),
    authMethod: (user.passwordHash && user.anilistId
      ? "both"
      : user.passwordHash
        ? "password"
        : user.anilistId
          ? "anilist"
          : "none") as AuthMethod,
    hasAnilistToken: await client
      .execute({ sql: "SELECT anilist_token IS NOT NULL AS t FROM users WHERE id = ?", args: [userId] })
      .then((r) => Number((r.rows[0] as any)?.t) === 1)
      .catch(() => false),
    data: kinds,
    tokens: tokens.rows.map((t: any) => ({
      kind: String(t.kind),
      live: Number(t.live ?? 0),
      total: Number(t.total ?? 0),
    })),
  };
}

export async function setRole(userId: string, role: "user" | "admin") {
  const client = await db();
  if (!client) return;
  await client.execute({ sql: `UPDATE users SET role = ? WHERE id = ?`, args: [role, userId] });
}

export async function countAdmins(): Promise<number> {
  const client = await db();
  if (!client) return 0;
  const r = await client.execute(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`);
  return Number(r.rows[0]?.n ?? 0);
}

/** Kills every pending e-mail / reset link. Sessions are JWTs and cannot be
 *  revoked from here — disabling the account is what locks someone out. */
export async function revokeTokens(userId: string): Promise<number> {
  const client = await db();
  if (!client) return 0;
  const r = await client.execute({ sql: `DELETE FROM auth_tokens WHERE user_id = ?`, args: [userId] });
  return r.rowsAffected ?? 0;
}

export async function clearUserData(userId: string, kind?: string): Promise<number> {
  const client = await db();
  if (!client) return 0;
  const r = kind
    ? await client.execute({ sql: `DELETE FROM user_data WHERE user_id = ? AND kind = ?`, args: [userId, kind] })
    : await client.execute({ sql: `DELETE FROM user_data WHERE user_id = ?`, args: [userId] });
  return r.rowsAffected ?? 0;
}

/** Synced data left behind by accounts that no longer exist. */
export async function purgeOrphanData(): Promise<number> {
  const client = await db();
  if (!client) return 0;
  const r = await client.execute(
    `DELETE FROM user_data WHERE user_id NOT IN (SELECT id FROM users)`,
  );
  return r.rowsAffected ?? 0;
}
