import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { searchAnime } from "@/lib/db/anime";

/**
 * Admin-only Turso anime search. Wraps `searchAnime()` (FTS5) for the
 * metadata editor UI.
 *
 * GET /api/v2/admin/search-anime?q=...&limit=20
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) return res.status(403).json({ error: "Forbidden" });

  const q = String(req.query.q || "").trim();
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
  if (!q) return res.status(200).json({ results: [] });

  const results = await searchAnime(q, limit);
  res.status(200).json({
    results: results.map((m: any) => ({
      id: m.id,
      title: m.title?.romaji || m.title?.english || `#${m.id}`,
      english: m.title?.english,
      coverImage: m.coverImage?.medium || m.coverImage?.large,
      status: m.status,
      popularity: m.popularity,
      averageScore: m.averageScore,
    })),
  });
}
