import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { getStaleAnime, upsertAnime } from "@/lib/db/anime";

/**
 * Admin-only bulk refresh of stale anime metadata. Calls AniList for up to
 * `limit` rows whose `expires_at < now`, ordered by `last_accessed_at desc`
 * (user-visible rows first).
 *
 * POST /api/v2/admin/bulk-refresh  { limit?: number }
 *
 * Limit is clamped to 50 to keep individual requests well under serverless
 * timeouts. Larger refreshes should use the cron workflow instead.
 *
 * Returns: { refreshed: number, failed: number, errors: [{id, message}] }
 */
const QUERY = `
  query ($id: Int!) {
    Media(id: $id, type: ANIME) {
      id idMal status format type season seasonYear
      popularity averageScore isAdult updatedAt
      title { romaji english native userPreferred }
      bannerImage
      coverImage { extraLarge large medium color }
      description(asHtml: false)
      genres
    }
  }
`;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const limit = Math.max(1, Math.min(50, Number(req.body?.limit) || 10));
  const stale = await getStaleAnime(limit);

  let refreshed = 0;
  let failed = 0;
  const errors: Array<{ id: number; message: string }> = [];

  for (const { id } of stale) {
    try {
      // 700ms between requests so we stay polite with AniList's rate limit.
      await new Promise((r) => setTimeout(r, 700));
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch("https://graphql.anilist.co", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { id } }),
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      const media = json?.data?.Media;
      if (!media) throw new Error("no Media in response");
      await upsertAnime(media);
      refreshed++;
    } catch (e: any) {
      failed++;
      errors.push({ id, message: e?.message || String(e) });
    }
  }

  res.status(200).json({ refreshed, failed, errors });
}
