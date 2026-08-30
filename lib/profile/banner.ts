/**
 * The wide artwork a profile wears, taken from the illustrations of the
 * viewer's favourite anime (lib/profile/favorite.ts picks which anime).
 *
 * "Une banniere populaire dans les illustrations de l'anime" — so the source is
 * the fanart.tv library we already mirror (lib/db/fanarts.ts), ordered by
 * likes. Types, in the order they are tried:
 *
 *   background — 1920x1080, the only type actually drawn as a wide plate;
 *   thumb      — 1000x562, same aspect, the usual filler when no background;
 *   AniList's bannerImage — the show's own chosen wide art, 1900x400;
 *   banner     — 1000x185 fanart banners, thin but wide;
 *   the cover  — last resort, and the caller blurs it (a portrait stretched
 *                across a hero band is the worst-looking case of all, which is
 *                the same reasoning as lib/images/heroBanner.ts).
 *
 * Everything the picker offers comes out of the same call, so opening "change
 * the banner" costs no extra request: `options` is the full ordered gallery and
 * `banner` is simply its first row.
 */

import { loadFanarts } from "@/lib/db/fanarts";
import { isAcceptableLang } from "@/components/anime/v2/helpers";
import type { BannerOption } from "./types";

export type { BannerOption } from "./types";
export { plateMode } from "./types";

export type ProfileBanner = {
  animeId: number | null;
  title: string | null;
  url: string | null;
  source: BannerOption["source"] | null;
  /** Blur + zoom the plate: it is a portrait cover, not a wide artwork. */
  fallback: boolean;
};

/** Order fanart types by how well they fill a hero band. */
const WIDE_TYPES: Array<BannerOption["source"]> = ["background", "thumb", "banner"];

export type MediaArt = {
  id: number;
  title?: string | null;
  bannerImage?: string | null;
  coverImage?: string | null;
};

/**
 * Every wide artwork available for one anime, best first.
 * Never throws: a fanart DB that is down simply yields the AniList banner.
 */
export async function bannerOptions(media: MediaArt): Promise<BannerOption[]> {
  const out: BannerOption[] = [];
  const fanarts = await loadFanarts(media.id).catch(() => null);

  for (const type of WIDE_TYPES) {
    const rows = (fanarts?.types?.[type] || []).filter((r) =>
      isAcceptableLang(r.language),
    );
    // loadFanarts already returns each type likes-desc; keep that order.
    for (const r of rows) out.push({ url: r.url, source: type, likes: r.likes || 0 });
  }

  // AniList's own banner sits after the backgrounds but before the thin
  // fanart banners — it is the show's chosen art, but it is not what the user
  // asked to see first.
  if (media.bannerImage) {
    const firstThin = out.findIndex((o) => o.source === "banner");
    const entry: BannerOption = { url: media.bannerImage, source: "anilist", likes: 0 };
    if (firstThin === -1) out.push(entry);
    else out.splice(firstThin, 0, entry);
  }

  if (media.coverImage) {
    out.push({ url: media.coverImage, source: "cover", likes: 0 });
  }

  // The same picture can be both AniList's banner and a mirrored fanart.
  const seen = new Set<string>();
  return out.filter((o) => (seen.has(o.url) ? false : (seen.add(o.url), true)));
}

export async function resolveProfileBanner(
  media: MediaArt | null,
): Promise<{ banner: ProfileBanner; options: BannerOption[] }> {
  if (!media) {
    return {
      banner: { animeId: null, title: null, url: null, source: null, fallback: false },
      options: [],
    };
  }
  const options = await bannerOptions(media);
  const best = options[0] || null;
  return {
    banner: {
      animeId: media.id,
      title: media.title ?? null,
      url: best?.url ?? null,
      source: best?.source ?? null,
      fallback: best?.source === "cover",
    },
    options,
  };
}

/**
 * Hosts a stored banner override is allowed to point at. The value is written
 * by the owner and then served to every visitor of the profile, so it is an
 * arbitrary-URL field on a public page: without this it would render whatever
 * third-party image (or tracker) the request body carried.
 */
const ALLOWED_HOSTS = [
  "assets.fanart.tv",
  "fanart-proxy.aniscroll.com",
  "s4.anilist.co",
  "img.anili.st",
  "image.tmdb.org",
  "media.kitsu.io",
  "media.kitsu.app",
];

export function isAllowedBannerUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 500) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}
