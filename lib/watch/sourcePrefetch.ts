/**
 * Shared client-side cache for prefetched episode sources.
 *
 * The anime info page warms the source for the "Watch" target (megaplay,
 * resume episode) in the background. When the user then opens the watch page,
 * it reads the already-resolved source from here instead of re-issuing the
 * /api/v2/source request + waiting on extraction — so playback starts almost
 * immediately.
 *
 * Keyed by `${aniId}:${episode}:${server}:${sub|dub}`. Entries are short-lived
 * (source URLs carry rotating tokens) — we expire them after a few minutes so
 * a stale token never reaches the player.
 */

import { requestSource } from "./sourceRequest";

type CacheEntry = { data: any; at: number };

const TTL_MS = 5 * 60 * 1000; // 5 minutes — well under typical token lifetimes.
const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<any>>();

export function sourceKey(
  aniId: number | string,
  episode: number | string,
  server: string,
  sub: "sub" | "dub",
): string {
  return `${aniId}:${episode}:${server}:${sub}`;
}

/** Read a fresh prefetched source, or null if absent/expired. */
export function getPrefetchedSource(key: string): any | null {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    store.delete(key);
    return null;
  }
  return e.data;
}

export function setPrefetchedSource(key: string, data: any) {
  store.set(key, { data, at: Date.now() });
}

/**
 * Drop every cached source for an anime. Called when the user leaves the info
 * page that warmed them — we don't want a watch page reached later (with a
 * possibly rotated token) reading a stale entry, and there's no reason to keep
 * the memory around once the page that prefetched them is gone.
 *
 * Keys are `${aniId}:${episode}:${server}:${sub}`, so a prefix match on
 * `${aniId}:` covers every episode/server/sub combo we warmed for it.
 */
export function clearPrefetchedSourcesFor(aniId: number | string): void {
  const prefix = `${aniId}:`;
  Array.from(store.keys()).forEach((key) => {
    if (key.startsWith(prefix)) store.delete(key);
  });
}

/**
 * Resolve a source via /api/v2/source and cache it. Deduplicates concurrent
 * calls for the same key (the prefetch + the watch page can race). Returns the
 * source payload, or null on failure (caller falls back to its own fetch).
 *
 * `priority: "low"` keeps the prefetch from competing with the info page's own
 * above-the-fold requests (images, metadata) for the connection pool.
 */
export async function resolveSource(
  params: {
    aniId: number;
    episode: number;
    server: string;
    sub: "sub" | "dub";
    title?: string;
    mediaMeta?: any;
  },
  opts: { priority?: "high" | "low" | "auto"; signal?: AbortSignal } = {},
): Promise<any | null> {
  const key = sourceKey(params.aniId, params.episode, params.server, params.sub);
  const cached = getPrefetchedSource(key);
  if (cached) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = requestSource(
    {
      server: params.server,
      aniId: params.aniId,
      episode: params.episode,
      sub: params.sub,
      title: params.title,
      malId: params.mediaMeta?.idMal ?? null,
    },
    { signal: opts.signal, priority: opts.priority || "auto" },
  )
    .then((out) => {
      if (out.kind !== "ok") return null;
      setPrefetchedSource(key, out.data);
      return out.data;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}

/**
 * Best-effort warm of the HLS manifest + first segment through whatever proxy
 * the stream URL already points at, so playback starts with zero buffering.
 * Fire-and-forget; failures are silently ignored. Only fetches a small slice
 * of the first segment (Range) to avoid pulling the whole episode.
 */
export async function warmStream(streamData: any, signal?: AbortSignal) {
  try {
    const url: string | undefined =
      streamData?.sources?.[0]?.url || streamData?.streams?.[0]?.url;
    if (!url || !/\.m3u8(\?|$)/i.test(url)) return;
    const res = await fetch(url, { priority: "low", signal } as any);
    if (!res.ok) return;
    const text = await res.text();
    // Pull the first media segment URI from the manifest and warm a small
    // Range of it. Lines that aren't comments are segment/sub-playlist URIs.
    const firstUri = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (!firstUri) return;
    const segUrl = firstUri.startsWith("http")
      ? firstUri
      : new URL(firstUri, url).toString();
    // 256 KB is enough to prime the CDN/proxy edge cache for the opening of
    // playback without downloading the full segment.
    await fetch(segUrl, {
      headers: { Range: "bytes=0-262143" },
      priority: "low",
      signal,
    } as any).catch(() => {});
  } catch {
    /* ignore */
  }
}
