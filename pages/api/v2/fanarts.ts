import type { NextApiRequest, NextApiResponse } from "next";
import { getTursoClient } from "@/lib/db/turso";

/**
 * GET /api/v2/fanarts?anime=<anilist_id>[&include_nsfw=1][&min_likes=N]
 *
 * Returns fanarts grouped by type, with NSFW labels intact so the client
 * can decide what to render. Errors (`error-perm`) are filtered out.
 *
 * By default `include_nsfw=0` → only `safe` and `safe-skipped` are returned.
 * Set `include_nsfw=1` to also include `suggestive` and `nsfw` (UI toggle).
 *
 * Shape:
 *   {
 *     animeId: 151807,
 *     types: {
 *       background: [{ url, language, likes, season, label }, …],
 *       poster:     [...],
 *       …
 *     }
 *   }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const animeId = Number(req.query.anime);
  if (!Number.isFinite(animeId)) {
    return res.status(400).json({ error: "Missing or invalid `anime` query parameter" });
  }

  const includeNsfw = req.query.include_nsfw === "1" || req.query.include_nsfw === "true";
  const minLikesRaw = Number(req.query.min_likes);
  const minLikes = Number.isFinite(minLikesRaw) && minLikesRaw >= 0 ? minLikesRaw : 0;

  const db = getTursoClient();
  if (!db) return res.status(503).json({ error: "DB unavailable" });

  // Whitelist of acceptable labels. We support manual overrides (manual-safe,
  // manual-suggestive, …) so admin reviews take precedence over the IA.
  // error-perm and manual-error are always excluded.
  // Unclassified rows (label IS NULL) are also excluded — we never want to
  // serve images we haven't checked.
  const labels = includeNsfw
    ? [
        "safe", "safe-skipped",
        "suggestive", "nsfw",
        "manual-safe", "manual-suggestive", "manual-nsfw", "manual-explicit",
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

    // Group by type. Inside each type, the SELECT already orders by likes desc.
    const types: Record<string, any[]> = {};
    for (const row of r.rows) {
      const t = String(row.type);
      if (!types[t]) types[t] = [];
      types[t].push({
        url:      row.url,
        language: row.language,
        likes:    Number(row.likes ?? 0),
        season:   row.season != null ? Number(row.season) : null,
        label:    row.nsfw_label,
        nsfwScore: row.nsfw_score != null ? Number(row.nsfw_score) : null,
      });
    }

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({
      animeId,
      includeNsfw,
      total: r.rows.length,
      types,
    });
  } catch (e: any) {
    console.error("[/api/v2/fanarts] error:", e?.message);
    return res.status(500).json({ error: "Failed to fetch fanarts", details: e?.message });
  }
}
