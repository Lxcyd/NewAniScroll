/**
 * Choosing WHICH TMDB image to show — the selection rules Hayase uses, kept
 * pure and separate from the client so they can be reasoned about and tested
 * without a network.
 *
 * Source: hayase-app/interface, src/lib/components/ui/img/banner.svelte and
 * src/lib/components/ui/banner/full-banner.svelte (read 2026-08-08). Their
 * app fetches these through their own proxy, hayase.ani.zip/v2/images/tmdb,
 * but the payload is TMDB's `/images` response verbatim, so the rules port
 * over unchanged.
 *
 * The two filters are NOT the same, and the asymmetry is the whole point:
 *
 *   backdrop → `iso_639_1 === null`, i.e. TEXTLESS only. A backdrop with
 *     baked-in title text collides with the logo we draw on top of it.
 *   logo     → `iso_639_1 === 'en'`. A logo is title art; a "textless logo"
 *     is a contradiction, and TMDB's null-language logos are usually
 *     mis-tagged junk.
 *
 * Both then require `aspect_ratio > 1.2` (landscape) and take the best
 * `vote_average`.
 *
 * ONE DELIBERATE DEVIATION. Hayase's poster fallback reads
 *   `posters.find(i => i.iso_639_1 == null && i.aspect_ratio > 1.2)`
 * — copy-pasted from their backdrop line. TMDB posters are 2:3, aspect ≈ 0.667,
 * so `> 1.2` can never match and that fallback is dead code in their app. We
 * don't reproduce the bug; we simply don't have a poster fallback at all,
 * because our callers already fall back to the AniList cover, which is the
 * better portrait art anyway (lib/images/cover.ts).
 */

import type { TmdbImage, TmdbImages } from "./client";

/** Landscape enough to sit behind a 21:9 hero without pillarboxing. */
const MIN_ASPECT = 1.2;

/* Highest-voted first. `vote_count` breaks ties: TMDB gives an unvoted image
   vote_average 0, but two images at 0 are ordered arbitrarily otherwise, and
   an arbitrary order means the hero changes art between deploys for no
   reason. */
function byVote(a: TmdbImage, b: TmdbImage): number {
  return b.vote_average - a.vote_average || b.vote_count - a.vote_count;
}

/**
 * Best textless landscape backdrop, or null.
 *
 * This is the one that actually beats what we had: AniList's `bannerImage` is
 * a 1900×400 crop (aspect 4.75) that a 21:9 hero stretches; a TMDB backdrop is
 * native 1280×720 or better.
 */
export function pickBackdrop(images: TmdbImages | null | undefined): TmdbImage | null {
  const list = images?.backdrops;
  if (!Array.isArray(list) || list.length === 0) return null;
  const candidates = list.filter(
    (i) => i.iso_639_1 == null && i.aspect_ratio > MIN_ASPECT && i.file_path,
  );
  if (candidates.length === 0) return null;
  return candidates.sort(byVote)[0] ?? null;
}

/**
 * Best English landscape logo (clear art), or null.
 *
 * `iso_639_1 == null` is NOT accepted here even though the backdrop picker
 * requires it — see the header. Hayase makes the same distinction.
 */
export function pickLogo(images: TmdbImages | null | undefined): TmdbImage | null {
  const list = images?.logos;
  if (!Array.isArray(list) || list.length === 0) return null;
  const candidates = list.filter(
    (i) => i.iso_639_1 === "en" && i.aspect_ratio > MIN_ASPECT && i.file_path,
  );
  if (candidates.length === 0) return null;
  return candidates.sort(byVote)[0] ?? null;
}
