/**
 * The caller's IP address, from behind Vercel's proxy.
 *
 * This existed three times — lib/watch2gether/rateLimit.ts, /api/v2/track and
 * /api/v2/admin/bug-report — and the copies had drifted apart in a way that
 * mattered. Two of them tested `typeof xff === "string"` without checking the
 * string was non-empty, so an empty `x-forwarded-for` header yielded `""`
 * instead of falling through to the socket address. That is not cosmetic:
 * bug-report gates its per-IP spam throttle on `if (ip)`, so an empty header
 * skipped the throttle entirely, and every such request in the analytics table
 * shared one blank key.
 *
 * One implementation, with the guard, for anything that keys on the caller —
 * rate limits, IP bans, abuse counting, analytics.
 */

import type { NextApiRequest } from "next";

export function getClientIp(req: NextApiRequest): string | null {
  const xff = req.headers["x-forwarded-for"];
  // x-forwarded-for is "client, proxy1, proxy2" — the first entry is the
  // original caller. An empty header is treated as absent, not as an IP.
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length && xff[0]) return xff[0].trim();
  return req.socket?.remoteAddress || null;
}
