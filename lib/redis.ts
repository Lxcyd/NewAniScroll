import { Redis } from "ioredis";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { createRestRedis, type IoRedisish } from "./redisRest";

const REDIS_URL: string | undefined = process.env.REDIS_URL;

// CACHING CLIENT — Upstash REST over HTTPS (port 443). The native Redis
// protocol (port 6379) is blocked outbound from our network and the Vercel
// runtime, so ioredis got `connect ETIMEDOUT` on every command and all caching
// / single-flight locking silently failed. The REST shim (lib/redisRest.ts)
// exposes the same method surface, so call-sites are unchanged.
//
// Typed as the non-null IoRedisish (like the previous `let redis: Redis`) so
// the many existing `if (redis)` runtime guards keep compiling unchanged; the
// value is genuinely undefined only when unconfigured, and every caller already
// guards on it at runtime. The cast preserves that historical contract.
let redis = createRestRedis() as IoRedisish;

let rateLimiterRedis: RateLimiterRedis;
let rateLimitStrict: RateLimiterRedis;
let rateSuperStrict: RateLimiterRedis;

if (REDIS_URL) {
  // RATE-LIMITER — rate-limiter-flexible needs a NATIVE ioredis storeClient
  // (it issues Lua/EVALSHA the REST client can't run), so it keeps its own
  // ioredis connection. Fail-fast options so a blocked 6379 errors in ~2 s
  // instead of hanging ~90 s. When this store is unreachable, callers now FAIL
  // OPEN (see pages/api/v2/source: only 429 on a real quota hit, not on a
  // limiter-store error) rather than 429-ing every request.
  const limiterClient = new Redis(REDIS_URL, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  });
  limiterClient.on("error", (err: Error) => {
    console.error("Redis (rate-limiter) error: ", err);
  });

  rateLimiterRedis = new RateLimiterRedis({
    storeClient: limiterClient,
    keyPrefix: "rateLimit",
    points: 50,
    duration: 1,
  });
  rateLimitStrict = new RateLimiterRedis({
    storeClient: limiterClient,
    keyPrefix: "rateLimitStrict",
    points: 20,
    duration: 1,
  });
  rateSuperStrict = new RateLimiterRedis({
    storeClient: limiterClient,
    keyPrefix: "rateLimitSuperStrict",
    points: 3,
    duration: 10 * 60,
    blockDuration: 10 * 60,
  });
} else {
  console.warn("REDIS_URL is not defined. Redis caching will be disabled.");
}

export { redis, rateLimiterRedis, rateLimitStrict, rateSuperStrict };
