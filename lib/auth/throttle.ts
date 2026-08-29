/**
 * Fixed-window rate limiting for the auth routes, stored in Turso.
 *
 * Deliberately NOT in Upstash: the free tier (~500k commands/month) is
 * already the site's tightest budget (see the Upstash cap note in ops), and
 * login attempts are exactly the kind of unbounded traffic that would eat it.
 * Turso's row writes are cheap by comparison and the accuracy of a fixed
 * window is plenty for "slow down a password guesser".
 */

import { ensureUsersSchema, getUsersClient } from "../db/turso-users";
import type { NextApiRequest } from "next";

export type ThrottleResult = { ok: boolean; retryAfterMs: number };

/**
 * Count one attempt against `key`. Returns ok:false once `max` is reached
 * inside the window. When the DB is unavailable the call fails OPEN — an
 * accounts feature that can't reach its database is already broken, and
 * locking everyone out on top of it helps nobody.
 */
export async function checkThrottle(
  key: string,
  max: number,
  windowMs: number
): Promise<ThrottleResult> {
  const client = getUsersClient();
  if (!client) return { ok: true, retryAfterMs: 0 };

  try {
    await ensureUsersSchema();
    const now = Date.now();

    const res = await client.execute({
      sql: `SELECT count, reset_at FROM auth_throttle WHERE key = ?`,
      args: [key],
    });
    const row = res.rows[0];

    if (!row || Number(row.reset_at) <= now) {
      await client.execute({
        sql: `INSERT INTO auth_throttle (key, count, reset_at) VALUES (?, 1, ?)
              ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
        args: [key, now + windowMs],
      });
      return { ok: true, retryAfterMs: 0 };
    }

    const count = Number(row.count);
    if (count >= max) {
      return { ok: false, retryAfterMs: Number(row.reset_at) - now };
    }

    await client.execute({
      sql: `UPDATE auth_throttle SET count = count + 1 WHERE key = ?`,
      args: [key],
    });
    return { ok: true, retryAfterMs: 0 };
  } catch {
    return { ok: true, retryAfterMs: 0 };
  }
}

/** Clear a counter after a success, so a good login resets the budget. */
export async function resetThrottle(key: string): Promise<void> {
  try {
    const client = getUsersClient();
    if (!client) return;
    await client.execute({ sql: `DELETE FROM auth_throttle WHERE key = ?`, args: [key] });
  } catch {}
}

/**
 * Caller IP as seen through Vercel's proxy. x-forwarded-for is a list; the
 * first entry is the client. Falls back to a constant so a missing header
 * throttles globally rather than not at all.
 */
export function clientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = raw?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
  return ip || "unknown";
}
