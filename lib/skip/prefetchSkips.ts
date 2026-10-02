// Standalone AniSkip prefetch + shared cache.
//
// Lives outside SkipOverlay.tsx on purpose: the watch page imports this to
// warm the cache the moment malId/episode are known, and SkipOverlay is a
// dynamic/ssr:false chunk that pulls in @vidstack/react. Importing the
// prefetch from SkipOverlay statically would drag Vidstack into the page
// bundle and defeat the code-split (and risk SSR/hydration issues from the
// Web Components). Keeping it dependency-free here avoids all that.

import { serverToHost } from "@/lib/hostRegistry";
import { loadHostSkips } from "@/lib/watch/episodeRuntime";

export type Skip = { start: number; end: number; type: string; pts?: number };

/* La reponse de /api/v2/skip : le minutage participatif de l'episode. */
type SkipResponse = { skips: Skip[] };

/* En dessous, aucun bouton « passer » n'a de sens. */
const MIN_SKIP_S = 5;

/**
 * Les generiques de NOTRE detecteur pour cet episode sur ce lecteur, ou null.
 * Ils arrivent avec la saison (/api/v2/runtimes, un appel par anime et par
 * lecteur que la page fait deja) : aucun appel par episode.
 */
async function ownSkips(malId: number, episode: number, server: string): Promise<Skip[] | null> {
  const row = (await loadHostSkips(malId, server))[episode];
  if (!row) return null;
  const [opStart, opEnd, edStart, edEnd, clock] = row;
  const pts = clock != null ? { pts: clock } : null;
  const out: Skip[] = [];
  if (opStart != null && opEnd != null && opEnd - opStart >= MIN_SKIP_S)
    out.push({ start: opStart, end: opEnd, type: "op", ...pts });
  if (edStart != null && edEnd != null && edEnd - edStart >= MIN_SKIP_S)
    out.push({ start: edStart, end: edEnd, type: "ed", ...pts });
  return out.length ? out.sort((a, b) => a.start - b.start) : null;
}
const RESP_MEMO = new Map<string, SkipResponse>();
const RESP_INFLIGHT = new Map<string, Promise<SkipResponse | null>>();

// Module-level memo so changing servers (which remounts the player and
// therefore SkipOverlay) doesn't refetch the same episode. The discriminator is
// the ACTIVE SERVER id when known, else the lang: our own detector stores
// PER-HOST rows because the OP's absolute start is encode-specific (SnK ep1 OP
// is 2:02 on sibnet, 2:19 on megaplay), so two servers must not share a cache
// entry.
export const SKIP_MEMO = new Map<string, Skip[]>();
export const skipMemoKey = (mal: number, ep: number, disc = "vostfr") =>
  `${mal}:${ep}:${disc}`;

// In-flight requests, so the watch page's eager prefetch and SkipOverlay's
// own fetch don't both hit the network for the same episode — the second
// caller awaits the first.
const SKIP_INFLIGHT = new Map<string, Promise<Skip[]>>();

/**
 * The skips of an episode — our detector's when it has measured this server,
 * else the crowdsourced ones — cached in SKIP_MEMO. Safe to call
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
      // Our own measurement for the active host when we have one; the
      // crowdsourced route only for episodes the detector has not served.
      const own = mapped && server ? await ownSkips(malId, episode, server) : null;
      const arr =
        own ||
        (await fetchSkipResponse(malId, episode, aniListId ?? null, lang, opts?.episodeLength))
          ?.skips;
      if (!arr) return [];
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
 * The crowdsourced answer: ONE request per (episode, language), whatever the
 * number of servers the watch page walks through while it loads.
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
      // AniSkip matches its submissions against the episode length when given.
      if (len) params.set("episodeLength", String(len));
      const res = await fetch(`/api/v2/skip/${malId}/${episode}?${params.toString()}`);
      if (!res.ok) return null;
      const json = await res.json();
      const resp: SkipResponse = { skips: Array.isArray(json?.skips) ? json.skips : [] };
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
