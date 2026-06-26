// Per-IP rate limiting for Watch2gether routes.
//
// Why per-IP and not per-user: a guest's identity (`guestId`) is fully
// client-supplied, so a user-keyed limiter is trivially bypassed by rotating the
// id. The client IP is the only attacker-stable key we have, so the limiters
// that defend against abuse (brute-forcing the 4-digit room space via /join,
// spamming /create) MUST key on it.

import type { NextApiRequest } from "next";
import { rateLimiterRedis, rateLimitStrict, rateSuperStrict } from "@/lib/redis";

/** First hop in X-Forwarded-For (the real client on Vercel), else the socket. */
export function getClientIp(req: NextApiRequest): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length) return xff[0];
  return req.socket?.remoteAddress || "unknown";
}

type Tier = "normal" | "strict" | "superstrict";

/** Consume one point from the chosen limiter, keyed by IP + a route tag.
 *  Returns true when the request is ALLOWED, false when it must be 429'd.
 *  Fails OPEN if Redis / the limiter isn't configured (never blocks the feature
 *  on infra hiccups). */
export async function allowByIp(
  req: NextApiRequest,
  tag: string,
  tier: Tier = "strict",
): Promise<boolean> {
  const limiter =
    tier === "superstrict" ? rateSuperStrict : tier === "normal" ? rateLimiterRedis : rateLimitStrict;
  if (!limiter) return true;
  const key = `w2g:ip:${tag}:${getClientIp(req)}`;
  try {
    await limiter.consume(key);
    return true;
  } catch {
    return false;
  }
}
