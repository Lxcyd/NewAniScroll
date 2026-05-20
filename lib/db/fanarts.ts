import { getFanartsClient } from "@/lib/db/turso-fanarts";

/* Cloudflare Worker proxy in front of fanart.tv. Cached 1 year on
   330+ edges -> first paint of clearart/banner/cover is ~50ms worldwide
   instead of 800ms+ from fanart.tv's single origin. Set FANART_PROXY_HOST
   to disable (empty string) or swap host without code change. */
const FANART_PROXY_HOST =
  process.env.FANART_PROXY_HOST ?? "fanart-proxy.aniscroll.com";

function rewriteFanartUrl(url: string): string {
  if (!FANART_PROXY_HOST) return url;
  return url.replace(
    /^https?:\/\/assets\.fanart\.tv/i,
    `https://${FANART_PROXY_HOST}`
  );
}

export type FanartRow = {
  url: string;
  language: string | null;
  likes: number;
  season: number | null;
  label: string;
  nsfwScore: number | null;
};

export type FanartPayload = {
  animeId: number;
  includeNsfw: boolean;
  total: number;
  types: Record<string, FanartRow[]>;
};

/* Direct DB read used by SSR (pages/en/anime/[...id].tsx) to ship fanarts
   inline with the first HTML response. The /api/v2/fanarts HTTP endpoint
   wraps the same query for client-side consumers. Keeping the SQL in one
   place avoids a behavioral drift between the two call sites. */
export async function loadFanarts(
  animeId: number,
  opts: { includeNsfw?: boolean; minLikes?: number } = {}
): Promise<FanartPayload | null> {
  const db = getFanartsClient();
  if (!db) return null;

  const includeNsfw = !!opts.includeNsfw;
  const minLikes = Math.max(0, opts.minLikes ?? 0);
  const labels = includeNsfw
    ? [
        "safe",
        "safe-skipped",
        "suggestive",
        "nsfw",
        "manual-safe",
        "manual-suggestive",
        "manual-nsfw",
        "manual-explicit",
      ]
    : ["safe", "safe-skipped", "manual-safe"];
  const placeholders = labels.map(() => "?").join(",");

  try {
    const r = await db.execute({
      sql: `SELECT type, url, language, likes, season, nsfw_label, nsfw_score
              FROM anime_fanarts
             WHERE anime_id = ?
               AND nsfw_label IN (${placeholders})
               AND likes >= ?
             ORDER BY type, likes DESC`,
      args: [animeId, ...labels, minLikes],
    });

    const types: Record<string, FanartRow[]> = {};
    for (const row of r.rows) {
      const t = String(row.type);
      if (!types[t]) types[t] = [];
      types[t].push({
        url: rewriteFanartUrl(String(row.url)),
        language: row.language != null ? String(row.language) : null,
        likes: Number(row.likes ?? 0),
        season: row.season != null ? Number(row.season) : null,
        label: String(row.nsfw_label),
        nsfwScore: row.nsfw_score != null ? Number(row.nsfw_score) : null,
      });
    }

    return {
      animeId,
      includeNsfw,
      total: r.rows.length,
      types,
    };
  } catch (e: any) {
    console.warn(`[loadFanarts] failed for ${animeId}:`, e?.message);
    return null;
  }
}
