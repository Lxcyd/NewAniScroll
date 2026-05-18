import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { upsertAnime } from "@/lib/db/anime";
import { getTursoClient } from "@/lib/db/turso";

/**
 * Admin-only endpoint that triggers an on-demand AniList re-fetch for a
 * given anime ID and writes the freshly-pulled Tier-1 payload into Turso.
 *
 * POST /api/v2/admin/scrape-anime  { id: number }
 *
 * Returns: { ok: true, anime: { id, title, status, … } } on success,
 *          { error: string } with appropriate HTTP status otherwise.
 */
const ANILIST_QUERY = `
  query ($id: Int!) {
    Media(id: $id, type: ANIME) {
      id idMal status format type season seasonYear
      popularity averageScore isAdult updatedAt
      title { romaji english native userPreferred }
      bannerImage
      coverImage { extraLarge large medium color }
      description(asHtml: false)
      genres tags { id name category isMediaSpoiler }
      studios { nodes { id name isAnimationStudio } }
      relations { edges { relationType node { id title { romaji english } type format coverImage { large } } } }
      episodes duration startDate { year month day } endDate { year month day }
      season seasonYear
      synonyms
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

  const id = Number(req.body?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }

  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { id } }),
    });
    clearTimeout(timeoutId);
    if (!r.ok) {
      return res.status(502).json({ error: `AniList HTTP ${r.status}` });
    }
    const json = await r.json();
    const media = json?.data?.Media;
    if (!media) {
      return res.status(404).json({ error: "AniList returned no Media" });
    }
    await upsertAnime(media);

    // Gather rich preview info for the admin UI: fanart counts by type +
    // a sample of urls so the admin can verify the scrape produced
    // meaningful content. Failures don't break the response — we just
    // omit those fields.
    let fanartCounts: Record<string, number> = {};
    let fanartSamples: { type: string; url: string }[] = [];
    try {
      const db = getTursoClient();
      if (db) {
        const counts = await db.execute({
          sql: `SELECT type, COUNT(*) AS n FROM anime_fanarts WHERE anime_id = ? GROUP BY type`,
          args: [media.id],
        });
        for (const row of counts.rows) {
          fanartCounts[String((row as any).type)] = Number((row as any).n);
        }
        const samples = await db.execute({
          sql: `SELECT type, url FROM anime_fanarts WHERE anime_id = ? ORDER BY likes DESC LIMIT 6`,
          args: [media.id],
        });
        fanartSamples = samples.rows.map((row: any) => ({
          type: String(row.type),
          url: String(row.url),
        }));
      }
    } catch {}

    return res.status(200).json({
      ok: true,
      anime: {
        id: media.id,
        idMal: media.idMal,
        title:
          media.title?.userPreferred ||
          media.title?.english ||
          media.title?.romaji,
        titles: {
          romaji: media.title?.romaji,
          english: media.title?.english,
          native: media.title?.native,
        },
        status: media.status,
        format: media.format,
        type: media.type,
        season: media.season,
        seasonYear: media.seasonYear,
        episodes: media.episodes,
        duration: media.duration,
        popularity: media.popularity,
        averageScore: media.averageScore,
        isAdult: media.isAdult,
        genres: media.genres || [],
        synonyms: media.synonyms || [],
        coverImage:
          media.coverImage?.large || media.coverImage?.medium,
        bannerImage: media.bannerImage,
        studios:
          media.studios?.nodes
            ?.filter((s: any) => s.isAnimationStudio)
            ?.map((s: any) => s.name) || [],
        startDate: media.startDate,
        endDate: media.endDate,
        relations:
          media.relations?.edges?.slice(0, 8).map((e: any) => ({
            type: e.relationType,
            title: e.node?.title?.romaji || e.node?.title?.english,
            format: e.node?.format,
          })) || [],
      },
      fanart: {
        counts: fanartCounts,
        total: Object.values(fanartCounts).reduce((s, v) => s + v, 0),
        samples: fanartSamples,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Scrape failed" });
  }
}
