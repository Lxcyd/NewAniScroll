/**
 * Picking the right SIZE of an AniList cover.
 *
 * `next.config.js` sets `images.unoptimized: true` — deliberately, so we never
 * pay Vercel per image transformation. The consequence is that whatever URL we
 * hand <Image> is exactly what the browser downloads and decodes; there is no
 * resizing safety net. Almost every caller was reaching for `coverImage
 * .extraLarge`, including the poster grids, so a 150 px-wide card was pulling
 * a 460×636 / 84 kB JPEG. Measured on the same title:
 *
 *   extraLarge  460×636   83.8 kB     (AniList path segment: /cover/large/)
 *   large       230×318   28.8 kB     (                      /cover/medium/)
 *   medium      100×138    9.7 kB     (                      /cover/small/)
 *
 * On a home page of ~60 posters that is ~5 MB and ~18 Mpx of decode versus
 * ~1.7 MB and ~4 Mpx — which is what makes scrolling a poster grid stutter on
 * a phone, long before any JS is involved.
 *
 * The three variants differ ONLY by that path segment, so we can derive the
 * smaller URL from whichever one we were given. That matters because several
 * GraphQL queries (the whole homepage batch, getUpcomingAnime) request only
 * `extraLarge` — deriving means no query change and no extra payload.
 *
 * Anything that isn't an AniList cover URL is returned untouched.
 */

export type CoverImage = {
  extraLarge?: string | null;
  large?: string | null;
  medium?: string | null;
  color?: string | null;
} | null;

/** What the image is displayed AT, not what AniList calls it. */
export type CoverSize =
  /** Poster grids / carousel cards, up to ~200 CSS px wide. */
  | "card"
  /** Hero posters, info-page cover, anything rendered large or full-bleed. */
  | "full"
  /** Avatar-sized chips and inline rows, under ~60 CSS px. */
  | "tiny";

const ANILIST_COVER = /^(https:\/\/[^/]*anilist\.co\/.*\/cover\/)(large|medium|small)(\/.*)$/;

const SEGMENT: Record<CoverSize, "large" | "medium" | "small"> = {
  full: "large",
  card: "medium",
  tiny: "small",
};

/** Rewrite an AniList cover URL to another size, or return it unchanged. */
function atSegment(url: string, size: CoverSize): string {
  const m = ANILIST_COVER.exec(url);
  if (!m) return url;
  return `${m[1]}${SEGMENT[size]}${m[3]}`;
}

/**
 * The URL to render for a cover at a given display size.
 *
 * Accepts the AniList `coverImage` object OR a bare URL string (several
 * components and the local list store keep only a flattened URL), so callers
 * no longer need their own `extraLarge || large || image` ladder.
 */
export function coverUrl(
  cover: CoverImage | string | undefined,
  size: CoverSize = "card",
): string | null {
  if (!cover) return null;
  if (typeof cover === "string") return cover ? atSegment(cover, size) : null;

  // Prefer the field AniList already gives us at the wanted size; otherwise
  // derive it from whichever field is populated.
  const exact =
    size === "full" ? cover.extraLarge : size === "card" ? cover.large : cover.medium;
  if (exact) return exact;

  const any = cover.extraLarge || cover.large || cover.medium;
  return any ? atSegment(any, size) : null;
}
