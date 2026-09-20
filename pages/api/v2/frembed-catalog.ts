/**
 * La liste des animes que frembed peut servir, pour le navigateur.
 *
 * La route /api/v2/source sait deja repondre « absent » sans rien resoudre
 * (cf. lib/db/frembedCatalog), mais le client, lui, continuait de CHOISIR
 * frembed comme premier lecteur puis d'attendre ce « absent » avant de
 * basculer. Avec cette liste il ne le propose tout simplement pas.
 *
 * Quelques centaines d'entiers, mis en cache au bord une demi-journee : un
 * visiteur la telecharge au plus une fois par jour, et le plus souvent jamais —
 * le CDN repond a sa place.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { getFrembedAnilistIds } from "@/lib/db/frembedCatalog";

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse,
) {
  try {
    const ids = await getFrembedAnilistIds();
    /* Liste vide = inconnue (jamais synchronisee, ou Turso muet). On le DIT,
       pour que le client garde son comportement d'avant au lieu de conclure
       que frembed n'a rien. Et on ne la met pas en cache longtemps : ce serait
       figer une ignorance. */
    const connu = ids.size > 0;
    res.setHeader(
      "Cache-Control",
      connu ? "public, max-age=3600" : "public, max-age=60",
    );
    res.setHeader(
      "CDN-Cache-Control",
      connu
        ? "public, s-maxage=43200, stale-while-revalidate=86400"
        : "public, s-maxage=60",
    );
    return res.status(200).json({ known: connu, ids: Array.from(ids) });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ known: false, ids: [] });
  }
}
