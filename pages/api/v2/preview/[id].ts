import type { NextApiRequest, NextApiResponse } from "next";
import { getMediaMeta } from "@/lib/anilist/getMediaMeta";
import { setEdgeCache } from "@/lib/http/edgeCache";

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
/** Long enough for three clamped lines at the card's width. */
const DESC_MAX = 360;

/** AniList's `asHtml: false` description still carries <br>, <i> and entities. */
function plainText(raw?: string | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length <= DESC_MAX) return text;
  return text.slice(0, DESC_MAX).replace(/\s+\S*$/, "") + "…";
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

  // YouTube is the only site we can embed; AniList also returns dailymotion
  // entries, which the card has no player for.
  const trailer =
    media.trailer?.site === "youtube" && media.trailer?.id
      ? { id: String(media.trailer.id) }
      : null;

  setEdgeCache(res, TTL_S);
  return res.status(200).json({
    id: media.id,
    title: media.title ?? null,
    coverImage: media.coverImage
      ? { large: media.coverImage.large ?? null, color: media.coverImage.color ?? null }
      : null,
    bannerImage: media.bannerImage ?? null,
    description: plainText(media.description),
    format: media.format ?? null,
    status: media.status ?? null,
    episodes: media.episodes ?? null,
    duration: media.duration ?? null,
    season: media.season ?? null,
    seasonYear: media.seasonYear ?? null,
    averageScore: media.averageScore ?? null,
    nextAiringEpisode: media.nextAiringEpisode
      ? {
          episode: media.nextAiringEpisode.episode ?? null,
          timeUntilAiring: media.nextAiringEpisode.timeUntilAiring ?? null,
        }
      : null,
    trailer,
  });
}
