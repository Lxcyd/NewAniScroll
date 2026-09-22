import { redis } from "@/lib/redis";

/**
 * Shared accessor for the AniList health signal produced by
 * /api/v2/anilist-health. Other server-side modules read this to decide
 * whether to hit AniList first (UP) or fall back to the DB (DOWN).
 *
 * Both layers (Redis + process memory) mirror the same payload so this
 * stays cheap even if Redis is unavailable. We never *trigger* a probe
 * here — only the API route does — to avoid amplification.
 */

export type HealthPayload = {
  up: boolean;
  checkedAt: number;
  message: string | null;
};

const REDIS_KEY = "anilist:health";
const MEM_TTL_MS = 30_000;

// `value: null` is memoised too: the key only lives 60 s in Redis while the
// route that writes it is edge-cached 300 s, so it is ABSENT most of the time,
// and an unmemoised miss cost a Redis GET on every call (up to two per request
// via getMediaMeta + anilistFetch). Null already means "assume up".
let memCache: { value: HealthPayload | null; expiresAt: number } | null = null;

/**
 * Best-effort read of AniList health. Returns `null` when we have no
 * fresh signal at all — callers should treat that as "unknown" (default
 * to AniList-first since the health probe writes a row every minute,
 * so an absent signal usually means cold start).
 */
export async function getAnilistHealth(): Promise<HealthPayload | null> {
  if (memCache && memCache.expiresAt > Date.now()) return memCache.value;
  if (!redis) return null;
  try {
    const raw = await redis.get(REDIS_KEY);
    const value = raw ? (JSON.parse(raw) as HealthPayload) : null;
    memCache = { value, expiresAt: Date.now() + MEM_TTL_MS };
    return value;
  } catch {
    return null;
  }
}

/** Cheap "should I try AniList first?" check. Defaults to true on unknown. */
export async function isAnilistLikelyUp(): Promise<boolean> {
  const h = await getAnilistHealth();
  if (!h) return true;
  return h.up;
}
