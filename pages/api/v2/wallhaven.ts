import type { NextApiRequest, NextApiResponse } from "next";
import { getWallhavenArtworks, type Facette } from "@/lib/wallhaven/artworks";

/**
 * GET /api/v2/wallhaven?anime=<anilist_id>[&page=1][&facette=tout]
 *
 * Les fonds d'écran Wallhaven d'un titre, pour l'onglet Illustrations de la
 * fiche et l'onglet Image du studio de profil.
 *
 * CE QUI A CHANGÉ LE 13/09/2026 : cette route ne parle plus à Wallhaven. Elle
 * lit `wallhaven_image`, remplie depuis le poste par `tools/wallhaven/`. Le
 * commentaire qui tenait ici expliquait que l'edge devait absorber la charge
 * parce que Wallhaven limite à 45 requêtes/minute sur l'IP de la lambda,
 * partagée par tous les visiteurs — ce risque n'existe plus, il ne reste
 * qu'une lecture Turso indexée.
 *
 * L'en-tête d'edge est CONSERVÉ, pour une autre raison : la réponse est
 * identique pour tous les visiteurs d'un même titre, et un HIT au bord évite
 * une invocation de fonction. Sur un compte Hobby où le Fluid CPU est la
 * contrainte dure du projet, c'est ce qui compte désormais.
 *
 * La forme de la réponse reste compatible avec l'ancienne (`arts`, `hasMore`) ;
 * `total` et `facettes` s'y ajoutent.
 */

const FACETTES: Facette[] = ["tout", "illustration", "capture", "personnage", "paysage"];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const animeId = Number(req.query.anime);
  if (!Number.isFinite(animeId)) {
    return res
      .status(400)
      .json({ error: "Missing or invalid `anime` query parameter" });
  }

  const page = Number(req.query.page) || 1;

  /* Une facette inconnue vaut « tout » plutôt qu'une erreur : ce paramètre vient
     d'un bouton, et un bouton mal orthographié ne doit pas vider la galerie. */
  const demande = String(req.query.facette || "tout") as Facette;
  const facette: Facette = FACETTES.includes(demande) ? demande : "tout";

  // Ne lève jamais : un titre absent de la table est une page vide, que la
  // galerie rend comme « les deux autres sources », c'est-à-dire l'existant.
  const { arts, hasMore, total, facettes } = await getWallhavenArtworks(
    animeId,
    page,
    facette,
  );

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=3600, stale-while-revalidate=86400",
  );
  return res.status(200).json({ animeId, page, facette, arts, hasMore, total, facettes });
}
