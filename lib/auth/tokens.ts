/**
 * One-shot tokens for e-mail verification and password reset.
 *
 * The token itself is only ever in the mail; the database stores its sha256.
 * A dump of `auth_tokens` therefore hands nobody a usable link. Consumption
 * is single-use (`used_at`) and expiry-checked in the same statement.
 */

import { createHash, randomBytes } from "node:crypto";
import { ensureUsersSchema, getUsersClient } from "../db/turso-users";

export type TokenKind = "verify" | "reset";

/** Verification links can wait a day; a reset link should not. */
const TTL_MS: Record<TokenKind, number> = {
  verify: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
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
