/**
 * Le catalogue des cadres d'avatar, pour le studio du profil.
 *
 * Identique pour tous les visiteurs et rafraichi une fois par nuit : cache au
 * bord une demi-journee, si bien que presque aucune requete n'atteint la
 * fonction. Liste vide = table pas encore synchronisee : cache court, pour ne
 * pas figer une ignorance.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { getFrameCatalog } from "@/lib/db/avatarFrames";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const collections = await getFrameCatalog();
  const connu = collections.length > 0;
  res.setHeader("Cache-Control", connu ? "public, max-age=3600" : "public, max-age=60");
  res.setHeader(
    "CDN-Cache-Control",
    connu ? "public, s-maxage=43200, stale-while-revalidate=86400" : "public, s-maxage=60",
  );
  return res.status(200).json({ collections });
}
