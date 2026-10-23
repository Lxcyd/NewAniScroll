import { prisma } from "@/lib/prisma";
import { seasonCacheGetEntry, seasonCacheSet } from "@/lib/db/seasonCache";
import { waitUntil } from "@/lib/http/waitUntil";

/**
 * DMCA'd / removed titles. Read on EVERY watch-page SSR to decide whether to
 * redirect, so an uncached `findMany` meant one Prisma round-trip per view of
 * the site's busiest page — for a table that changes maybe a few times a year
 * and is edited by hand.
 *
 * Cached in-process for 10 minutes: a warm lambda answers from memory, and a
 * newly-removed title starts redirecting within that window at worst (the entry
 * is added by an admin, not by a user flow waiting on it). A failed read is NOT
 * cached — falling back to "nothing removed" for 10 minutes because Prisma
 * blipped would un-hide a takedown.
 *
 * UNE COPIE DANS TURSO, DEVANT POSTGRES (23/10/2026). Sur une lambda neuve, la
 * memoire est vide et la premiere requete Prisma coute la connexion a Postgres :
 * 0,86 s mesuree dans le `Server-Timing` de la page de lecture (`retires`),
 * plus que tout le reste du rendu — pour une table qui compte ZERO ligne ce
 * jour-la. La page ouvre de toute facon Turso (sa copie de la fiche), donc lire
 * la liste la ne coute qu'une ligne. Postgres reste la reference : la copie est
 * servie tout de suite et, passe 10 min, rafraichie depuis Postgres APRES la
 * reponse. Une suppression ajoutee a la main se propage donc dans le meme delai
 * qu'avant (~10 min, une requete de plus). Sans copie (premiere fois, Turso
 * muet), on attend Postgres comme avant.
 */
const TTL_MS = 10 * 60 * 1000;
const TURSO_KEY = "removedMedia:v1";
let cache: { value: any[]; at: number } | null = null;
let refreshing: Promise<any[] | null> | null = null;

/** Lit Postgres, met a jour la memoire et la copie Turso. `null` sur echec. */
function refreshFromPrisma(): Promise<any[] | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const removedMedia = await prisma.removedMedia.findMany();
      cache = { value: removedMedia, at: Date.now() };
      await seasonCacheSet(TURSO_KEY, removedMedia);
      return removedMedia;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export const getRemovedMedia = async (): Promise<any | null> => {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const copy = await seasonCacheGetEntry<any[]>(TURSO_KEY);
  if (copy && Array.isArray(copy.value)) {
    if (copy.ageSeconds * 1000 >= TTL_MS) waitUntil(refreshFromPrisma());
    else cache = { value: copy.value, at: Date.now() - copy.ageSeconds * 1000 };
    return copy.value;
  }

  const fresh = await refreshFromPrisma();
  // Serve the last good copy if we have one; otherwise say "unknown" (null),
  // which the caller treats as "don't redirect".
  return fresh ?? cache?.value ?? null;
};
