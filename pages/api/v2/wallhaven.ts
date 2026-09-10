import type { NextApiRequest, NextApiResponse } from "next";
import { getWallhavenArtworks } from "@/lib/wallhaven/artworks";

/**
 * GET /api/v2/wallhaven?anime=<anilist_id>
 *
 * Les fonds d'écran Wallhaven d'un titre, pour l'onglet Illustrations de la
 * fiche et l'onglet Image du studio de profil.
 *
 * Une route À PART, comme /api/v2/tmdb-artworks l'est de /api/v2/fanarts, et
 * pour la même raison : fanart.tv est une ligne Turso toujours bon marché,
 * Wallhaven peut coûter un appel sortant sur une clé froide. Les fusionner
 * rendrait la réponse fanart.tv aussi lente que la plus lente des sources, sur
 * une galerie qui s'affiche très bien avec une seule d'entre elles.
 *
 * L'edge fait ici plus que d'habitude : Wallhaven limite à 45 requêtes par
 * minute et par IP, celle de la lambda, partagée par tous les visiteurs. Une
 * heure d'edge avec un jour de stale-while-revalidate est ce qui garantit que
 * la popularité d'un titre ne se traduise pas en 429.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const animeId = Number(req.query.anime);
  if (!Number.isFinite(animeId)) {
    return res
      .status(400)
      .json({ error: "Missing or invalid `anime` query parameter" });
  }

  /* La page demandée. Wallhaven en a 1 445 pour One Piece : les servir d'un
     coup coûterait 61 requêtes contre un quota de 45 par minute, donc la
     galerie les déroule et n'en paie que ce qu'elle regarde. */
  const page = Number(req.query.page) || 1;

  // Ne lève jamais : un titre absent de Wallhaven est une page vide, que la
  // galerie rend comme « les deux autres sources », c'est-à-dire l'existant.
  const { arts, hasMore } = await getWallhavenArtworks(animeId, page);

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=3600, stale-while-revalidate=86400",
  );
  return res.status(200).json({ animeId, page, arts, hasMore });
}
