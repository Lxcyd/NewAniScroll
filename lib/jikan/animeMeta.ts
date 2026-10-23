import { seasonCacheGetEntry, seasonCacheSet } from "@/lib/db/seasonCache";
import { waitUntil } from "@/lib/http/waitUntil";

/**
 * Anime-level facts MyAnimeList has and AniList does not, via Jikan.
 *
 *   - `titleFr`  : the French title. AniList's `synonyms` carry no language, so
 *                  "L'Attaque des Titans" cannot be told apart from "AoT" there.
 *   - `rating`   : the age classification (G / PG / PG-13 / R / R+ / Rx).
 *                  AniList only has the `isAdult` boolean.
 *   - `synopsis` : MAL's own synopsis — a DIFFERENT text from AniList's, used
 *                  only as a fallback when AniList has none.
 *
 * Read at SSR on the info page, so the rules are strict:
 *   - Turso (season_cache table) holds the result for 30 days — a hit is one
 *     row read that runs alongside the fanarts read;
 *   - a miss calls Jikan ONCE with a short timeout. It runs concurrently with
 *     the season walkers, so it rarely adds latency, and never more than the
 *     timeout;
 *   - a real "nothing" (404, no fields) is cached 3 days; a transient failure
 *     (429, 5xx — Jikan relays MAL outages as 504 — timeout) is remembered
 *     10 minutes, so an outage costs one 2.5 s wait per anime per 10 min
 *     instead of one per edge-cache miss. A previously good value is kept.
 * Never throws: every failure is `null`, and the page renders without the rows.
 */

export type MalRating = "G" | "PG" | "PG-13" | "R" | "R+" | "Rx";

export type MalMeta = {
  titleFr: string | null;
  rating: MalRating | null;
  synopsis: string | null;
};

const KEY = (idMal: number) => `malMeta:v1:${idMal}`;
const TTL_HIT_S = 30 * 24 * 3600;
const TTL_MISS_S = 3 * 24 * 3600;
const TTL_RETRY_S = 10 * 60;
const TIMEOUT_MS = 2500;

/** Jikan spells the rating as a sentence ("PG-13 - Teens 13 or older"); keep
 *  the code alone, the UI translates it. */
function parseRating(raw: unknown): MalRating | null {
  if (typeof raw !== "string") return null;
  const code = raw.split(" - ")[0].trim();
  return (["G", "PG", "PG-13", "R", "R+", "Rx"] as const).find((c) => c === code) ?? null;
}

/** MAL appends "[Written by MAL Rewrite]" to its synopses — drop the credit. */
function cleanSynopsis(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s*\[Written by MAL Rewrite\]\s*$/i, "").trim();
  return s || null;
}

/* LE DISJONCTEUR. Un echec transitoire (panne, 429, delai depasse) coupe les
   appels de ce processus pendant JIKAN_PAUSE_MS : pendant une panne de Jikan,
   chaque NOUVEL anime attendait sinon les 2,5 s du delai, l'un apres l'autre.
   Coupe, l'appel rend « transient » tout de suite — la meme reponse que la
   panne aurait donnee, sans l'attente. */
const JIKAN_PAUSE_MS = 2 * 60 * 1000;
let jikanDownUntil = 0;

async function fetchFromJikan(idMal: number): Promise<MalMeta | "miss" | "transient"> {
  if (Date.now() < jikanDownUntil) return "transient";
  const r = await fetchFromJikanOnce(idMal);
  if (r === "transient") jikanDownUntil = Date.now() + JIKAN_PAUSE_MS;
  return r;
}

async function fetchFromJikanOnce(idMal: number): Promise<MalMeta | "miss" | "transient"> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.jikan.moe/v4/anime/${idMal}`, {
      signal: ctrl.signal,
    });
    if (res.status === 404) return "miss";
    if (!res.ok) return "transient";
    const d = (await res.json())?.data;
    if (!d) return "miss";
    const titles: Array<{ type?: string; title?: string }> = d.titles || [];
    return {
      titleFr: titles.find((t) => t.type === "French")?.title?.trim() || null,
      rating: parseRating(d.rating),
      synopsis: cleanSynopsis(d.synopsis),
    };
  } catch {
    return "transient";
  } finally {
    clearTimeout(timer);
  }
}

type Stored = MalMeta | { miss: true } | { retry: true };

/* Un seul rafraichissement en vol par id et par processus : deux rendus
   simultanes du meme anime ne doivent pas appeler Jikan deux fois. */
const refreshing = new Map<number, Promise<void>>();

/**
 * Rafraichit une valeur PERIMEE mais bonne, apres coup. Jikan muet : la bonne
 * valeur est reecrite datee de facon a redevenir perimee dans TTL_RETRY_S —
 * on ne retente donc qu'une fois par 10 min, sans jamais perdre la valeur.
 */
function refreshStale(idMal: number, stale: MalMeta): void {
  if (refreshing.has(idMal)) return;
  const job = (async () => {
    const r = await fetchFromJikan(idMal);
    if (r === "transient") {
      const retryAt = Math.floor(Date.now() / 1000) - TTL_HIT_S + TTL_RETRY_S;
      await seasonCacheSet(KEY(idMal), stale, retryAt);
      return;
    }
    await seasonCacheSet(KEY(idMal), r === "miss" ? { miss: true } : r);
  })().finally(() => refreshing.delete(idMal));
  refreshing.set(idMal, job);
  waitUntil(job);
}

export async function getMalMeta(idMal: number | null | undefined): Promise<MalMeta | null> {
  if (!idMal) return null;
  const cached = await seasonCacheGetEntry<Stored>(KEY(idMal));
  if (cached) {
    const v = cached.value;
    const ttl = "retry" in v ? TTL_RETRY_S : "miss" in v ? TTL_MISS_S : TTL_HIT_S;
    if (cached.ageSeconds <= ttl) return "retry" in v || "miss" in v ? null : v;
    /* PERIMEE MAIS BONNE : servie tout de suite, rafraichie apres la reponse.
       Avant le 23/10/2026 on attendait Jikan d'abord — et Jikan en panne, c'est
       le delai de 2,5 s a CHAQUE rendu, puisqu'un echec avec une ancienne
       valeur en main n'ecrivait rien (la marque « retry » ne se posait que
       sans valeur). Mesure : malMeta = 2,5 a 3 s sur chaque page anime, tout
       le reste du rendu tenant en 0,3-0,6 s. */
    if (!("retry" in v) && !("miss" in v)) {
      refreshStale(idMal, v);
      return v;
    }
  }
  const r = await fetchFromJikan(idMal);
  if (r === "transient") {
    // Nothing usable to serve: park the id for 10 min.
    await seasonCacheSet(KEY(idMal), { retry: true });
    return null;
  }
  await seasonCacheSet(KEY(idMal), r === "miss" ? { miss: true } : r);
  return r === "miss" ? null : r;
}
