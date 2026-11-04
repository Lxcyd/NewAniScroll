import type { NextApiRequest, NextApiResponse } from "next";
import { redis } from "@/lib/redis";
import { anilistFetch } from "@/lib/anilist/anilistFetch";
import { setEdgeCache } from "@/lib/http/edgeCache";

/**
 * GET /api/v2/bingo-season
 *
 * Le thème du BINGO DE LA SAISON (04/11/2026, Luc : « en rapport avec les
 * anime de la saison ») : les genres les plus présents parmi les animes de la
 * saison, et ses deux titres les plus populaires. Le client en tire la grille
 * officielle, la même pour tout le monde (components/profile/widgets/ExtraBlocks.tsx).
 *
 * FIGÉ POUR LA SAISON : la première réponse est rangée dans Redis jusqu'à la
 * fin de la saison. Sans ça la popularité, qui bouge chaque jour, changerait la
 * grille officielle en cours de route — et deux visiteurs n'auraient pas le
 * même bingo « officiel ». Une requête AniList par saison, puis le CDN.
 */

const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"] as const;
/** Une saison dure trois mois ; un peu plus, pour ne pas expirer en route. */
const KEEP_S = 100 * 24 * 3600;
const EDGE_S = 6 * 3600;

const QUERY = `
  query BingoSeason($season: MediaSeason, $year: Int) {
    Page(page: 1, perPage: 50) {
      media(type: ANIME, season: $season, seasonYear: $year, sort: [POPULARITY_DESC], isAdult: false) {
        id
        title { romaji english }
        genres
      }
    }
  }
`;

type Media = { id: number; title: { romaji?: string | null; english?: string | null }; genres?: string[] };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const season = SEASONS[Math.floor(now.getUTCMonth() / 3)];
  const key = `${year}-${season}`;
  const cacheKey = `bingo-season:v1:${key}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        setEdgeCache(res, EDGE_S);
        return res.status(200).json(JSON.parse(cached));
      }
    } catch {
      /* on recalcule */
    }
  }

  const json = await anilistFetch({
    query: QUERY,
    variables: { season, year },
    label: "bingo-season",
    cacheSuccess: false,
  });
  const media: Media[] = json?.data?.Page?.media || [];
  if (!media.length) return res.status(502).json({ error: "anilist" });

  /* Les genres présents sur au moins trois titres, du plus fréquent au moins
     fréquent : « une romance de la saison » n'a de sens que s'il y en a. */
  const count = new Map<string, number>();
  for (const m of media) for (const g of m.genres ?? []) count.set(g, (count.get(g) ?? 0) + 1);
  const genres = Array.from(count)
    .filter(([g, n]) => n >= 3 && g !== "Hentai" && g !== "Ecchi")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g]) => g);
  const top = media.slice(0, 2).map((m) => ({ id: m.id, title: m.title.english || m.title.romaji || "" }));
  const payload = { key, genres, top };

  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(payload), "EX", KEEP_S);
    } catch {
      /* non bloquant */
    }
  }
  setEdgeCache(res, EDGE_S);
  return res.status(200).json(payload);
}
