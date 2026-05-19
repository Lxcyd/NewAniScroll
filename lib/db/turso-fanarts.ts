import { createClient, type Client } from "@libsql/client";
import { getTursoClient } from "./turso";

/**
 * Singleton libSQL/Turso client for the fanarts database.
 *
 * Rationale for a separate DB:
 *   - Anime metadata (table `anime`, `anime_fts`) is small per-row but
 *     the table is huge (~17k rows) and many cron jobs full-scan it.
 *   - Fanarts (`anime_fanarts`) is even bigger (~120k+ rows) and most
 *     reads are simple `WHERE anime_id = ?` lookups, but the NSFW
 *     classification cron does heavy GROUP BY scans.
 *
 * Sharing one DB meant heavy fanart work (classify cron, admin
 * dashboard counts) contended with hot anime reads on the same Turso
 * instance — and shared the same free-tier row-read budget.
 *
 * With a second DB:
 *   - Each DB has its own row-read quota on the free tier.
 *   - Anime reads (the hot path: every page render) are isolated from
 *     fanart maintenance traffic.
 *   - We can scale them independently (e.g. fanarts DB can stay free
 *     while anime DB upgrades to paid, or vice-versa).
 *
 * Env precedence:
 *   - TURSO_FANARTS_DATABASE_URL / TURSO_FANARTS_AUTH_TOKEN: dedicated
 *     fanarts DB (use this once you've created the separate Turso db).
 *   - Falls back to the main TURSO_DATABASE_URL so deployments without
 *     the split still work — anime_fanarts will just live on the main
 *     DB as before.
 */

let client: Client | null = null;
let warned = false;

export function getFanartsClient(): Client | null {
  if (client) return client;

  const url = process.env.TURSO_FANARTS_DATABASE_URL;
  const authToken = process.env.TURSO_FANARTS_AUTH_TOKEN;

  if (!url) {
    // No dedicated fanarts DB configured — fall back to the main one.
    // Callers see the same Client interface and don't need to branch.
    if (!warned) {
      console.warn(
        "[turso-fanarts] TURSO_FANARTS_DATABASE_URL not set — using main DB for fanarts."
      );
      warned = true;
    }
    return getTursoClient();
  }

  client = createClient({ url, authToken });
  return client;
}
