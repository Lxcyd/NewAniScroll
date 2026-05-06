import { createClient, type Client } from "@libsql/client";

/**
 * Singleton libSQL/Turso client.
 *
 * Created lazily so importing this module from a context that doesn't actually
 * use the DB (e.g. a tooling script) doesn't error if env vars are missing.
 *
 * Returns null when TURSO_DATABASE_URL is unset — callers should fall back to
 * direct AniList fetches. This keeps the cache layer optional.
 */

let client: Client | null = null;
let warned = false;

export function getTursoClient(): Client | null {
  if (client) return client;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    if (!warned) {
      console.warn(
        "[turso] TURSO_DATABASE_URL not set — persistent anime cache disabled."
      );
      warned = true;
    }
    return null;
  }

  client = createClient({ url, authToken });
  return client;
}
