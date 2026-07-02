import { Redis } from "ioredis";
import { RateLimiterRedis } from "rate-limiter-flexible";

const REDIS_URL: string | undefined = process.env.REDIS_URL;

let redis: Redis;
let rateLimiterRedis: RateLimiterRedis;
let rateLimitStrict: RateLimiterRedis;
let rateSuperStrict: RateLimiterRedis;

if (REDIS_URL) {
  // Fail-fast options. Defaults let a slow/unreachable Redis (Upstash) hang a
  // request for the OS connect timeout (~90 s) — every cache read stalled the
  // whole handler. With these, a dead Redis errors in ~2 s and callers fall
  // through to their non-Redis path instead of blocking:
  //   • connectTimeout: cap the TCP/TLS connect attempt.
  //   • maxRetriesPerRequest: don't retry a command forever when offline.
  //   • enableOfflineQueue:false — reject commands immediately while
  //     disconnected rather than queueing them until a (maybe-never) reconnect.
  //   • retryStrategy: bounded backoff so we still recover when Redis returns.
  redis = new Redis(REDIS_URL, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  });
  redis.on("error", (err: Error) => {
    console.error("Redis error: ", err);
  });

  const opt = {
    storeClient: redis,
    keyPrefix: "rateLimit",
    points: 50,
    duration: 1,
  };

  const optStrict = {
    storeClient: redis,
    keyPrefix: "rateLimitStrict",
    points: 20,
    duration: 1,
  };

  const optSuperStrict = {
    storeClient: redis,
    keyPrefix: "rateLimitSuperStrict",
    points: 3,
    // duration 10 minutes
    duration: 10 * 60,
    blockDuration: 10 * 60,
  };

  rateLimiterRedis = new RateLimiterRedis(opt);
  rateLimitStrict = new RateLimiterRedis(optStrict);
  rateSuperStrict = new RateLimiterRedis(optSuperStrict);
} else {
  console.warn("REDIS_URL is not defined. Redis caching will be disabled.");
}

export { redis, rateLimiterRedis, rateLimitStrict, rateSuperStrict };
