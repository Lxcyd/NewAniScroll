#!/usr/bin/env node
/**
 * Find the sweet spot for concurrency. fanart.tv rate-limits aggressive
 * parallel fetches; we want the highest concurrency level where we still
 * see ~0% network errors.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import sharp from "sharp";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, kind: "http", code: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    await sharp(buf).resize(448, 448, { fit: "contain" }).removeAlpha().raw().toBuffer();
    return { ok: true };
  } catch (e) {
    return { ok: false, kind: e.name === "AbortError" ? "timeout" : "net" };
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency(urls, n) {
  const stats = { ok: 0, http: 0, net: 0, timeout: 0 };
  const queue = [...urls];
  const t0 = Date.now();
  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      const r = await probe(url);
      if (r.ok) stats.ok++;
      else if (r.kind === "http") stats.http++;
      else if (r.kind === "timeout") stats.timeout++;
      else stats.net++;
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
  const dt = (Date.now() - t0) / 1000;
  return { stats, dt, rate: urls.length / dt };
}

// Pick 100 URLs at random
const r = await db.execute({
  sql: `SELECT url FROM anime_fanarts
         WHERE nsfw_label IS NULL AND type NOT IN ('logo','disc')
         GROUP BY url ORDER BY RANDOM() LIMIT 100`,
  args: [],
});
const urls = r.rows.map(row => String(row.url));
console.log(`→ Testing on ${urls.length} URLs at multiple concurrency levels\n`);

for (const n of [1, 2, 4, 6, 8]) {
  // Each level uses fresh URLs to avoid CDN caching biasing the result.
  // We only have 100 URLs total though, so we just shuffle and reuse.
  const shuffled = [...urls].sort(() => Math.random() - 0.5);
  const r = await runWithConcurrency(shuffled, n);
  console.log(`  N=${n}: ok=${r.stats.ok}/100 http=${r.stats.http} timeout=${r.stats.timeout} net=${r.stats.net} | ${r.rate.toFixed(2)} URL/s | ${r.dt.toFixed(1)}s`);
}
