// Standalone AniSkip prefetch + shared cache.
//
// Lives outside SkipOverlay.tsx on purpose: the watch page imports this to
// warm the cache the moment malId/episode are known, and SkipOverlay is a
// dynamic/ssr:false chunk that pulls in @vidstack/react. Importing the
// prefetch from SkipOverlay statically would drag Vidstack into the page
// bundle and defeat the code-split (and risk SSR/hydration issues from the
// Web Components). Keeping it dependency-free here avoids all that.

import { serverToHost } from "@/lib/hostRegistry";

export type Skip = { start: number; end: number; type: string };

/* La reponse de /api/v2/skip en mode `hosts=1` : le minutage par defaut de la
   langue, plus celui de chaque hote que notre detecteur a mesure. */
type SkipResponse = { skips: Skip[]; hosts: Record<string, Skip[]> };
const RESP_MEMO = new Map<string, SkipResponse>();
const RESP_INFLIGHT = new Map<string, Promise<SkipResponse | null>>();

// Module-level memo so changing servers (which remounts the player and
// therefore SkipOverlay) doesn't refetch the same episode. The discriminator is
// the ACTIVE SERVER id when known, else the lang: our own detector now stores
// PER-HOST rows because the OP's absolute start is encode-specific (SnK ep1 OP
// is 2:02 on sibnet, 2:19 on megaplay), so two servers must not share a cache
// entry. Falling back to lang keeps the crowdsourced path (server-agnostic)
// deduped as before.
export const SKIP_MEMO = new Map<string, Skip[]>();
export const skipMemoKey = (mal: number, ep: number, disc = "vostfr") =>
  `${mal}:${ep}:${disc}`;

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
  const server = opts?.server || null;
  // The server pins both the encode (host) and the language — same mapping the
  // API's `?server=` mode applies. Unmapped server → the caller's lang.
  const mapped = server ? serverToHost(server) : null;
  const lang = mapped?.lang || opts?.lang || "vostfr";
  // SKIP_MEMO stays keyed per SERVER (SkipOverlay reads it that way): two
  // servers on different encodes must not share an OP start.
  const key = skipMemoKey(malId, episode, server || lang);
  const cached = SKIP_MEMO.get(key);
  if (cached) return cached;
  const inflight = SKIP_INFLIGHT.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const resp = await fetchSkipResponse(
        malId,
        episode,
        aniListId ?? null,
        lang,
        opts?.episodeLength,
      );
      if (!resp) return [];
      // The active host's own measurement when we have one, else the language's
      // default answer — the same arbitration the API used to make per server.
      const arr = (mapped && resp.hosts[mapped.host]) || resp.skips;
      SKIP_MEMO.set(key, arr);
      return arr;
    } finally {
      SKIP_INFLIGHT.delete(key);
    }
  })();
  SKIP_INFLIGHT.set(key, p);
  return p;
}

/**
 * ONE request per (episode, language), whatever the number of servers tried.
 *
 * The watch page walks through several `activeServer` values while it loads
 * (order guess, saved preference, confirmation, safety net, auto-fallback), and
 * each used to be its own `?server=` URL — its own CDN entry, its own cold
 * invocation, ~4 per page. The answer for every host of a language now comes
 * back at once, and picking the host's entry is done here.
 */
function fetchSkipResponse(
  malId: number,
  episode: number,
  aniListId: number | null,
  lang: string,
  episodeLength?: number,
): Promise<SkipResponse | null> {
  const len = episodeLength && episodeLength > 0 ? Math.round(episodeLength) : 0;
  const key = `${malId}:${episode}:${lang}:${len}`;
  const hit = RESP_MEMO.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = RESP_INFLIGHT.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const params = new URLSearchParams();
      if (aniListId) params.set("aniListId", String(aniListId));
      params.set("lang", lang);
      params.set("hosts", "1");
      // episodeLength lets the API re-project an ED onto this encode's real
      // duration (and is required by the AniSkip fallback). 0/absent is fine —
      // the API then serves the ED in its canonical duration.
      if (len) params.set("episodeLength", String(len));
      const res = await fetch(`/api/v2/skip/${malId}/${episode}?${params.toString()}`);
      if (!res.ok) return null;
      const json = await res.json();
      const resp: SkipResponse = {
        skips: Array.isArray(json?.skips) ? json.skips : [],
        hosts: json?.hosts && typeof json.hosts === "object" ? json.hosts : {},
      };
      RESP_MEMO.set(key, resp);
      return resp;
    } catch {
      return null;
    } finally {
      RESP_INFLIGHT.delete(key);
    }
  })();
  RESP_INFLIGHT.set(key, p);
  return p;
}
