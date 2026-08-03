import { useEffect, useState } from "react";
import type { FanartResponse } from "@/components/anime/v2/helpers";

/**
 * Lazy fanart loader for the info page's tab bodies.
 *
 * The full fanart payload used to be serialised into the page's __NEXT_DATA__
 * on every view — 24 KB of a 292 KB HTML response for One Piece (208 rows),
 * re-sent to every visitor whether or not they ever opened a tab that reads it.
 * That is Fast Origin Transfer on a 10 GB Hobby quota, spent on data most
 * sessions never look at.
 *
 * Now the SSR ships only the counts the tab bar needs to render its badges, and
 * the rows themselves are fetched from /api/v2/fanarts the first time a tab
 * that actually uses them mounts — which, since <Tabs> only mounts the active
 * tab body, means on click.
 *
 * Two caches keep that from becoming a request storm:
 *   - MEMO      — resolved payloads, so switching Episodes -> Artworks -> back
 *                 re-reads memory rather than the network.
 *   - INFLIGHT  — de-duplicates concurrent callers, because Episodes and
 *                 Artworks can both mount for the same anime.
 * Both are module-level, so they also survive a client-side navigation away and
 * back. The endpoint itself is edge-cached (s-maxage=3600 + SWR), so even a
 * cold call rarely reaches the function.
 */
const MEMO = new Map<number, FanartResponse | null>();
const INFLIGHT = new Map<number, Promise<FanartResponse | null>>();

async function fetchFanarts(animeId: number): Promise<FanartResponse | null> {
  if (MEMO.has(animeId)) return MEMO.get(animeId) ?? null;
  const pending = INFLIGHT.get(animeId);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(`/api/v2/fanarts?anime=${animeId}`);
      if (!res.ok) return null;
      const json = (await res.json()) as FanartResponse;
      MEMO.set(animeId, json);
      return json;
    } catch {
      // Never memoise a failure: a transient network blip must not pin an
      // empty gallery for the rest of the session.
      return null;
    } finally {
      INFLIGHT.delete(animeId);
    }
  })();

  INFLIGHT.set(animeId, p);
  return p;
}

export type UseFanarts = {
  fanarts: FanartResponse | null;
  /** True while the first fetch for this anime is in flight. */
  loading: boolean;
};

/**
 * @param animeId AniList id to load fanarts for.
 * @param initial Optional already-resolved payload. When a caller still has one
 *                inline (or a memo hit exists) the hook resolves synchronously
 *                on the first render and never touches the network.
 */
export function useFanarts(
  animeId: number | null | undefined,
  initial?: FanartResponse | null,
): UseFanarts {
  const seed =
    initial ?? (animeId != null ? MEMO.get(animeId) ?? null : null);
  const [fanarts, setFanarts] = useState<FanartResponse | null>(seed);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (animeId == null) return;
    if (initial) {
      setFanarts(initial);
      return;
    }
    const cached = MEMO.get(animeId);
    if (cached !== undefined) {
      setFanarts(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchFanarts(animeId).then((res) => {
      if (cancelled) return;
      setFanarts(res);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [animeId, initial]);

  return { fanarts, loading };
}
