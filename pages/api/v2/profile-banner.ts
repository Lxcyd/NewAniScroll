import type { NextApiRequest, NextApiResponse } from "next";
import { getMediaMeta } from "@/lib/anilist/getMediaMeta";
import { resolveProfileBanner } from "@/lib/profile/banner";

/**
 * GET /api/v2/profile-banner?anime=<anilist_id>
 *
 * Every wide artwork available for one anime, best first, plus the two Media
 * fields a profile needs about it: its title and its `meanScore` — the last
 * tie-break when several titles are equally the viewer's favourite
 * (lib/profile/favorite.ts).
 *
 * Shared and identical for everyone, so it is edge-cacheable: the /me profile
 * (no SSR, everything client-side) resolves its banner through here, and the
 * banner picker on a public profile reads its gallery from the same response
 * rather than paying a second round-trip.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const animeId = Number(req.query.anime);
  if (!Number.isFinite(animeId)) {
    return res.status(400).json({ error: "Missing or invalid `anime`" });
  }

  const media = await getMediaMeta(animeId).catch(() => null);
  if (!media) {
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(404).json({ error: "Anime not found" });
  }

  const title =
    media.title?.english || media.title?.romaji || media.title?.native || null;
  const { banner, options } = await resolveProfileBanner({
    id: animeId,
    title,
    bannerImage: media.bannerImage,
    coverImage: media.coverImage?.extraLarge || media.coverImage?.large || null,
  });

  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader(
    "CDN-Cache-Control",
    "public, s-maxage=21600, stale-while-revalidate=86400",
  );
  return res.status(200).json({
    animeId,
    title,
    meanScore: media.meanScore ?? media.averageScore ?? null,
    coverImage: media.coverImage?.large || null,
    banner,
    // The picker never shows more than a couple of screens' worth, and One
    // Piece has 200+ rows: cap the payload rather than the component.
    options: options.slice(0, 24),
  });
}
