import { useEffect, useState } from "react";
import type { TmdbArtwork } from "@/lib/tmdb/artworks";

/**
 * Lazy TMDB gallery loader for the info page's Artworks tab.
 *
 * Same shape and the same two caches as lib/hooks/useFanarts.ts — MEMO for
 * resolved payloads so re-opening the tab is free, INFLIGHT so two mounts of
 * the same anime share one request — and for the same reason: the tab body
 * only mounts on click, so fetching here IS the lazy load.
 *
 * Kept separate from useFanarts rather than folded into it: the two endpoints
 * have different cost profiles (Turso row versus a possible upstream call), and
 * the tab is better off painting fanart.tv the moment it has it than waiting on
 * the slower of the two. See pages/api/v2/tmdb-artworks.ts.
 */
const MEMO = new Map<number, TmdbArtwork[]>();
const INFLIGHT = new Map<number, Promise<TmdbArtwork[]>>();

async function fetchTmdbArtworks(animeId: number): Promise<TmdbArtwork[]> {
  const memo = MEMO.get(animeId);
  if (memo) return memo;
  const pending = INFLIGHT.get(animeId);
  if (pending) return pending;

  const p = (async () => {
    try {
      const res = await fetch(`/api/v2/tmdb-artworks?anime=${animeId}`);
      if (!res.ok) return [];
      const json = (await res.json()) as { arts?: TmdbArtwork[] };
      const arts = Array.isArray(json?.arts) ? json.arts : [];
      MEMO.set(animeId, arts);
      return arts;
    } catch {
      // Never memoise a failure — a transient blip must not pin an empty
      // gallery for the rest of the session.
      return [];
    } finally {
      INFLIGHT.delete(animeId);
    }
  })();

  INFLIGHT.set(animeId, p);
  return p;
}

export function useTmdbArtworks(animeId: number): { tmdbArts: TmdbArtwork[] } {
  const [tmdbArts, setTmdbArts] = useState<TmdbArtwork[]>(
    () => MEMO.get(animeId) ?? [],
  );

  useEffect(() => {
    let cancelled = false;
    if (!Number.isFinite(animeId) || animeId <= 0) return;
    fetchTmdbArtworks(animeId).then((arts) => {
      if (!cancelled) setTmdbArts(arts);
    });
    return () => {
      cancelled = true;
    };
  }, [animeId]);

  return { tmdbArts };
}
