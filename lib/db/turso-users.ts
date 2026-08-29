import { createClient, type Client } from "@libsql/client";

/**
 * Singleton libSQL/Turso client for the USERS database.
 *
 * Third database of the site, next to the anime cache (lib/db/turso.ts) and
 * the admin/ops one (lib/db/turso-admin.ts). Accounts live apart for the same
 * reason admin data does: credentials and user-owned payloads must never be
 * reachable through a mishap on the anime cache, and they get their own
 * backup/restore cycle.
 *
 * Env vars expected in `.env.local` and on both Vercel environments:
 *   TURSO_USERS_URL   = libsql://aniscroll-users-<org>.turso.io
 *   TURSO_USERS_TOKEN = <auth token from the Turso dashboard>
 *
 * Returns null when unset — every caller must then degrade gracefully
 * (accounts simply unavailable) rather than crash. That is what keeps a
 * misconfigured preview deploy from taking the whole site down.
 */

let client: Client | null = null;
let warned = false;

export function getUsersClient(): Client | null {
  if (client) return client;

  const url = process.env.TURSO_USERS_URL;
  const authToken = process.env.TURSO_USERS_TOKEN;

  if (!url) {
    if (!warned) {
      console.warn(
        "[turso-users] TURSO_USERS_URL not set — AniScroll accounts are inactive."
      );
      warned = true;
    }
    return null;
  }

  client = createClient({ url, authToken });
  return client;
}

/**
 * Create every table. Idempotent, safe on each cold boot, mirrors
 * lib/db/schema-users.sql. Same shape as ensureAdminSchema(): one execute per
 * statement so a parser quirk on one can't silently abort the batch.
 */
let schemaReady = false;
export async function ensureUsersSchema(): Promise<void> {
  if (schemaReady) return;
  const db = getUsersClient();
  if (!db) return;

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id                TEXT PRIMARY KEY,
      tag               TEXT NOT NULL UNIQUE,
      username          TEXT,
      username_lower    TEXT UNIQUE,
      email             TEXT,
      email_lower       TEXT UNIQUE,
      email_verified_at INTEGER,
      password_hash     TEXT,
      anilist_id        INTEGER UNIQUE,
      anilist_name      TEXT,
      avatar_url        TEXT,
      role              TEXT NOT NULL DEFAULT 'user',
      status            TEXT NOT NULL DEFAULT 'active',
      created_at        INTEGER NOT NULL,
      last_seen_at      INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_data (
      user_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      rev        INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at    INTEGER
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS auth_throttle (
      key      TEXT PRIMARY KEY,
      count    INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    )
  `);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_users_anilist ON users(anilist_id)`
  );
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at)`
  );
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_tokens_user ON auth_tokens(user_id, kind)`
  );

  schemaReady = true;
}
