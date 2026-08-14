import type { NextApiRequest, NextApiResponse } from "next";
import { getMediaMeta } from "@/lib/anilist/getMediaMeta";
import { setEdgeCache } from "@/lib/http/edgeCache";
import { getTmdbAnimeImages } from "@/lib/tmdb/animeImages";
import { resolveHeroBanner } from "@/lib/images/heroBanner";
import { youtubeTrailerId } from "@/lib/preview/trailerId";

/**
 * GET /api/v2/preview/[id]
 *
 * The slim payload behind the hover preview card (components/shared/
 * HoverPreview). One hover = one request, so this endpoint is designed to
 * almost never reach the function:
 *
 *   - the response is anonymous and identical for every visitor, so it carries
 *     a 24 h edge TTL (see lib/http/edgeCache) — a warm id is served by the CDN
 *     and costs neither a Vercel invocation nor an Upstash command;
 *   - it strips the FULL_MEDIA payload down to what the card actually paints
 *     (~1 KB instead of ~40 KB), because hover traffic is bursty and every byte
 *     is multiplied by "user swept the mouse across a carousel";
 *   - `getMediaMeta` is the shared three-layer cache, so a cold id here also
 *     warms the info page and vice versa.
 *
 * Never include per-user fields (mediaListEntry, isFavourite) — they would make
 * the response unshareable and kill the edge cache. The card's list/queue state
 * is read client-side from the local stores instead.
 */

const TTL_S = 24 * 60 * 60;
/** Comfortably past the four lines the card clamps to; caps the payload. */
const DESC_MAX = 600;

/**
 * AniList's `asHtml: false` description still carries <br>, <i> and entities.
 * The trailing "(Source: …)" / "Notes: …" blocks are stripped for the same
 * reason Hayase's `desc()` strips them: on a four-line clamp they are pure
 * noise, and they are often the only thing that fits.
 */
function plainText(raw?: string | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n?\(?Source: [^)]+\)?\n?/m, "")
    .replace(/\n?Notes?:[ |\n][^\n]+\n?/m, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length <= DESC_MAX ? text : text.slice(0, DESC_MAX).replace(/\s+\S*$/, "");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Number(req.query.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "Missing or invalid id" });
  }

  let media: any = null;
  try {
    media = await getMediaMeta(id);
  } catch {
    /* treated as a miss below */
  }

  if (!media) {
    // Short window only: a miss is usually AniList being unreachable, not a
    // permanently unknown id, and we don't want to pin that at the edge for a day.
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(404).json({ error: "Anime not found" });
  }

  // The SAME banner the info page will show, resolved by the SAME function —
  // otherwise a title whose AniList banner the info page swaps for a TMDB
  // backdrop appears as two different pictures depending on where you look.
  // Both lookups are themselves cached (Turso row for TMDB, 24 h at the edge for
  // this response), so a warm id costs neither.
  const tmdb = await getTmdbAnimeImages(id).catch(() => ({ backdrop: null, logo: null }));
  const bannerImage = await resolveHeroBanner(media.bannerImage, tmdb.backdrop).catch(
    () => media.bannerImage ?? null,
  );

  // YouTube is the only site we can embed; AniList also returns dailymotion
  // entries, which the card has no player for. The id is cleaned here rather
  // than at each use — see youtubeTrailerId for the trailing tab that made a
  // card sit on a black frame.
  const trailerId =
    media.trailer?.site === "youtube" ? youtubeTrailerId(media.trailer?.id) : null;
  const rawTrailer = trailerId ? { id: trailerId } : null;

  /*
   * NO PLAYABILITY CHECK ANY MORE, and removing it is the point.
   *
   * This used to ask our Cloudflare Worker `/w/trailer/<id>.json` whether the
   * video was deleted, private or region-blocked, so the card would never mount
   * a trailer it could not play. That made sense when the card played PROXIED
   * bytes: the failure was ours, it was noisy, and it came from an endpoint we
   * were already paying for.
   *
   * None of that is true now. The card plays YouTube's own embed, which reports
   * its own failure through `onError` — YouTube's answer about this visitor's
   * region rather than ours about a datacentre's. So the check bought nothing,
   * while costing a blocking round trip to the Worker (up to 1.2 s of Vercel
   * function time) on every payload that missed the edge cache — for a verdict
   * nobody read. Worse, the endpoint it called has since been deleted from the
   * Worker's source, so once that Worker is redeployed this would have been a
   * round trip to a 404.
   *
   * The trailer path is now entirely YouTube's: the embed loads from
   * youtube-nocookie, the bar detection reads i.ytimg, and neither touches
   * anything of ours.
   */
  const trailer = rawTrailer;

  setEdgeCache(res, TTL_S);
  return res.status(200).json({
    id: media.id,
    title: media.title ?? null,
    coverImage: media.coverImage
      ? { large: media.coverImage.large ?? null, color: media.coverImage.color ?? null }
      : null,
    bannerImage,
    description: plainText(media.description),
    format: media.format ?? null,
    status: media.status ?? null,
    episodes: media.episodes ?? null,
    duration: media.duration ?? null,
    season: media.season ?? null,
    seasonYear: media.seasonYear ?? null,
    averageScore: media.averageScore ?? null,
    // The card's meta row is the info page's, so it needs the info page's
    // numbers. All of these already ride along in FULL_MEDIA_QUERY — the
    // payload simply never forwarded them, and the card was showing a thinner
    // set of facts than the page it previews.
    favourites: media.favourites ?? null,
    genres: Array.isArray(media.genres) ? media.genres.slice(0, 4) : [],
    // Main studios first, then producers as a stand-in — the same fallback the
    // Hero applies, resolved here so the card doesn't carry the whole edge list.
    studios: (() => {
      const edges = media.studios?.edges || [];
      const main = edges.filter((e: any) => e?.isMain).map((e: any) => e?.node?.name);
      const rest = edges.filter((e: any) => !e?.isMain).map((e: any) => e?.node?.name);
      return [...main, ...rest].filter(Boolean).slice(0, 2);
    })(),
    // Same derivation as InfoPage: the all-time RATED ranking, or nothing.
    ratingRank:
      (media.rankings || []).find((r: any) => r?.type === "RATED" && r?.allTime)?.rank ?? null,
    nextAiringEpisode: media.nextAiringEpisode
      ? {
          episode: media.nextAiringEpisode.episode ?? null,
          timeUntilAiring: media.nextAiringEpisode.timeUntilAiring ?? null,
        }
      : null,
    trailer,
  });
}
