import type { NextApiRequest, NextApiResponse } from "next";
import { countAnimeCharacters } from "@/lib/db/animeCharacters";

/**
 * GET /api/v2/character-counts?ids=<id>,<id>,…  ->  { counts: { [id]: n } }
 *
 * Combien de personnages AVEC IMAGE chaque anime d'une liste propose, pour le
 * sous-titre des lignes du menu Avatar du studio (24/10/2026). Le pendant
 * d'art-counts : UNE requête SQL pour 200 animes (~400 lignes Turso), lue dans
 * `anime_characters` (scripts/cache/refresh-characters.mjs). Un anime pas
 * encore relevé est absent : le studio le compte en le chargeant.
 *
 * Ids triés et bornés : la même liste retombe sur la même clé d'edge.
 */
const MAX = 200;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ids = [
    ...new Set(
      String(req.query.ids || "")
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, MAX);
  if (!ids.length) return res.status(400).json({ error: "Missing `ids`" });

  const counts = await countAnimeCharacters(ids);

  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("CDN-Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
  return res.status(200).json({ counts });
}
