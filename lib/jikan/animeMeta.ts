import { seasonCacheGetEntry, seasonCacheSet } from "@/lib/db/seasonCache";

/**
 * Anime-level facts MyAnimeList has and AniList does not, via Jikan.
 *
 *   - `titleFr`  : the French title. AniList's `synonyms` carry no language, so
 *                  "L'Attaque des Titans" cannot be told apart from "AoT" there.
 *   - `rating`   : the age classification (G / PG / PG-13 / R / R+ / Rx).
 *                  AniList only has the `isAdult` boolean.
 *   - `synopsis` : MAL's own synopsis — a DIFFERENT text from AniList's, used
 *                  only as a fallback when AniList has none.
 *
 * Read at SSR on the info page, so the rules are strict:
 *   - Turso (season_cache table) holds the result for 30 days — a hit is one
 *     row read that runs alongside the fanarts read;
 *   - a miss calls Jikan ONCE with a short timeout. It runs concurrently with
 *     the season walkers, so it rarely adds latency, and never more than the
 *     timeout;
 *   - a real "nothing" (404, no fields) is cached 3 days; a transient failure
 *     (429, 5xx — Jikan relays MAL outages as 504 — timeout) is NOT cached, so
 *     the next edge-cache miss retries.
 * Never throws: every failure is `null`, and the page renders without the rows.
 */

export type MalRating = "G" | "PG" | "PG-13" | "R" | "R+" | "Rx";

export type MalMeta = {
  titleFr: string | null;
  rating: MalRating | null;
  synopsis: string | null;
};

const KEY = (idMal: number) => `malMeta:v1:${idMal}`;
const TTL_HIT_S = 30 * 24 * 3600;
const TTL_MISS_S = 3 * 24 * 3600;
const TIMEOUT_MS = 2500;

/** Jikan spells the rating as a sentence ("PG-13 - Teens 13 or older"); keep
 *  the code alone, the UI translates it. */
function parseRating(raw: unknown): MalRating | null {
  if (typeof raw !== "string") return null;
  const code = raw.split(" - ")[0].trim();
  return (["G", "PG", "PG-13", "R", "R+", "Rx"] as const).find((c) => c === code) ?? null;
}

/** MAL appends "[Written by MAL Rewrite]" to its synopses — drop the credit. */
function cleanSynopsis(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s*\[Written by MAL Rewrite\]\s*$/i, "").trim();
  return s || null;
}

async function fetchFromJikan(idMal: number): Promise<MalMeta | "miss" | "transient"> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.jikan.moe/v4/anime/${idMal}`, {
      signal: ctrl.signal,
    });
    if (res.status === 404) return "miss";
    if (!res.ok) return "transient";
    const d = (await res.json())?.data;
    if (!d) return "miss";
    const titles: Array<{ type?: string; title?: string }> = d.titles || [];
    return {
      titleFr: titles.find((t) => t.type === "French")?.title?.trim() || null,
      rating: parseRating(d.rating),
      synopsis: cleanSynopsis(d.synopsis),
    };
  } catch {
    return "transient";
  } finally {
    clearTimeout(timer);
  }
}

export async function getMalMeta(idMal: number | null | undefined): Promise<MalMeta | null> {
  if (!idMal) return null;
  const cached = await seasonCacheGetEntry<MalMeta | { miss: true }>(KEY(idMal));
  if (cached) {
    const isMiss = "miss" in cached.value;
    if (cached.ageSeconds <= (isMiss ? TTL_MISS_S : TTL_HIT_S)) {
      return isMiss ? null : (cached.value as MalMeta);
    }
  }
  const r = await fetchFromJikan(idMal);
  if (r === "transient") return cached && !("miss" in cached.value) ? (cached.value as MalMeta) : null;
  await seasonCacheSet(KEY(idMal), r === "miss" ? { miss: true } : r);
  return r === "miss" ? null : r;
}
