#!/usr/bin/env node
/**
 * Quick diagnostic: try to fetch + decode 50 random fanart URLs and see
 * what kinds of failures we hit. The 62% transient error rate from the
 * first classifier batch is suspicious — might be:
 *   - rate-limited by fanart.tv CDN under 8 concurrent connections
 *   - DNS / network glitches
 *   - sharp choking on certain images
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import sharp from "sharp";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const r = await db.execute({
  sql: `SELECT url FROM anime_fanarts
         WHERE nsfw_label IS NULL AND type NOT IN ('logo','disc')
         GROUP BY url ORDER BY RANDOM() LIMIT 50`,
  args: [],
});
console.log(`→ Probing ${r.rows.length} URLs (sequential)…\n`);

const stats = { ok: 0, http: 0, network: 0, decode: 0, timeout: 0 };
const t0 = Date.now();

for (const row of r.rows) {
  const url = String(row.url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const t1 = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      stats.http++;
      console.log(`  HTTP ${res.status}  ${url.slice(-50)}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    try {
      await sharp(buf).resize(448, 448, { fit: "contain" }).removeAlpha().raw().toBuffer();
      stats.ok++;
      const dt = Date.now() - t1;
      if (dt > 3000) console.log(`  OK SLOW (${dt}ms)  ${url.slice(-50)}`);
    } catch (e) {
      stats.decode++;
      console.log(`  DECODE  ${e.message.slice(0, 50)}  ${url.slice(-50)}`);
    }
  } catch (e) {
    if (e.name === "AbortError") stats.timeout++;
    else stats.network++;
    console.log(`  ${e.name === "AbortError" ? "TIMEOUT" : "NET"} ${e.message?.slice(0, 50) || ""}  ${url.slice(-50)}`);
  } finally {
    clearTimeout(timer);
  }
}

const dt = (Date.now() - t0) / 1000;
console.log(`\nTotal: ${dt.toFixed(1)}s | ${(stats.ok / r.rows.length / dt * r.rows.length).toFixed(2)} URL/s on success`);
console.log(`  OK:      ${stats.ok}`);
console.log(`  HTTP:    ${stats.http}`);
console.log(`  Network: ${stats.network}`);
console.log(`  Timeout: ${stats.timeout}`);
console.log(`  Decode:  ${stats.decode}`);
