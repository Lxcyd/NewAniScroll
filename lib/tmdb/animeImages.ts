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
import { getAniZipMapping } from "@/lib/anizip/mappings";
// @ts-ignore — getMediaMeta.js is untyped JS, like its other callers.
import { getMediaMeta } from "@/lib/anilist/getMediaMeta";
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

/* How far back to walk. Two hops covers "S3 is new, S2 is new, S1 has been in
   Fribb for years", which is the shape of the problem; beyond that we're
   drifting away from the entry the visitor is looking at. */
const MAX_PREQUEL_HOPS = 2;

/**
 * Borrow the franchise's TMDB tv id from an earlier season.
 *
 * THE GAP THIS CLOSES, measured 2026-08-08: Hell Mode S2 (AniList 209983) is
 * in Fribb with every id null — no `tmdb.tv`, no `tvdb_id`, no `simkl_id` —
 * while S1 (185262) maps cleanly to tv 280049. Fribb is a periodically
 * regenerated static file and a currently-airing sequel is exactly what it
 * hasn't caught up with, so the site's most prominent titles were the ones
 * still showing the old AniList banner.
 *
 * WHY THIS IS SAFE HERE AND NOWHERE ELSE. A TMDB *tv* id identifies the SHOW,
 * and backdrops and logos hang off the show — season 2's key art is the same
 * artwork as season 1's, which is why sequel entries legitimately share a
 * `tmdb.tv` in Fribb to begin with. Episode stills are the opposite: they hang
 * off a season, and inheriting a parent's id there would paste season 1's
 * frames onto season 2's rows. lib/tmdb/episodeStills.ts must never call this,
 * and doesn't.
 *
 * Cost: `getMediaMeta` is memory-cached for 24h per process and Turso-backed,
 * and this only runs on a cold TMDB cache miss whose result is then good for
 * 30 days — so it is not a per-request expense. Returns null on anything
 * unexpected; the caller then refuses as before.
 */
async function inheritTvIdFromPrequel(anilistId: number): Promise<number | null> {
  let currentId = anilistId;

  for (let hop = 0; hop < MAX_PREQUEL_HOPS; hop++) {
    const meta = await getMediaMeta(currentId).catch(() => null);
    const edges: any[] = meta?.relations?.edges ?? [];

    /* TV-like only. A PREQUEL edge frequently points at a movie (Jujutsu
       Kaisen 0), and a film carries its own TMDB *movie* id, not the series'
       — following it would land on the wrong kind of record entirely. */
    const prequel = edges.find(
      (e) =>
        e?.relationType === "PREQUEL" &&
        e?.node?.type === "ANIME" &&
        ["TV", "TV_SHORT", "ONA"].includes(e?.node?.format || ""),
    );
    const prevId = Number(prequel?.node?.id);
    if (!Number.isFinite(prevId) || prevId <= 0) return null;

    const prev = await getFribbEntry(prevId);
    if (prev?.tmdbTvId) {
      console.warn(
        `[tmdb] ${anilistId}: no tmdb.tv in fribb → inherited ${prev.tmdbTvId} ` +
          `from prequel ${prevId}`,
      );
      return prev.tmdbTvId;
    }
    currentId = prevId;
  }

  return null;
}

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

  /* A missing Fribb row is no longer fatal — ani.zip below is keyed on the
     AniList id and needs no cross-map at all. */
  const entry = await getFribbEntry(anilistId);

  /* TV first: most anime are series, and a sequel's own art lives under the
     parent's tv id. A movie has neither, hence the second branch. */
  let images: TmdbImages | null = null;
  let tmdbId: number | null = null;
  let kind: "tv" | "movie" | null = null;

  /* THREE WAYS TO FIND THE ID, cheapest and most reliable first.

     1. Fribb — one local Turso row, no network. Right whenever it has the
        entry at all.
     2. ani.zip — one HTTP call, but keyed on the AniList id itself, so it
        answers for the NEW titles Fribb systematically lags. That lag is not
        random: it hits exactly the currently-airing shows the hero features.
        Measured 2026-08-08 — Chainsmoker Cat (207141) and Hell Mode S2
        (209983) both had no Fribb tmdb id while ani.zip knew 312949 and
        280049. TMDB had the artwork the whole time.
     3. The prequel's id — for a sequel nobody has mapped yet. Last because it
        borrows another entry's identity, which is only sound for series-level
        art (see inheritTvIdFromPrequel). */
  const mapping = entry?.tmdbTvId ? null : await getAniZipMapping(anilistId);
  const tvId =
    entry?.tmdbTvId ??
    mapping?.tmdbTvId ??
    (await inheritTvIdFromPrequel(anilistId));

  if (tvId) {
    tmdbId = tvId;
    kind = "tv";
    images = await getTvImages(tvId);
  } else if (entry?.tmdbMovieId ?? mapping?.tmdbMovieId) {
    tmdbId = (entry?.tmdbMovieId ?? mapping?.tmdbMovieId) as number;
    kind = "movie";
    images = await getMovieImages(tmdbId);
  } else {
    return await refuse(entry ? "no-tmdb-id" : "no-fribb");
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
