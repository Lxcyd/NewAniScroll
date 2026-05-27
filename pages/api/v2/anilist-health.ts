import type { NextApiRequest, NextApiResponse } from "next";
import { redis } from "@/lib/redis";
import { anilistFetch } from "@/lib/anilist/anilistFetch";

/**
 * GET /api/v2/anilist-health
 *
 * Returns { up: boolean, checkedAt: epoch_ms, message?: string }.
 *
 * Tiny GraphQL ping with a 3s timeout. Result is cached in Redis for
 * 60s so we don't add load to AniList during their outages — many
 * concurrent visitors all hit this endpoint, but only one of them
 * actually round-trips upstream every minute.
 *
 * Without Redis we fall back to an in-process module-scoped cache,
 * which is still better than a fresh check per request.
 */

const CACHE_KEY = "anilist:health";
const CACHE_TTL_S = 60;
const TIMEOUT_MS = 3000;

let memCache: { value: HealthPayload; expiresAt: number } | null = null;

type HealthPayload = {
  up: boolean;
  checkedAt: number;
  message: string | null;
};

async function probe(): Promise<HealthPayload> {
  const checkedAt = Date.now();
  // Routed through the central limiter so a runaway probe loop can't
  // monopolise the AniList budget. Response cache is disabled (we want
  // a fresh read) but the surrounding endpoint cache (60s) is what
  // keeps probe volume low.
  const j = await anilistFetch({
    query: "{ SiteStatistics { users { nodes { date } } } }",
    timeoutMs: TIMEOUT_MS,
    cacheSeconds: 0,
    label: "health",
  });
  if (!j) {
    return { up: false, checkedAt, message: "AniList unreachable" };
  }
  if (j?.errors?.length) {
    return {
      up: false,
      checkedAt,
      message: j.errors[0]?.message || "AniList returned errors",
    };
  }
  return { up: true, checkedAt, message: null };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 1. Redis cache (shared across server instances)
  if (redis) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        // Match the 5-minute client poll interval: every browser hit lands
        // in the edge cache without re-invoking the function. Within the
        // 5-min window we serve from edge; after, one shielded request
        // refreshes Redis + reseeds the edge.
        res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
        return res.status(200).json(JSON.parse(cached));
      }
    } catch {
      /* fall through to memory + live */
    }
  }

  // 2. In-process cache (single-instance fallback)
  if (memCache && memCache.expiresAt > Date.now()) {
    return res.status(200).json(memCache.value);
  }

  // 3. Live probe
  const payload = await probe();
  memCache = { value: payload, expiresAt: Date.now() + CACHE_TTL_S * 1000 };

  if (redis) {
    try {
      await redis.set(CACHE_KEY, JSON.stringify(payload), "EX", CACHE_TTL_S);
    } catch {
      /* non-fatal */
    }
  }

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=600",
  );
  return res.status(200).json(payload);
}
