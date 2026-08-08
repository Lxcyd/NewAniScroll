/**
 * AniList id → TMDB backdrop + logo: cache → map → fetch → pick → cache.
 *
 * This is the series-level half of the TMDB integration, and the half that
 * carries none of the baggage that got TMDB dropped as a stills provider on
 * 2026-08-03. That decision was about SEASONS: mapping an AniList entry onto a
 * TMDB season is guesswork, and the old code refused rather than guess.
 * Backdrops and logos hang off the SERIES, so `tmdbTvId` alone is enough and
 * there is nothing to prove. (Episode stills still need a season — they stay a
 * complement to Simkl, see lib/tmdb/episodeStills.ts.)
 *
 * MAPPING. Fribb's `themoviedb_id` is a static cross-map, not a TMDB call, and
 * we already ingest it (lib/fribb/fribbMap.ts). Its known weakness — mislabelled
 * and fused SEASONS (Bungo Stray Dogs: season = 1,1,2,3,3) — is precisely the
 * field we don't read here. `tmdb.tv` identifying the right *show* is the part
 * Fribb gets right; `isFribbGroupConsistent()` exists to catch the rest and
 * isn't needed for artwork.
 *
 * A sequel entry maps to the same `tmdb.tv` as its parent, so seasons of one
 * show share a backdrop. That is correct for a hero background (it's the
 * show's art) and is why `tmdbMovieId` is tried second: a film has its own id
 * and its own art.
 *
 * Fail-soft: every path returns `EMPTY` and the caller keeps whatever it used
 * before (AniList `bannerImage`, fanart.tv logo).
 */

import {
  getCachedTmdbImages,
  setCachedTmdbImages,
  type TmdbImagesCacheValue,
  type TmdbImagesReason,
} from "@/lib/db/tmdbImagesCache";
import { getFribbEntry } from "@/lib/fribb/fribbMap";
import {
  getMovieImages,
  getTvImages,
  tmdbEnabled,
  tmdbImageUrl,
  type TmdbImages,
} from "./client";
import { pickBackdrop, pickLogo } from "./pick";

export interface TmdbAnimeImages {
  /** Textless landscape key art, sized for a full-bleed hero. */
  backdrop: string | null;
  /** English title art (clear art / logo), transparent PNG. */
  logo: string | null;
}

const EMPTY: TmdbAnimeImages = { backdrop: null, logo: null };

/* w1280 for the hero: it renders at 21:9 across a desktop viewport, and
   `images.unoptimized: true` in next.config.js means this URL is exactly what
   the browser downloads. w780 would visibly soften on a 1440p screen; original
   is routinely 3840 px and 1.5 MB. Same trade-off as lib/images/cover.ts. */
const BACKDROP_SIZE = "w1280" as const;
/* Logos render at ~480 CSS px on the hero; w500 is the first size above that. */
const LOGO_SIZE = "w500" as const;

/**
 * The picked TMDB artwork for an AniList id. Never throws.
 *
 * Safe to call per-item in a Promise.all on an SSR path: a warm row is one
 * Turso read, and a cold one is a single TMDB request whose result is then
 * good for 30 days.
 */
export async function getTmdbAnimeImages(
  anilistId: number,
): Promise<TmdbAnimeImages> {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return EMPTY;
  if (!tmdbEnabled()) return EMPTY;

  const cached = await getCachedTmdbImages(anilistId);
  if (cached) return { backdrop: cached.backdrop, logo: cached.logo };

  const refuse = async (
    reason: TmdbImagesReason,
    tmdbId: number | null = null,
    kind: "tv" | "movie" | null = null,
  ): Promise<TmdbAnimeImages> => {
    // Never cache a transient failure as "no artwork" — it would stick for a
    // day over one timeout.
    if (reason !== "tmdb-error") {
      const value: TmdbImagesCacheValue = {
        backdrop: null,
        logo: null,
        reason,
        tmdbId,
        kind,
      };
      await setCachedTmdbImages(anilistId, value);
    }
    return EMPTY;
  };

  const entry = await getFribbEntry(anilistId);
  if (!entry) return await refuse("no-fribb");

  /* TV first: most anime are series, and a sequel's own art lives under the
     parent's tv id. A movie has neither, hence the second branch. */
  let images: TmdbImages | null = null;
  let tmdbId: number | null = null;
  let kind: "tv" | "movie" | null = null;

  if (entry.tmdbTvId) {
    tmdbId = entry.tmdbTvId;
    kind = "tv";
    images = await getTvImages(entry.tmdbTvId);
  } else if (entry.tmdbMovieId) {
    tmdbId = entry.tmdbMovieId;
    kind = "movie";
    images = await getMovieImages(entry.tmdbMovieId);
  } else {
    return await refuse("no-tmdb-id");
  }

  // null from the client is a failed request (or a 404), not "no images" —
  // it must not be cached as a refusal.
  if (!images) return await refuse("tmdb-error", tmdbId, kind);

  const backdrop = tmdbImageUrl(pickBackdrop(images)?.file_path, BACKDROP_SIZE);
  const logo = tmdbImageUrl(pickLogo(images)?.file_path, LOGO_SIZE);

  if (!backdrop && !logo) return await refuse("no-images", tmdbId, kind);

  await setCachedTmdbImages(anilistId, {
    backdrop,
    logo,
    reason: "ok",
    tmdbId,
    kind,
  });
  return { backdrop, logo };
}

/**
 * Batch helper for list pages (the homepage hero resolves eight at once).
 *
 * Plain `Promise.all` on purpose, no concurrency limiter: TMDB's soft ceiling
 * is ~50 req/s per IP and warm rows don't reach the network at all, so eight
 * parallel calls are never the constraint. Individual failures are already
 * absorbed inside `getTmdbAnimeImages`, so this cannot reject.
 */
export async function getTmdbAnimeImagesMany(
  anilistIds: number[],
): Promise<Map<number, TmdbAnimeImages>> {
  const unique = Array.from(new Set(anilistIds.filter((id) => Number.isFinite(id))));
  const out = new Map<number, TmdbAnimeImages>();
  const results = await Promise.all(unique.map((id) => getTmdbAnimeImages(id)));
  unique.forEach((id, i) => out.set(id, results[i] ?? EMPTY));
  return out;
}
