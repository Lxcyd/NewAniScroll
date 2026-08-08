/**
 * TMDB's full image library for the info page's Artworks gallery.
 *
 * Distinct from lib/tmdb/animeImages.ts, which resolves the ONE backdrop and
 * ONE logo the heroes render. The gallery wants everything, so it can't reuse
 * that cache — but it resolves the TMDB record through the same
 * `resolveTmdbTarget()`, because a title whose hero and gallery disagreed
 * about which show they're looking at would be a bug nobody would think to
 * look for.
 *
 * DE-DUPLICATION, which is the interesting part. TMDB accepts the same asset
 * twice under different `file_path`s — measured on Chainsmoker Cat (tv 312949),
 * whose two "English logo" records are both 621×139 and are visibly the same
 * image. So two passes:
 *
 *   1. by `file_path` — exact, always safe, catches the trivial case.
 *   2. by (type, width, height) — but ONLY for logos. Two logos of one show at
 *      byte-identical dimensions are a re-upload. The same rule applied to
 *      backdrops would be destructive: essentially every backdrop is 1920×1080
 *      and they are all different scenes. Posters likewise cluster at 2000×3000.
 *      A heuristic that is right for one type and wrong for the others gets
 *      applied to that one type only.
 *
 * Everything degrades to an empty list; nothing throws.
 */

import { getCachedJson, setCachedJson } from "@/lib/db/tmdbImagesCache";
import {
  getMovieImages,
  getTvImages,
  tmdbEnabled,
  tmdbImageUrl,
  type ImageSize,
  type TmdbImage,
  type TmdbImages,
} from "./client";
import { resolveTmdbTarget } from "./animeImages";
import {
  DUPLICATE_THRESHOLD,
  hammingHex,
  hashMany,
} from "@/lib/images/perceptualHash";

/** One gallery entry. Shape mirrors FanartItem so the tab can merge the two
 *  lists without a translation layer on the client. */
export interface TmdbArtwork {
  url: string;
  /** Gallery bucket. Named to line up with the fanart.tv type labels. */
  type: "background" | "poster" | "logo";
  /** Always null: TMDB's iso_639_1 is a filter input here, not a display
   *  field, and the tab's language chip only means something for fanart.tv. */
  language: null;
  /** TMDB's vote_average, rounded — the tab sorts on this like it does likes. */
  likes: number;
  season: null;
  /** Full-resolution URL for the lightbox, when the thumbnail is downscaled. */
  fullUrl: string;
}

const TTL_S = 30 * 24 * 60 * 60;
/* v1 -> v2 (2026-08-08): cross-provider de-duplication shipped. A v1 row holds
   the un-deduplicated list, and the duplicates the user reported are exactly
   what it would keep serving for 30 days. */
const CACHE_VERSION = "v2";

/* Gallery thumbnails render in a grid at a few hundred px; w780 is sharp there
   without pulling a 3840 px original per tile. The lightbox gets `original`,
   which is the one place the full file is worth its weight. */
const GRID_BACKDROP: ImageSize = "w780";
const GRID_POSTER: ImageSize = "w500";
const GRID_LOGO: ImageSize = "w500";

function dedupe(images: TmdbImage[], type: TmdbArtwork["type"]): TmdbImage[] {
  const seenPath = new Set<string>();
  const seenDims = new Set<string>();
  const out: TmdbImage[] = [];

  // Best-voted first, so when two records collide we keep the better-rated one.
  const sorted = images
    .slice()
    .sort((a, b) => b.vote_average - a.vote_average || b.vote_count - a.vote_count);

  for (const img of sorted) {
    if (!img.file_path || seenPath.has(img.file_path)) continue;
    if (type === "logo") {
      const dims = `${img.width}x${img.height}`;
      if (seenDims.has(dims)) continue;
      seenDims.add(dims);
    }
    seenPath.add(img.file_path);
    out.push(img);
  }
  return out;
}

function toArtworks(images: TmdbImages | null): TmdbArtwork[] {
  if (!images) return [];
  const out: TmdbArtwork[] = [];

  const push = (
    list: TmdbImage[] | undefined,
    type: TmdbArtwork["type"],
    size: ImageSize,
  ) => {
    for (const img of dedupe(Array.isArray(list) ? list : [], type)) {
      const url = tmdbImageUrl(img.file_path, size);
      const fullUrl = tmdbImageUrl(img.file_path, "original");
      if (!url || !fullUrl) continue;
      out.push({
        url,
        type,
        language: null,
        likes: Math.round(img.vote_average),
        season: null,
        fullUrl,
      });
    }
  };

  push(images.backdrops, "background", GRID_BACKDROP);
  push(images.posters, "poster", GRID_POSTER);
  push(images.logos, "logo", GRID_LOGO);

  return out;
}

/* Hashing means downloading, so hash the smallest variant that still carries
   the structure dHash reads. w185 is ~8 kB and downscales to 9×8 identically
   to the full file. The grid URLs are w780/w500, so this is a path swap. */
function tinyVariant(url: string): string {
  return url.replace(/\/t\/p\/w\d+\//, "/t/p/w185/");
}

/* Hash fanart.tv from its ORIGIN, never through fanart-proxy.aniscroll.com.
   The proxy converts via CF Image Transformations, capped at 5,000 unique
   transformations/month on the free tier (see lib/images/fanartFallback.ts) —
   spending that quota on images no visitor will ever see would be a
   self-inflicted outage of the real gallery. */
function fanartOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.startsWith("/fanart/")
      ? `https://assets.fanart.tv${u.pathname}${u.search}`
      : url;
  } catch {
    return url;
  }
}

/* Ceiling on how many images we're willing to download to compare. Well above
   a normal title (BLACK TORCH: 13 TMDB + ~20 fanart) and low enough that a
   One Piece-sized gallery can't turn one cold request into a minute of I/O. */
const MAX_HASHED = 48;

/**
 * Every TMDB image for an AniList id, minus anything fanart.tv already
 * supplies. Empty on any failure, on a missing key, or on an unmapped title.
 *
 * `fanartUrls` are the gallery-eligible fanart.tv images for the same title.
 * Pass them and the two libraries are compared by CONTENT — which is the only
 * thing that works, since the same official poster on both hosts shares no
 * identifier, no URL and not even the same pixel dimensions.
 */
export async function getTmdbArtworks(
  anilistId: number,
  fanartUrls: string[] = [],
): Promise<TmdbArtwork[]> {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return [];
  if (!tmdbEnabled()) return [];

  const key = `tmdbArtworks:${CACHE_VERSION}:${anilistId}`;
  const cached = await getCachedJson<{ arts: TmdbArtwork[] }>(key, TTL_S);
  if (cached) return cached.arts ?? [];

  const target = await resolveTmdbTarget(anilistId);
  if (!target) {
    // Cacheable "no": an unmapped title stays unmapped until Fribb or ani.zip
    // learns about it, and the gallery is not worth re-asking on every open.
    await setCachedJson(key, { arts: [] });
    return [];
  }

  const images =
    target.kind === "tv"
      ? await getTvImages(target.id)
      : await getMovieImages(target.id);

  // A failed request must NOT be cached as "no artwork" for 30 days.
  if (!images) return [];

  const arts = toArtworks(images);
  const deduped = await dropVisualDuplicates(arts, fanartUrls);
  await setCachedJson(key, { arts: deduped });
  return deduped;
}

/**
 * Drop TMDB images that duplicate a fanart.tv image, or each other.
 *
 * Two levels, because URL and dimension equality miss both cases:
 *   - against fanart.tv — the same official poster on two hosts.
 *   - within TMDB — the same asset re-uploaded under a second file_path, which
 *     the dimension pass upstream only catches for logos.
 *
 * Returns the input unchanged on any failure. An un-deduplicated gallery is
 * the status quo; a gallery missing real artwork because a fetch timed out is
 * a regression, so every uncertain case resolves toward keeping the image.
 */
async function dropVisualDuplicates(
  arts: TmdbArtwork[],
  fanartUrls: string[],
): Promise<TmdbArtwork[]> {
  if (arts.length === 0) return arts;

  const tmdbTargets = arts.slice(0, MAX_HASHED).map((a) => tinyVariant(a.url));
  const fanartTargets = fanartUrls
    .slice(0, Math.max(0, MAX_HASHED - tmdbTargets.length))
    .map(fanartOrigin);

  const hashes = await hashMany([...tmdbTargets, ...fanartTargets]).catch(
    () => new Map<string, string>(),
  );
  if (hashes.size === 0) return arts;

  const fanartHashes = fanartTargets
    .map((u) => hashes.get(u))
    .filter((h): h is string => !!h);

  const kept: TmdbArtwork[] = [];
  const keptHashes: string[] = [];

  for (const art of arts) {
    const h = hashes.get(tinyVariant(art.url)) ?? null;
    // Unhashable → keep. Never delete on missing evidence.
    if (h) {
      const dupOfFanart = fanartHashes.some(
        (f) => hammingHex(h, f) <= DUPLICATE_THRESHOLD,
      );
      if (dupOfFanart) continue;
      const dupOfKept = keptHashes.some(
        (k) => hammingHex(h, k) <= DUPLICATE_THRESHOLD,
      );
      if (dupOfKept) continue;
      keptHashes.push(h);
    }
    kept.push(art);
  }

  return kept;
}
