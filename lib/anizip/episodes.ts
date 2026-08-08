/**
 * ani.zip — per-episode stills and titles, keyed on the AniList id directly.
 *
 * This is the source Hayase actually uses for episode thumbnails. Their app
 * calls `hayase.ani.zip/v1/episodes?anilist_id=…` (their own Cloudflare-fronted
 * mirror, which refuses third-party callers); the public endpoint behind it is
 * `api.ani.zip`, same payload, no key, no account.
 *
 * WHY IT GOES FIRST, ahead of Simkl and TMDB. It is keyed on the **AniList id**,
 * so like Simkl it has no season to infer — but unlike Simkl it needs no id
 * mapping at all. Fribb's coverage is the recurring failure in this codebase
 * (34% of entries carry a `simkl_id`; a 2026 sequel routinely has no `tmdb.tv`
 * either — measured on Hell Mode S2, AniList 209983, whose Fribb row is all
 * nulls). ani.zip has nothing to miss: the AniList id IS the key.
 *
 * The images are TVDB screencaps (`artworks.thetvdb.com/banners/v4/episode/…`)
 * — real frames of the episode, which is exactly what Simkl and TMDB also
 * provide, so the three are interchangeable in kind and only differ in
 * coverage. Verified against Hayase's own rendering on AniList 199748: same
 * frames, same order.
 *
 * It also returns real episode TITLES, which matters as much as the images on
 * an airing show — AniList's `streamingEpisodes` serves the franchise's
 * season-1 list on every sequel entry, so we can't use it.
 *
 * Fail-soft: nothing throws, everything degrades to empty and the next
 * provider in the chain gets its turn.
 */

import {
  getCachedStills,
  setCachedStills,
  type StillsCacheValue,
} from "@/lib/db/tmdbStillsCache";

const ANIZIP_BASE = "https://api.ani.zip";
const TIMEOUT_MS = 5000;

/* ani.zip sits behind Cloudflare and answers 403 to a default fetch UA. A
   browser-shaped User-Agent is what makes it respond — same reason
   lib/simkl/simklClient.ts sends one. */
const USER_AGENT =
  "Mozilla/5.0 (compatible; AniScroll/1.0; +https://aniscroll.com)";

export interface AniZipEpisodeData {
  /** episode number → still URL. */
  stills: Record<number, string>;
  /** episode number → English title. */
  titles: Record<number, string>;
}

const EMPTY: AniZipEpisodeData = { stills: {}, titles: {} };

type Reason =
  | "ok"
  | "unknown-episode-count"
  | "no-episodes"
  | "no-images"
  | "anizip-error";

/** Raw episode record — only the fields we read. */
interface RawEpisode {
  image?: string | null;
  title?: Record<string, string> | null;
}

interface RawResponse {
  episodes?: Record<string, RawEpisode> | null;
  episodeCount?: number;
}

/**
 * Stills + titles for an AniList id: cache → fetch → cache.
 *
 * `displayedEpisodes` bounds what we keep, exactly as the Simkl path does —
 * ani.zip runs ahead on airing shows and we only ever render the numbers we
 * actually show.
 */
export async function getAniZipEpisodes(
  anilistId: number,
  displayedEpisodes: number | null,
): Promise<AniZipEpisodeData> {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return EMPTY;

  const cached = await getCachedStills(anilistId, "anizip");
  if (cached) {
    return { stills: cached.stills ?? {}, titles: cached.titles ?? {} };
  }

  const refuse = async (reason: Reason): Promise<AniZipEpisodeData> => {
    // A transient failure must never be cached as "no stills" — it would stick
    // for a day over one timeout.
    if (reason !== "anizip-error") {
      const value: StillsCacheValue = {
        stills: {},
        reason,
        tvId: null,
        season: null,
      };
      await setCachedStills(anilistId, value, "anizip");
    }
    // warn, not info: Vercel's log stream drops console.info, and "this title
    // shows placeholder tiles" is the symptom we get asked about.
    console.warn(`[anizip] ${anilistId}: no stills (${reason})`);
    return EMPTY;
  };

  if (!displayedEpisodes || displayedEpisodes <= 0) {
    return await refuse("unknown-episode-count");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let data: RawResponse | null = null;
  try {
    const res = await fetch(
      `${ANIZIP_BASE}/v1/episodes?anilist_id=${anilistId}`,
      {
        signal: ctrl.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      },
    );
    // 404 means "not in the mapping" — a real answer, and cacheable as one.
    if (res.status === 404) return await refuse("no-episodes");
    if (!res.ok) {
      console.warn(`[anizip] ${anilistId}: HTTP ${res.status}`);
      return await refuse("anizip-error");
    }
    data = (await res.json()) as RawResponse;
  } catch (e: any) {
    console.warn(`[anizip] ${anilistId}: ${e?.message ?? e}`);
    return await refuse("anizip-error");
  } finally {
    clearTimeout(timer);
  }

  const raw = data?.episodes;
  if (!raw || typeof raw !== "object") return await refuse("no-episodes");

  const stills: Record<number, string> = {};
  const titles: Record<number, string> = {};

  for (const [key, ep] of Object.entries(raw)) {
    /* Keys are episode numbers as strings, but specials appear as "S1", "S2"
       — Number("S1") is NaN, which is what filters them out. They'd otherwise
       collide with real episode numbers, the same trap the Simkl path handles
       by dropping `type: "special"`. */
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1 || n > displayedEpisodes) continue;

    if (ep?.image) stills[n] = ep.image;

    /* `title` is a per-language map. English only: the rest are Japanese or
       romaji and would sit untranslated in a French or English UI. An untitled
       episode is labelled "Episode N" upstream, which is exactly what the
       caller already falls back to — keeping it would fake a real title. */
    const en = ep?.title?.en;
    const t = typeof en === "string" ? en.trim() : "";
    if (t && !/^episode\s+\d+$/i.test(t)) titles[n] = t;
  }

  const count = Object.keys(stills).length;
  if (count === 0) return await refuse("no-images");

  await setCachedStills(
    anilistId,
    { stills, titles, reason: "ok", tvId: null, season: null },
    "anizip",
  );
  console.warn(
    `[anizip] ${anilistId}: ${count}/${displayedEpisodes} stills, ` +
      `${Object.keys(titles).length} titles`,
  );
  return { stills, titles };
}
