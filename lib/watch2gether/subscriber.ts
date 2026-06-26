// A dedicated ioredis connection for Pub/Sub `subscribe()`.
//
// Once a connection enters subscriber mode it can no longer run normal
// commands, so we must NOT reuse the shared `redis` client from lib/redis.ts.
// Each SSE request creates its own subscriber and quits it on disconnect.

import { Redis } from "ioredis";

export function createSubscriber(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not configured — Watch2gether is unavailable");
  const sub = new Redis(url, {
    // SSE streams are long-lived; don't let a transient blip kill the process.
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  sub.on("error", (err) => {
    console.error("[w2g subscriber] redis error:", err?.message || err);
  });
  return sub;
}
