import { prisma } from "@/lib/prisma";

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
 */
const TTL_MS = 10 * 60 * 1000;
let cache: { value: any[]; at: number } | null = null;

export const getRemovedMedia = async (): Promise<any | null> => {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const removedMedia = await prisma.removedMedia.findMany();
    cache = { value: removedMedia, at: Date.now() };
    return removedMedia;
  } catch (error) {
    // Serve the last good copy if we have one; otherwise say "unknown" (null),
    // which the caller treats as "don't redirect".
    return cache?.value ?? null;
  }
};
