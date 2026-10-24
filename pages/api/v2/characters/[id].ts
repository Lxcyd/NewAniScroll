import type { NextApiRequest, NextApiResponse } from "next";
import { getMediaMeta } from "@/lib/anilist/getMediaMeta";
import { getAnimeCharacters } from "@/lib/db/animeCharacters";

/**
 * GET /api/v2/characters/[id]  ->  { characters: { edges: [...] } | null, total?, complete? }
 *
 * Serves the Characters tab of the anime info page, and the Avatar menu of the
 * profile studio.
 *
 * TOUS LES PERSONNAGES depuis le 24/10/2026 : lus dans `anime_characters`
 * (scripts/cache/refresh-characters.mjs, une ligne lue), là où la fiche n'en a
 * que 25 — le plafond d'une page AniList. Un anime pas encore relevé retombe
 * sur l'ancien chemin : getMediaMeta, cache à trois couches (mémoire → AniList
 * → Turso), ses 25 premiers.
 *
 * `info.characters` used to ride along in the page's __NEXT_DATA__; the SSR now
 * sends just the count for the tab badge and this endpoint supplies the rows on
 * demand. The table is refreshed daily for airing shows, hence the edge window.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  const id = Number(req.query.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Missing or invalid id" });
  }

  const stored = await getAnimeCharacters(id);
  if (stored) {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("CDN-Cache-Control", "public, s-maxage=43200, stale-while-revalidate=604800");
    return res.status(200).json({
      characters: { edges: stored.edges },
      total: stored.total,
      complete: stored.complete,
    });
  }

  const media = await getMediaMeta(id);
  if (!media) {
    return res.status(404).json({ error: "Anime not found" });
  }

  /* Plus court qu'avant : le relevé quotidien remplacera bientôt ces 25. */
  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader(
    "CDN-Cache-Control",
    "public, s-maxage=3600, stale-while-revalidate=86400",
  );
  return res.status(200).json({ characters: media.characters ?? null });
}
