// Minimal env loader + Upstash REST credential resolver for the usage monitor.
// No dependencies — reads .env.local the same way the app resolves Redis, so the
// tool works with whatever the project already has configured (just REDIS_URL is
// enough; UPSTASH_REDIS_REST_URL/_TOKEN override it if present).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tools/usage-monitor/lib -> repo root
export const REPO_ROOT = join(__dirname, "..", "..", "..");

/**
 * Load KEY=VALUE lines from a dotenv file into process.env WITHOUT overwriting
 * anything already set (so CI secrets win over a stray local file). Quotes are
 * stripped; `#` comment lines and blanks are ignored. Deliberately tiny — we
 * don't want a dependency just to read a handful of keys.
 */
export function loadDotEnv(file = join(REPO_ROOT, ".env.local")) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

/**
 * Parse a `rediss://default:<token>@<host>:<port>` URL into an Upstash REST
 * { url, token }. Mirrors lib/redisRest.ts deriveRest() so the tool sees exactly
 * the same DB the app talks to. Returns null on a malformed URL.
 */
function deriveRest(redisUrl) {
  try {
    const u = new URL(redisUrl);
    const token = decodeURIComponent(u.password || "");
    if (!u.hostname || !token) return null;
    return { url: `https://${u.hostname}`, token };
  } catch {
    return null;
  }
}

/** Resolve the Upstash REST config the same way the app does. */
export function resolveRestConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url: url.replace(/\/$/, ""), token };
  if (process.env.REDIS_URL) return deriveRest(process.env.REDIS_URL);
  return null;
}

/** Upstash management API creds (optional — enables the daily-requests chart). */
export function resolveMgmtConfig() {
  const email = process.env.UPSTASH_EMAIL;
  const apiKey = process.env.UPSTASH_API_KEY;
  const dbId = process.env.UPSTASH_DATABASE_ID || null; // optional; auto-discovered otherwise
  if (email && apiKey) return { email, apiKey, dbId };
  return null;
}

/** Vercel API creds (optional — enables deployment correlation). */
export function resolveVercelConfig() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return null;
  return {
    token,
    projectId: process.env.VERCEL_PROJECT_ID || "aniscroll",
    teamId: process.env.VERCEL_TEAM_ID || null,
  };
}
