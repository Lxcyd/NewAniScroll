/**
 * Per-episode image varying.
 *
 * AniList only exposes real per-episode thumbnails (`streamingEpisodes`) for
 * Crunchyroll/Funimation-licensed titles. Everywhere else the episode API has
 * nothing episode-specific to give, and every row used to fall back to the
 * SAME `bannerImage` — ten identical tiles on a ten-episode show.
 *
 * These images are not of the episode; nothing we have is. But we already hold
 * a pool of landscape art per anime (banner + fanart.tv backgrounds/thumbs,
 * loaded SSR for the Artworks tab), so each row can at least get a DIFFERENT
 * image of the right show instead of the same one ten times.
 *
 * Deliberately pure and React-free: the episode API can't use it (it doesn't
 * load fanarts, and baking a choice into the shared 30-day Redis blob would
 * freeze one caller's fanart availability for everyone), so the pick happens
 * client-side where `info` and `fanarts` are already in hand.
 */

import type { FanartResponse } from "@/components/anime/v2/helpers";

/** Structural subset of AniListInfoTypes — keeps this module usable from the
 *  watch sidebar and tests without dragging the full info type in. */
export interface EpisodeImageInfo {
  bannerImage?: string | null;
  coverImage?: {
    extraLarge?: string | null;
    large?: string | null;
  } | null;
}

/* Scenery only. Posters are portrait and letterbox badly into a 16:9 thumb;
   banners are title-card art. Both stay in the Artworks tab where they belong. */
const LANDSCAPE_TYPES = new Set(["background", "thumb", "seasonthumb"]);

/* Textless art only — the OPPOSITE of helpers.ts's isAcceptableLang, which
   admits "en" because the hero WANTS a readable title logo. Here a titled
   image is the failure: fanart.tv's en-language thumbs are the show's logo
   over a flat backdrop, which sits in an episode row looking like a broken
   image next to real scene art. fanart.tv marks textless as "00" or blank. */
function isTextless(lang: string | null | undefined): boolean {
  return !lang || lang === "00";
}

/* Enough variety that no two adjacent rows repeat, without making a
   1100-episode show (One Piece) cycle through a hundred fanarts. */
const MAX_POOL = 24;

/**
 * Ordered, de-duplicated list of images usable as episode thumbnails.
 *
 * The AniList cover is a LAST resort: it's portrait key art, and
 * components/watch/secondary/episodeLists.tsx treats an `s4.anilist.co` URL as
 * proof that a list has no real stills. Feeding covers into the pool would trip
 * that check, so they only appear when the pool would otherwise be empty.
 */
export function buildEpisodeImagePool(
  info: EpisodeImageInfo,
  fanarts?: FanartResponse | null,
): string[] {
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    if (u && !out.includes(u)) out.push(u);
  };

  push(info.bannerImage);

  /* Collect every textless landscape artwork, best-liked first. Rows arrive
     ORDER BY type, likes DESC (lib/db/fanarts.ts), so re-sort across types to
     keep the ranking global — otherwise all backgrounds would outrank a
     better-liked thumb purely on alphabetical type order. */
  const art: Array<{ url: string; likes: number }> = [];
  for (const [type, items] of Object.entries(fanarts?.types ?? {})) {
    if (!LANDSCAPE_TYPES.has(type)) continue;
    for (const it of items) {
      if (isTextless(it.language)) art.push({ url: it.url, likes: it.likes });
    }
  }
  art.sort((a, b) => b.likes - a.likes);
  for (const a of art) push(a.url);

  if (out.length === 0) {
    push(info.coverImage?.extraLarge);
    push(info.coverImage?.large);
  }

  return out.slice(0, MAX_POOL);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Pick this episode's image from the pool. Pure in `episodeNumber` — the same
 * episode always gets the same image, across renders, reloads and SSR/hydration.
 *
 * Do NOT reach for helpers.ts's `shuffle()` here: it's Math.random()-based
 * (correct for the hero's clearart cycle, fatal here — thumbs would swap on
 * every render and break hydration).
 *
 * Walks the pool by a stride coprime to its length, which is a full-cycle
 * permutation: every image is used once before any repeats, and no two
 * adjacent episodes collide. A hash-and-modulo was tried first and measurably
 * lost — over 24 episodes it reused just 9 of 24 images, and over 12 episodes
 * with 3 images it repeated adjacent rows 7 times. Coprimality is what makes
 * the cycle full; without it the stride lands in a short orbit (stride 2 over
 * 4 images only ever visits 2).
 */
export function pickEpisodeImage(
  pool: string[],
  episodeNumber: number,
): string | null {
  const size = pool.length;
  if (size === 0) return null;
  if (size === 1) return pool[0];

  // ~golden-ratio stride: spreads consecutive episodes far apart in the pool
  // so neighbouring thumbs look unrelated. Step down to the nearest coprime.
  let stride = Math.floor(size * 0.618) || 1;
  while (stride > 1 && gcd(stride, size) !== 1) stride--;

  // episodeNumber is 1-based; episode 1 should land on the best image (the
  // pool is likes-ordered), so offset before striding.
  const idx = ((episodeNumber - 1) * stride) % size;
  return pool[((idx % size) + size) % size]; // guard negatives (ep 0 / specials)
}
