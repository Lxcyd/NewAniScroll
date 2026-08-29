/**
 * One-shot tokens for e-mail verification and password reset.
 *
 * The token itself is only ever in the mail; the database stores its sha256.
 * A dump of `auth_tokens` therefore hands nobody a usable link. Consumption
 * is single-use (`used_at`) and expiry-checked in the same statement.
 */

import { createHash, randomBytes, randomInt } from "node:crypto";
import { ensureUsersSchema, getUsersClient } from "../db/turso-users";

export type TokenKind = "verify" | "reset" | "password" | "delete";

/**
 * Verification links can wait a day; a reset link should not; a code typed
 * from an open mailbox needs minutes, not hours.
 */
const TTL_MS: Record<TokenKind, number> = {
  verify: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
  password: 15 * 60 * 1000,
  delete: 15 * 60 * 1000,
};

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function db() {
  const client = getUsersClient();
  if (!client) return null;
  await ensureUsersSchema();
  return client;
}

/** Returns the clear token to put in the mailed link. Never stored as-is. */
export async function issueToken(
  userId: string,
  kind: TokenKind
): Promise<string | null> {
  const client = await db();
  if (!client) return null;

  // A new link invalidates the previous ones of the same kind, so a user who
  // clicks "resend" twice can't be confused by which mail still works.
  await client.execute({
    sql: `DELETE FROM auth_tokens WHERE user_id = ? AND kind = ?`,
    args: [userId, kind],
  });

  const token = randomBytes(32).toString("base64url");
  await client.execute({
    sql: `INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at)
          VALUES (?, ?, ?, ?)`,
    args: [hash(token), userId, kind, Date.now() + TTL_MS[kind]],
  });
  return token;
}

/**
 * Validate and burn a token. Returns the user id, or null when the token is
 * unknown, of the wrong kind, expired or already used — the caller must not
 * distinguish those cases to the visitor.
 */
export async function consumeToken(
  token: string,
  kind: TokenKind
): Promise<string | null> {
  const client = await db();
  if (!client) return null;

  const tokenHash = hash(token);
  const res = await client.execute({
    sql: `SELECT user_id, expires_at, used_at FROM auth_tokens
           WHERE token_hash = ? AND kind = ?`,
    args: [tokenHash, kind],
  });
  const row = res.rows[0];
  if (!row) return null;
  if (row.used_at != null) return null;
  if (Number(row.expires_at) < Date.now()) return null;

  const marked = await client.execute({
    sql: `UPDATE auth_tokens SET used_at = ?
           WHERE token_hash = ? AND used_at IS NULL`,
    args: [Date.now(), tokenHash],
  });
  // Lost the race against a concurrent click on the same link.
  if (marked.rowsAffected === 0) return null;

  return String(row.user_id);
}

/* ------------------------------------------------------------------ */
/* Short codes, for confirming a sensitive change from the mailbox      */
/* ------------------------------------------------------------------ */

/**
 * Six digits are typed by a human, so the stored hash is salted with the user
 * id and the kind: two people can hold the same code without colliding on the
 * primary key, and a stolen `auth_tokens` dump is not a rainbow table of a
 * million possible codes.
 *
 * Six digits is only safe with a strict attempt limit — that lives in the
 * route, which throttles verification per user (see checkThrottle).
 */
function codeHash(userId: string, kind: TokenKind, code: string): string {
  return hash(`${userId}:${kind}:${code}`);
}

export async function issueCode(
  userId: string,
  kind: TokenKind
): Promise<string | null> {
  const client = await db();
  if (!client) return null;

  await client.execute({
    sql: `DELETE FROM auth_tokens WHERE user_id = ? AND kind = ?`,
    args: [userId, kind],
  });

  // randomInt is uniform; `% 1000000` on random bytes would not be.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await client.execute({
    sql: `INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at)
          VALUES (?, ?, ?, ?)`,
    args: [codeHash(userId, kind, code), userId, kind, Date.now() + TTL_MS[kind]],
  });
  return code;
}

/** Same single-use, expiry-checked consumption as a link token. */
export async function consumeCode(
  userId: string,
  kind: TokenKind,
  code: string
): Promise<boolean> {
  const client = await db();
  if (!client) return false;

  const tokenHash = codeHash(userId, kind, code.trim());
  const res = await client.execute({
    sql: `SELECT expires_at, used_at FROM auth_tokens
           WHERE token_hash = ? AND user_id = ? AND kind = ?`,
    args: [tokenHash, userId, kind],
  });
  const row = res.rows[0];
  if (!row || row.used_at != null) return false;
  if (Number(row.expires_at) < Date.now()) return false;

  const marked = await client.execute({
    sql: `UPDATE auth_tokens SET used_at = ?
           WHERE token_hash = ? AND used_at IS NULL`,
    args: [Date.now(), tokenHash],
  });
  return marked.rowsAffected > 0;
}

/** Housekeeping: drop spent and expired rows. Called opportunistically. */
export async function pruneTokens(): Promise<void> {
  try {
    const client = await db();
    if (!client) return;
    await client.execute({
      sql: `DELETE FROM auth_tokens WHERE expires_at < ? OR used_at IS NOT NULL`,
      args: [Date.now() - 24 * 60 * 60 * 1000],
    });
  } catch {}
}
