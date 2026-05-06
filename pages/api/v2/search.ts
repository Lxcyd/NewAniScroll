import type { NextApiRequest, NextApiResponse } from "next";
import { searchAnime } from "@/lib/db/anime";

/**
 * Local search backed by Turso FTS5.
 *
 * Returns results from our own DB, ordered by popularity. Survives AniList
 * outages because it never touches the network — every hit is a single
 * SQLite FTS5 query.
 *
 * Shape mirrors the subset of AniList Page.media a search UI typically uses:
 *   { results: Media[], total }
 *
 * GET /api/v2/search?q=naruto&limit=20
 *
 * Future improvements (not blocking):
 *   • format / season / year filters (already in DB columns, just need WHEREs)
 *   • merge with AniList live search when available, dedupe by id
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const q = String(req.query.q || "").trim();
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 20;

  if (!q) {
    return res.status(400).json({ error: "Missing query parameter `q`" });
  }

  try {
    const results = await searchAnime(q, limit);
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({
      results,
      total: results.length,
      source: "turso-fts",
    });
  } catch (e: any) {
    console.error("[/api/v2/search] error:", e?.message);
    return res.status(500).json({ error: "Search failed", details: e?.message });
  }
}
