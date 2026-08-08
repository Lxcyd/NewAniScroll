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
const CACHE_VERSION = "v1";

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

/**
 * Every TMDB image for an AniList id, de-duplicated and ready to render.
 * Empty on any failure, on a missing key, or on an unmapped title.
 */
export async function getTmdbArtworks(anilistId: number): Promise<TmdbArtwork[]> {
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
  await setCachedJson(key, { arts });
  return arts;
}
