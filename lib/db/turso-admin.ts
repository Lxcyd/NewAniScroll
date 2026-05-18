import { createClient, type Client } from "@libsql/client";

/**
 * Singleton libSQL/Turso client for the ADMIN database.
 *
 * Separate from the main anime cache (lib/db/turso.ts) so user/operations
 * data (bans, broadcasts, reports, analytics, audit) lives in its own
 * database. Isolation has two benefits:
 *   - The admin DB can be backed up / restored independently of the
 *     much-larger anime data.
 *   - A misuse of the anime cache (mass-delete, schema migration mishap)
 *     can't touch admin-controlled state.
 *
 * Env vars expected in `.env.local`:
 *   TURSO_ADMIN_URL    = libsql://<your-admin-db>.turso.io
 *   TURSO_ADMIN_TOKEN  = <auth token from the Turso dashboard>
 *
 * Returns null when the env vars are unset — admin features then degrade
 * gracefully (UI shows empty state rather than crashing).
 */

let client: Client | null = null;
let warned = false;

export function getAdminTursoClient(): Client | null {
  if (client) return client;

  const url = process.env.TURSO_ADMIN_URL;
  const authToken = process.env.TURSO_ADMIN_TOKEN;

  if (!url) {
    if (!warned) {
      console.warn(
        "[turso-admin] TURSO_ADMIN_URL not set — admin tools (bans / reports / broadcasts / analytics) are inactive."
      );
      warned = true;
    }
    return null;
  }

  client = createClient({ url, authToken });
  return client;
}

/**
 * Initialise every admin table. Idempotent — safe to call on every cold
 * boot. Centralising the DDL here means each admin endpoint can `await
 * ensureAdminSchema()` once and assume its table exists, instead of each
 * one shipping its own CREATE TABLE statement.
 */
let schemaReady = false;
export async function ensureAdminSchema(): Promise<void> {
  if (schemaReady) return;
  const db = getAdminTursoClient();
  if (!db) return;

  // Each CREATE IF NOT EXISTS in its own execute so a SQLite parser quirk
  // on one statement doesn't abort the whole batch silently.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS banned_ips (
      ip          TEXT PRIMARY KEY,
      reason      TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      created_by  TEXT
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      actor       TEXT NOT NULL,
      action      TEXT NOT NULL,
      target      TEXT,
      detail      TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS bug_reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT,
      url         TEXT,
      description TEXT,
      severity    TEXT,
      reporter    TEXT,
      reporter_ip TEXT,
      images      TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      resolved_at INTEGER
    )
  `);
  // Adds optional columns on legacy DBs. The ALTER fails silently when
  // the column already exists.
  try { await db.execute(`ALTER TABLE bug_reports ADD COLUMN images TEXT`); } catch {}
  try { await db.execute(`ALTER TABLE bug_reports ADD COLUMN reporter_ip TEXT`); } catch {}
  try { await db.execute(`ALTER TABLE bug_reports ADD COLUMN title TEXT`); } catch {}
  await db.execute(`
    CREATE TABLE IF NOT EXISTS broadcast (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      title       TEXT,
      message     TEXT,
      show_flag   INTEGER NOT NULL DEFAULT 0,
      start_at    INTEGER,
      end_at      INTEGER,
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
  // Adds optional columns on legacy admin DBs. The ALTERs are wrapped in
  // try/catch so they don't fail when the column already exists.
  try { await db.execute(`ALTER TABLE broadcast ADD COLUMN end_at INTEGER`); } catch {}
  try { await db.execute(`ALTER TABLE broadcast ADD COLUMN title TEXT`); } catch {}
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_analytics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id  TEXT NOT NULL,
      ip          TEXT,
      user_agent  TEXT,
      path        TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_analytics_visitor
      ON user_analytics(visitor_id)
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_analytics_created
      ON user_analytics(created_at)
  `);

  schemaReady = true;
}

/**
 * Append an audit log entry. Failures are swallowed — admin actions should
 * never be blocked by an audit-write error.
 */
export async function logAuditEvent(
  actor: string,
  action: string,
  target?: string | null,
  detail?: string | null,
): Promise<void> {
  try {
    const db = getAdminTursoClient();
    if (!db) return;
    await ensureAdminSchema();
    await db.execute({
      sql: `INSERT INTO audit_log (actor, action, target, detail)
            VALUES (?, ?, ?, ?)`,
      args: [actor, action, target ?? null, detail ?? null],
    });
  } catch {}
}
