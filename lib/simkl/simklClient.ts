/**
 * Simkl client — per-episode stills.
 *
 * Why Simkl replaced TMDB here: Simkl's id (from Fribb's `simkl_id`) indexes
 * the SAME entry AniList does, not the franchise. So there is no season to
 * guess — the exact problem that forced the old TMDB path to refuse long sagas
 * (One Piece has no `tmdb_season` at all) and split cours, and to carry a
 * mapping, a validation and an API key to do it. Measured on the live API:
 * One Piece 1170 stills / 1172 episodes, Naruto 220/220, AoT S1 25/25, all
 * distinct real frames.
 *
 * Simkl requires a client_id (free; the app dashboard states the required
 * query params and User-Agent). Keyless calls happen to answer today, but we
 * always send credentials — relying on an unintended path would break silently.
 *
 * Terms: free for services under $150/month revenue. Attribution expected.
 *
 * Everything degrades to null; nothing throws. Without SIMKL_CLIENT_ID the
 * feature is simply off and rows fall back to the fanart pool
 * (lib/images/episodeImagePool.ts).
 */

const SIMKL_BASE = "https://api.simkl.com";
const SIMKL_IMAGE_BASE = "https://simkl.in/episodes/";

const APP_NAME = "aniscroll";
const APP_VERSION = "1.0";
const USER_AGENT = "AniScroll/1.0 (+https://aniscroll.com)";

export interface SimklEpisode {
  /** Simkl's own episode number — 1-based within this entry. */
  episode: number;
  /** "episode" | "special" — specials must be dropped, they inflate the count
   *  (AoT S1: 40 rows = 25 episodes + 15 specials). */
  type: string;
  /** Image path fragment ("25/25394007d88600051"), not a URL. */
  img: string | null;
  title: string | null;
}

export function simklEnabled(): boolean {
  return !!process.env.SIMKL_CLIENT_ID;
}

let warnedNoKey = false;
function warnNoKeyOnce(): void {
  if (warnedNoKey) return;
  warnedNoKey = true;
  console.warn("[simkl] SIMKL_CLIENT_ID unset — per-episode stills disabled.");
}

/**
 * Episodes for one Simkl id, or null on any failure.
 *
 * `transient` isn't modelled here because the caller treats a null as "don't
 * cache a refusal" — see lib/simkl/episodeStills.ts.
 */
export async function getSimklEpisodes(
  simklId: number,
): Promise<SimklEpisode[] | null> {
  const clientId = process.env.SIMKL_CLIENT_ID;
  if (!clientId) {
    warnNoKeyOnce();
    return null;
  }

  // The dashboard requires all three params on every request.
  const url =
    `${SIMKL_BASE}/anime/episodes/${simklId}` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&app-name=${APP_NAME}&app-version=${APP_VERSION}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const json = await res.json();
    if (!Array.isArray(json)) return null;

    return json
      .map((e: any) => ({
        episode: Number(e?.episode),
        type: String(e?.type ?? ""),
        img: typeof e?.img === "string" ? e.img : null,
        title: e?.title ?? null,
      }))
      .filter((e: SimklEpisode) => Number.isFinite(e.episode));
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Full URL for a Simkl `img` fragment.
 *
 * Variants verified live: `_w` (wide, ~40-55 KB — what an episode row wants),
 * `_m` (~3 KB, too small), `_c` (cover crop). No suffix 404s.
 */
export function simklStillUrl(
  img: string | null,
  variant: "_w" | "_m" | "_c" = "_w",
): string | null {
  if (!img) return null;
  return `${SIMKL_IMAGE_BASE}${img}${variant}.jpg`;
}
