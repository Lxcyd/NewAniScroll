import type { NextApiRequest, NextApiResponse } from "next";
import { aniAdvanceSearch } from "@/lib/anilist/aniAdvanceSearch";

/**
 * Server-side wrapper around `aniAdvanceSearch` so the search page can
 * call it from the browser without pulling the ioredis-backed AniList
 * limiter into the client bundle (which would fail webpack with
 * "Module not found: Can't resolve 'dns'").
 *
 * Body: same shape as `aniAdvanceSearch`'s argument, serialised as JSON.
 * Returns: AniList `Page` shape (pageInfo + media), or null on failure.
 *
 * The actual fetch goes through the global anilistFetch limiter (which
 * dedups, caches in Redis for 30s, and respects the 28 req/min budget).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  try {
    const body = req.body || {};
    const page = await aniAdvanceSearch({
      search: body.search,
      type: body.type,
      genres: body.genres,
      page: body.page,
      sort: body.sort,
      format: body.format,
      season: body.season,
      seasonYear: body.seasonYear,
      perPage: body.perPage,
    });
    // Short SWR header — the response cache inside anilistFetch already
    // dedups within a 30s window, but this lets edge CDNs piggyback.
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json(page);
  } catch (e: any) {
    console.error("[/api/v2/anilist-search] error:", e?.message);
    return res.status(500).json({ error: e?.message });
  }
}
