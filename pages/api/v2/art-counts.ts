import type { NextApiRequest, NextApiResponse } from "next";
import { countFanartsByType } from "@/lib/db/fanarts";
import { compterToutParAnime } from "@/lib/db/wallhavenImages";
import { countCachedTmdbArtworks } from "@/lib/tmdb/artworksCache";

/**
 * GET /api/v2/art-counts?ids=<id>,<id>,…
 *
 * Combien d'illustrations chaque animé d'une liste propose, PAR TYPE, pour le
 * sous-titre des lignes du studio de profil (onglets Image et Bannière). Le
 * client choisit lui-même les types que son onglet garde, d'où des comptes par
 * type et non un total.
 *
 * TROIS REQUÊTES SQL POUR TOUTE LA LISTE, quel que soit son nombre de titres :
 * fanart.tv et Wallhaven comptés par GROUP BY, TMDB lu dans son cache Turso.
 * La première version appelait les fonctions de la galerie titre par titre, et
 * une clé TMDB froide y déclenchait un appel à TMDB PLUS le hachage perceptuel
 * de ses images — vingt fois dans une invocation, sur un compte Hobby où le
 * Fluid CPU est la contrainte dure du projet. Ici une clé absente ne déclenche
 * rien : le titre est compté sans TMDB, et le studio corrige au compte exact
 * dès qu'on l'ouvre.
 *
 * Les ids sont triés et bornés pour que la même liste retombe sur la même clé
 * d'edge.
 */
/* 200 et non plus 40 (22/10/2026) : trois requêtes SQL quel que soit le
   nombre d'ids, donc un lot plus gros ne coûte presque rien de plus — et une
   liste de 800 animés passe en ~6 appels au lieu de 20 (chacun, à froid, une
   invocation de fonction). */
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

  const [fanarts, tmdb, wall] = await Promise.all([
    countFanartsByType(ids),
    countCachedTmdbArtworks(ids),
    compterToutParAnime(ids),
  ]);

  const counts: Record<number, Record<string, number>> = {};
  for (const id of ids) {
    const types: Record<string, number> = { ...fanarts[id] };
    for (const [t, n] of Object.entries(tmdb[id] ?? {})) types[t] = (types[t] || 0) + n;
    if (wall[id]) types.wallpaper = wall[id];
    counts[id] = types;
  }

  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("CDN-Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
  return res.status(200).json({ counts });
}
