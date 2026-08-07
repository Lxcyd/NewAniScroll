// Standalone AniSkip prefetch + shared cache.
//
// Lives outside SkipOverlay.tsx on purpose: the watch page imports this to
// warm the cache the moment malId/episode are known, and SkipOverlay is a
// dynamic/ssr:false chunk that pulls in @vidstack/react. Importing the
// prefetch from SkipOverlay statically would drag Vidstack into the page
// bundle and defeat the code-split (and risk SSR/hydration issues from the
// Web Components). Keeping it dependency-free here avoids all that.

export type Skip = { start: number; end: number; type: string };

// Module-level memo so changing servers (which remounts the player and
// therefore SkipOverlay) doesn't refetch the same episode. The discriminator is
// the ACTIVE SERVER id when known, else the lang: our own detector now stores
// PER-HOST rows because the OP's absolute start is encode-specific (SnK ep1 OP
// is 2:02 on sibnet, 2:19 on megaplay), so two servers must not share a cache
// entry. Falling back to lang keeps the crowdsourced path (server-agnostic)
// deduped as before.
export const SKIP_MEMO = new Map<string, Skip[]>();
// `len` discriminates the entry because the ANSWER depends on it: the API now
// only returns crowdsourced timings whose own rip matches the duration we sent
// (see CUT_TOLERANCE_S in lib/skip/providers.ts). The first call fires without
// a duration to keep the pills instant; the second, once the player reports
// one, is a DIFFERENT question and must not be served the first one's memo.
export const skipMemoKey = (
  mal: number,
  ep: number,
  disc = "vostfr",
  len = 0,
) => `${mal}:${ep}:${disc}${len > 0 ? `:${Math.round(len)}` : ""}`;

// In-flight requests, so the watch page's eager prefetch and SkipOverlay's
// own fetch don't both hit the network for the same episode — the second
// caller awaits the first.
const SKIP_INFLIGHT = new Map<string, Promise<Skip[]>>();

/**
 * Fetch AniSkip data for an episode and cache it in SKIP_MEMO. Safe to call
 * eagerly from the watch page the moment malId/episode are known — well before
 * the (dynamically-imported) player and SkipOverlay have mounted — so the data
 * is already warm when the overlay reads it. Returns the kept skips.
 */
export async function prefetchSkips(
  malId?: number | null,
  episode?: number | null,
  aniListId?: number | null,
  opts?: { lang?: string; episodeLength?: number; server?: string },
): Promise<Skip[]> {
  if (!malId || !episode) return [];
  const lang = opts?.lang || "vostfr";
  const server = opts?.server || null;
  // Server (when known) discriminates the cache AND is sent to the API so it can
  // return that exact encode's per-host OP/ED; without it we key by lang and the
  // API falls back to the reconciled/crowdsourced answer.
  const key = skipMemoKey(malId, episode, server || lang, opts?.episodeLength || 0);
  const cached = SKIP_MEMO.get(key);
  if (cached) return cached;
  const inflight = SKIP_INFLIGHT.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const params = new URLSearchParams();
      if (aniListId) params.set("aniListId", String(aniListId));
      params.set("lang", lang);
      if (server) params.set("server", server);
      // episodeLength re-projects our own detector's ED onto this encode AND
      // selects which crowdsourced submission is admissible — AniSkip holds
      // several per episode, each timed against a different rip. Absent, the
      // API can only return submissions that agree with each other on a cut;
      // it will never mix two. Send it as soon as the player knows it.
      if (opts?.episodeLength && opts.episodeLength > 0) {
        params.set("episodeLength", String(Math.round(opts.episodeLength)));
      }
      const res = await fetch(`/api/v2/skip/${malId}/${episode}?${params.toString()}`);
      if (!res.ok) return [];
      const json = await res.json();
      const arr: Skip[] = Array.isArray(json?.skips) ? json.skips : [];
      SKIP_MEMO.set(key, arr);
      return arr;
    } catch {
      return [];
    } finally {
      SKIP_INFLIGHT.delete(key);
    }
  })();
  SKIP_INFLIGHT.set(key, p);
  return p;
}
