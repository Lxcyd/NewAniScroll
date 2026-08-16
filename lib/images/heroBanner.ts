import { isBannerLowRes } from "@/lib/images/bannerSize";

/**
 * The wide artwork that represents an anime — AniList's banner WINS.
 *
 * User decision, 2026-08-08: TMDB backdrops belong to the home page's
 * recommendation hero and nowhere else. The AniList banner is the show's chosen
 * wide art and is what a page is meant to look like; a TMDB backdrop replaced it
 * with a different, often logo-baked, image.
 *
 * TWO exceptions, both requested:
 *   - no banner at all → the surface stretches the portrait cover across a wide
 *     band, which is the worst-looking case of all.
 *   - a banner that IS there but is genuinely low-resolution → measured, not
 *     guessed, by reading the pixel dimensions out of the image header with a
 *     ranged request (lib/images/bannerSize.ts). AniList's standard is 1900×400
 *     and 42 of the 50 most popular titles hit it exactly, so the few that come
 *     in at 1500×315 stand out and genuinely upscale.
 *
 * The probe only runs when there is something to swap TO: no TMDB backdrop means
 * no decision to make, so we skip the request entirely.
 *
 * This lives in lib/ rather than next to the info page because the hover preview
 * card must paint the SAME image. It used to hold its own chain (AniList banner,
 * then the YouTube trailer thumbnail, then the cover), which meant a title whose
 * banner the info page had swapped for a TMDB backdrop showed two different
 * pictures depending on where you looked at it.
 */
export async function resolveHeroBanner(
  bannerImage: string | null | undefined,
  tmdbBackdrop: string | null | undefined,
): Promise<string | null> {
  const banner = bannerImage || null;
  if (!banner) return tmdbBackdrop || null;
  if (!tmdbBackdrop) return banner;
  return (await isBannerLowRes(banner).catch(() => false)) ? tmdbBackdrop : banner;
}
