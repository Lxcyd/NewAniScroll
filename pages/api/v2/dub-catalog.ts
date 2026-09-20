/**
 * La liste des animes doubles en francais, pour le navigateur.
 *
 * Le client choisissait un lecteur VF puis attendait son « absent » avant de
 * basculer — une dizaine de secondes sur une serie qui n'a jamais ete doublee.
 * Avec cette liste il ne le propose tout simplement pas en premier.
 *
 * Quelques milliers d'entiers, mis en cache au bord une demi-journee : un
 * visiteur la telecharge au plus une fois par jour, et le plus souvent jamais —
 * le CDN repond a sa place.
 *
 * Donnees : MyDubList — https://mydublist.com — CC BY 4.0.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { getDubbedMalIds, type DubLang } from "@/lib/db/dubCatalog";

const LANGUES_CONNUES = new Set(["french", "english", "spanish", "german", "italian"]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const demande = String(req.query.lang || "french");
  const lang = (LANGUES_CONNUES.has(demande) ? demande : "french") as DubLang;
  try {
    const ids = await getDubbedMalIds(lang);
    /* Liste vide = inconnue (jamais synchronisee, ou Turso muet). On le DIT,
       pour que le client garde son comportement d'avant au lieu de conclure que
       rien n'est double. Et on ne la met pas en cache longtemps : ce serait
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
    return res.status(200).json({ known: connu, lang, ids: Array.from(ids) });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ known: false, lang, ids: [] });
  }
}
