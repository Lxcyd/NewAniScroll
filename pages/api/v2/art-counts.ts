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

/* LE MEME COMPTE, GARDE 30 MIN PAR ANIME dans la memoire du processus.
   Les trois comptages sont independants d'un anime a l'autre : n'interroger que
   les ids absents rend exactement le meme resultat par id. Mesure du 23/10/2026
   (tools/turso/query-cost.mjs) : ~69 000 lignes Turso par lot de 200 animes,
   dont 57 000 pour Wallhaven. En prod le cache d'edge (6 h) repond avant ; mais
   le serveur local n'a pas d'edge, et chaque ouverture du studio relisait tout
   — sur le quota Turso partage par prod, dev ET local. 30 min : les images
   arrivent par le robot quotidien, et l'edge tolere deja bien plus.

   SEULS LES COMPTES NON VIDES SONT GARDES. Les trois lectures avalent leurs
   erreurs et rendent `{}` : une panne Turso ressemble a « aucune image ». Un
   anime sans image ne coute presque rien a relire ; une panne, elle, ne doit
   jamais rester en memoire. */
const MEMO_TTL_MS = 30 * 60 * 1000;
const memo = new Map<number, { at: number; types: Record<string, number> }>();

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

  const now = Date.now();
  const fresh: Record<number, Record<string, number>> = {};
  const missing = ids.filter((id) => {
    const m = memo.get(id);
    return !m || now - m.at > MEMO_TTL_MS;
  });

  if (missing.length) {
    const [fanarts, tmdb, wall] = await Promise.all([
      countFanartsByType(missing),
      countCachedTmdbArtworks(missing),
      compterToutParAnime(missing),
    ]);
    for (const id of missing) {
      const types: Record<string, number> = { ...fanarts[id] };
      for (const [t, n] of Object.entries(tmdb[id] ?? {})) types[t] = (types[t] || 0) + n;
      if (wall[id]) types.wallpaper = wall[id];
      fresh[id] = types;
      memo.delete(id);
      if (Object.keys(types).length) memo.set(id, { at: now, types });
    }
    /* Borne : un processus qui vit longtemps ne doit pas accumuler tout le
       catalogue. Les plus anciennes entrees (ordre d'insertion) sautent. */
    if (memo.size > 5000) {
      for (const key of [...memo.keys()].slice(0, memo.size - 5000)) memo.delete(key);
    }
  }

  const counts: Record<number, Record<string, number>> = {};
  for (const id of ids) counts[id] = { ...(fresh[id] ?? memo.get(id)?.types ?? {}) };

  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("CDN-Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
  return res.status(200).json({ counts });
}
