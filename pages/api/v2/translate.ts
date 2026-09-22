import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { redis } from "@/lib/redis";

/**
 * On-demand text translation for AniList descriptions (and any other
 * English copy that originates from a third-party API and therefore can't be
 * shipped in our static locale files).
 *
 * Strategy: translate via Google's free translate endpoint, then cache the
 * result in Redis keyed by a hash of (source text + target lang). AniList
 * descriptions are immutable, so a translated synopsis is cached effectively
 * forever (30-day TTL as a safety valve). The first viewer of an anime pays
 * the ~200-400ms round-trip; every subsequent viewer gets the cached French
 * text instantly.
 *
 * No API key required. If the upstream call fails we return the original text
 * with `translated: false` so the client falls back to English rather than
 * showing an error.
 */

const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_CHARS = 5000; // Google's single-request soft limit.

function cacheKey(text: string, target: string): string {
  const h = crypto.createHash("sha1").update(`${target}:${text}`).digest("hex");
  return `tr:${target}:${h}`;
}

/**
 * In-process memo (per warm lambda) for the hottest translations. AniList
 * descriptions are immutable and a handful of popular titles are viewed far
 * more than the long tail, so a small bounded cache absorbs their repeat Redis
 * GETs entirely: a warm instance re-serving the same synopsis returns from
 * memory and never touches Redis. This is the only Redis saving available here
 * — the endpoint is POST (body-keyed), so it can't be edge-cached by URL.
 * Bounded (insertion-order LRU) so a long-lived instance can't grow unbounded.
 */
const MEM_MAX = 1000;
const memCache = new Map<string, string>();

function memGet(key: string): string | undefined {
  const v = memCache.get(key);
  if (v !== undefined) {
    // Refresh recency: re-insert so this key becomes the newest entry.
    memCache.delete(key);
    memCache.set(key, v);
  }
  return v;
}

function memSet(key: string, value: string): void {
  if (memCache.has(key)) memCache.delete(key);
  memCache.set(key, value);
  if (memCache.size > MEM_MAX) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
}

/**
 * Call Google's public translate endpoint (the one the Translate website's
 * widget uses). Returns the concatenated translated segments, or null on any
 * failure. `client=gtx` + `dt=t` yields a JSON array of [translatedChunk,
 * originalChunk, …] tuples.
 */
async function translateUpstream(
  text: string,
  target: string,
): Promise<string | null> {
  const url =
    "https://translate.googleapis.com/translate_a/single" +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const data = await res.json();
    // data[0] is an array of [translated, original, …] segment tuples.
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
    const out = data[0]
      .map((seg: any) => (Array.isArray(seg) ? seg[0] : ""))
      .join("");
    return out || null;
  } catch {
    return null;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  // GET `?q=&target=` est la voie normale : la reponse ne depend que de l'URL,
  // donc le CDN la garde 30 jours et un synopsis deja traduit ne reveille plus
  // jamais la fonction, quel que soit le visiteur. Le POST (corps JSON) reste
  // pour les textes trop longs pour une URL — le client choisit.
  const isGet = req.method === "GET";
  if (!isGet && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text, target } = (
    isGet
      ? {
          text: typeof req.query.q === "string" ? req.query.q : undefined,
          target: typeof req.query.target === "string" ? req.query.target : undefined,
        }
      : req.body || {}
  ) as {
    text?: string;
    target?: string;
  };
  // Une traduction reussie est immuable (le texte source est dans l'URL).
  const cacheOk = () => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (isGet) {
      res.setHeader(
        "CDN-Cache-Control",
        "public, s-maxage=2592000, stale-while-revalidate=86400",
      );
    }
  };

  const lang = (target || "fr").toLowerCase();

  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing text" });
  }

  // Nothing to do for empty/whitespace or when target is English (the source).
  if (!text.trim() || lang === "en") {
    return res.status(200).json({ text, translated: false });
  }

  const trimmed = text.slice(0, MAX_CHARS);
  const key = cacheKey(trimmed, lang);

  // 0. In-process memo → skip Redis entirely for hot, immutable translations.
  const memHit = memGet(key);
  if (memHit !== undefined) {
    cacheOk();
    return res.status(200).json({ text: memHit, translated: true, cached: true });
  }

  // 1. Cache hit → instant.
  try {
    if (redis) {
      const cached = await redis.get(key);
      if (cached != null) {
        memSet(key, cached);
        cacheOk();
        return res.status(200).json({ text: cached, translated: true, cached: true });
      }
    }
  } catch {
    /* Redis down — fall through to a live translation. */
  }

  // 2. Live translate.
  const translated = await translateUpstream(trimmed, lang);
  if (!translated) {
    // Upstream failed — return the original so the client shows English. Never
    // cached at the edge: the next visitor must get a fresh attempt.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ text, translated: false });
  }

  // 3. Cache for next time (best-effort): in-process memo + Redis.
  memSet(key, translated);
  try {
    if (redis) await redis.set(key, translated, "EX", CACHE_TTL_SECONDS);
  } catch {
    /* ignore cache write failures */
  }

  cacheOk();
  return res.status(200).json({ text: translated, translated: true });
}
