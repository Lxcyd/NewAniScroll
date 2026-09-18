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
  // GET `?p=<JSON>` : les memes arguments que le corps du POST, mais dans l'URL,
  // donc cachables au bord — le s-maxage ci-dessous ne servait a rien sur un
  // POST. Le client construit toujours l'objet dans le meme ordre de cles, donc
  // une meme recherche donne une meme URL.
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "GET or POST only" });
  }

  try {
    let body: any = req.body || {};
    if (req.method === "GET") {
      try {
        body = JSON.parse(typeof req.query.p === "string" ? req.query.p : "{}") || {};
      } catch {
        return res.status(400).json({ error: "bad p" });
      }
    }
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
