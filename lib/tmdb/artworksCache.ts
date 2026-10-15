import { getFanartsClient } from "@/lib/db/turso-fanarts";

/**
 * Ce que la galerie TMDB range dans `tmdb_images_cache`, et ce qu'on peut en
 * lire SANS tirer lib/tmdb/artworks.ts : ce dernier importe le hachage
 * perceptuel (sharp), dont une route qui ne fait que compter n'a aucun besoin.
 */

/* IMAGES TMDB QUI N'APPARTIENNENT PAS A LEUR FICHE. TMDB est alimente par ses
   utilisateurs, et une affiche d'un autre anime s'y glisse parfois. Aucun
   signal ne les distingue : sur Tengoku Daimakyo (TMDB 208891), les deux
   intruses sont sans langue et a 0 vote, exactement comme deux vraies affiches
   de la meme fiche. D'ou une liste a la main, par `file_path`, appliquee a la
   LECTURE pour agir aussi sur les 30 jours de cache.
   Signaler l'image sur TMDB en parallele : c'est la seule correction a la source. */
const EXCLUES = new Set<string>([
  "7yMryD19UQQbFi4dTejR8YRNjJI", // Tengoku Daimakyo — couple sous les cerisiers (13/09/2026)
  "yK4GKL7Eh1r7R8AFB0NL9MLiD0z", // Tengoku Daimakyo — deux garcons, porte vitree (13/09/2026)
]);

export const estExclue = (a: { url: string }) =>
  EXCLUES.has(a.url.slice(a.url.lastIndexOf("/") + 1).replace(/\.\w+$/, ""));

export const TTL_S = 30 * 24 * 60 * 60;
/* v1 -> v2 (2026-08-08): cross-provider de-duplication shipped. A v1 row holds
   the un-deduplicated list, and the duplicates the user reported are exactly
   what it would keep serving for 30 days. */
const CACHE_VERSION = "v2";

export const artworksKey = (anilistId: number) => `tmdbArtworks:${CACHE_VERSION}:${anilistId}`;

/**
 * Le compte par type des galeries TMDB DÉJÀ en cache, pour toute une liste en
 * une requête. Une clé absente ou périmée ne déclenche rien — ni appel TMDB ni
 * hachage : le titre est simplement compté sans TMDB. Ne lève jamais.
 */
export async function countCachedTmdbArtworks(
  ids: number[],
): Promise<Record<number, Record<string, number>>> {
  const out: Record<number, Record<string, number>> = {};
  const db = getFanartsClient();
  if (!db || !ids.length) return out;
  try {
    const r = await db.execute({
      sql: `SELECT cache_key, value, updated_at FROM tmdb_images_cache
             WHERE cache_key IN (${ids.map(() => "?").join(",")})`,
      args: ids.map(artworksKey),
    });
    const now = Math.floor(Date.now() / 1000);
    for (const row of r.rows as any[]) {
      if (now - Number(row.updated_at) > TTL_S) continue;
      const id = Number(String(row.cache_key).split(":").pop());
      const arts: Array<{ url: string; type: string }> = JSON.parse(String(row.value))?.arts ?? [];
      const types: Record<string, number> = {};
      for (const a of arts) if (!estExclue(a)) types[a.type] = (types[a.type] || 0) + 1;
      out[id] = types;
    }
  } catch {
    /* Sans TMDB, les comptes restent ceux de fanart.tv et Wallhaven. */
  }
  return out;
}
