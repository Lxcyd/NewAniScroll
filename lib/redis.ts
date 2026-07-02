import { RateLimiterMemory } from "rate-limiter-flexible";
import { createRestRedis, type IoRedisish } from "./redisRest";

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

// RATE-LIMITERS — IN-PROCESS. These were RateLimiterRedis on a dedicated
// ioredis client, but with port 6379 blocked that client could NEVER connect:
// every consume() burned a 2 s connect timeout, then rejected with a plain
// Error that endpoints treated as "over quota" → blanket 429s on /episode,
// /etc/recent, w2g… (and an ETIMEDOUT log storm). rate-limiter-flexible can't
// run its Lua/EVALSHA over the REST shim, so the fleet-shared store is not an
// option — memory limiters are: instantaneous, always available, and they only
// reject with a genuine RateLimiterRes when a caller is actually over quota.
// The budget below is per-lambda rather than fleet-wide, which is acceptable:
// the limiters exist to stop a single client hammering, and keying by IP within
// one warm lambda still does that.
const rateLimiterRedis = new RateLimiterMemory({
  keyPrefix: "rateLimit",
  points: 50,
  duration: 1,
});
const rateLimitStrict = new RateLimiterMemory({
  keyPrefix: "rateLimitStrict",
  points: 20,
  duration: 1,
});
const rateSuperStrict = new RateLimiterMemory({
  keyPrefix: "rateLimitSuperStrict",
  points: 3,
  duration: 10 * 60,
  blockDuration: 10 * 60,
});

export { redis, rateLimiterRedis, rateLimitStrict, rateSuperStrict };
