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

/** La saison d'un instant, en UTC : « 2026-FALL ». */
const seasonAt = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${SEASONS[Math.floor(d.getUTCMonth() / 3)]}`;
};
/** L'écart d'heure le plus grand d'un fuseau réel (UTC−12 … UTC+14). */
const TZ_MS = 14 * 3600_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  /* LA SAISON DU NAVIGATEUR (06/11/2026) : il la calcule à SON heure, le
     serveur en UTC. Le 1er janvier à 0 h 30 à Paris, l'un disait WINTER et
     l'autre FALL : la clé ne collait pas et la grille officielle perdait son
     thème — des heures durant, le CDN gardant la réponse 6 h. La saison
     demandée est servie si un fuseau réel est dedans en ce moment ; pas plus
     loin, sinon une requête en novembre figerait le thème de l'hiver 100 jours. */
  const now = Date.now();
  const asked = String(req.query.key ?? "");
  const key = [seasonAt(now - TZ_MS), seasonAt(now + TZ_MS)].includes(asked) ? asked : seasonAt(now);
  const [year, season] = [Number(key.slice(0, 4)), key.slice(5)];
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
