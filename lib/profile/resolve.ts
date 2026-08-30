/**
 * Server side of the "favourite anime → banner" chain.
 *
 * Two lookups are deliberately lazy, because both cost an AniList/Turso round
 * trip and neither is needed most of the time:
 *
 *   - `meanScore` is the FOURTH criterion. It only matters for entries still
 *     tied on score, favourite and rewatches, so it is fetched for that head
 *     group alone (lib/profile/favorite.tiedHead) and not for the list.
 *   - the artwork of the winner is fetched once, for the winner.
 *
 * A profile read from AniList already carries both fields on its entries and
 * takes neither path — the map passed in short-circuits everything.
 */

import { getMediaMeta } from "@/lib/anilist/getMediaMeta";
import { pickFavorite, tiedHead, type FavoriteCandidate } from "./favorite";
import { resolveProfileBanner, type MediaArt, type ProfileBanner, type BannerOption } from "./banner";

export type KnownArt = MediaArt & { meanScore?: number | null };

async function artOf(id: number, known?: KnownArt): Promise<KnownArt | null> {
  if (known?.bannerImage || known?.coverImage) return known;
  const media = await getMediaMeta(id).catch(() => null);
  if (!media) return known ?? null;
  return {
    id,
    title:
      media.title?.english || media.title?.romaji || media.title?.native || null,
    bannerImage: media.bannerImage ?? null,
    coverImage: media.coverImage?.extraLarge || media.coverImage?.large || null,
    meanScore: media.meanScore ?? media.averageScore ?? null,
  };
}

export async function resolveFavoriteBanner(
  candidates: FavoriteCandidate[],
  known: Map<number, KnownArt>,
): Promise<{
  banner: ProfileBanner;
  options: BannerOption[];
  favorite: FavoriteCandidate | null;
}> {
  if (candidates.length === 0) {
    const empty = await resolveProfileBanner(null);
    return { ...empty, favorite: null };
  }

  // Criterion 4, only where it can still change the answer.
  const tied = tiedHead(candidates);
  if (tied.length > 1) {
    await Promise.all(
      tied.map(async (c) => {
        if (c.meanScore != null) return;
        const fromMap = known.get(c.mediaId)?.meanScore;
        if (fromMap != null) {
          c.meanScore = fromMap;
          return;
        }
        const art = await artOf(c.mediaId, known.get(c.mediaId));
        if (art) {
          known.set(c.mediaId, art);
          c.meanScore = art.meanScore ?? null;
        }
      }),
    );
  }

  const favorite = pickFavorite(candidates);
  if (!favorite) {
    const empty = await resolveProfileBanner(null);
    return { ...empty, favorite: null };
  }

  const art = await artOf(favorite.mediaId, known.get(favorite.mediaId));
  const resolved = await resolveProfileBanner(art ?? { id: favorite.mediaId });
  return { ...resolved, favorite };
}
