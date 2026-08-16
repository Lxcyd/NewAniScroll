/**
 * ani.zip mappings — AniList id → TMDB / TVDB, when Fribb doesn't know.
 *
 * Fribb is a static file regenerated periodically, and its blind spot is
 * systematic rather than random: it lags NEW entries. That is precisely the
 * set of titles the homepage hero features, so the gap landed on the most
 * visible surface of the site. Two measurements, 2026-08-08:
 *
 *   Chainsmoker Cat  (AniList 207141) — Fribb: no tmdb id at all.
 *                                       ani.zip: themoviedb_id 312949.
 *   Hell Mode S2     (AniList 209983) — Fribb: row entirely null.
 *                                       ani.zip: themoviedb_id 280049.
 *
 * TMDB had the artwork for both the whole time; nobody could tell us which
 * record to ask for. This is the same shape as `resolveSimklId()` in
 * lib/simkl/simklClient.ts — Fribb stays the fast path (one local row, no
 * network), and a live lookup rescues what it hasn't caught up with.
 *
 * ani.zip is keyed on the AniList id itself, which is what makes it able to
 * answer at all where a static cross-map can't.
 *
 * Fail-soft: null on anything unexpected, and the caller falls back to its
 * other strategies.
 */

const ANIZIP_BASE = "https://api.ani.zip";
const TIMEOUT_MS = 5000;

/* Cloudflare answers 403 to a default fetch UA — same reason
   lib/anizip/episodes.ts and lib/simkl/simklClient.ts send one. */
const USER_AGENT =
  "Mozilla/5.0 (compatible; AniScroll/1.0; +https://aniscroll.com)";

export interface AniZipMapping {
  /** TMDB *tv* id, when this entry is a series. */
  tmdbTvId: number | null;
  /** TMDB *movie* id, when it isn't. */
  tmdbMovieId: number | null;
  tvdbId: number | null;
}

const EMPTY: AniZipMapping = { tmdbTvId: null, tmdbMovieId: null, tvdbId: null };

function num(v: unknown): number | null {
  // ani.zip returns themoviedb_id as a STRING ("312949") and thetvdb_id as a
  // number, so both shapes have to survive this.
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Look up an AniList id. Never throws.
 *
 * Callers should treat this as the SECOND stop, after Fribb: it costs an HTTP
 * request, so it belongs behind a cache (the artwork path caches the resolved
 * result for 30 days, so a title pays this once).
 */
export async function getAniZipMapping(
  anilistId: number,
): Promise<AniZipMapping> {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return EMPTY;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${ANIZIP_BASE}/v1/mappings?anilist_id=${anilistId}`,
      {
        signal: ctrl.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      },
    );
    if (!res.ok) {
      // 404 just means it doesn't know this id — not worth a warning.
      if (res.status !== 404) {
        console.warn(`[anizip-map] ${anilistId}: HTTP ${res.status}`);
      }
      return EMPTY;
    }
    const d = (await res.json()) as Record<string, unknown>;
    const tmdb = num(d.themoviedb_id);

    /* `type` disambiguates which TMDB namespace that id lives in. A movie's
       id in the tv namespace resolves to an unrelated show, or to nothing —
       either way it must not be guessed. Anything that isn't clearly a series
       is treated as a movie id. */
    const type = String(d.type ?? "").toUpperCase();
    const isSeries = ["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"].includes(type);

    return {
      tmdbTvId: isSeries ? tmdb : null,
      tmdbMovieId: isSeries ? null : tmdb,
      tvdbId: num(d.thetvdb_id),
    };
  } catch (e: any) {
    console.warn(`[anizip-map] ${anilistId}: ${e?.message ?? e}`);
    return EMPTY;
  } finally {
    clearTimeout(timer);
  }
}
