import type { NextApiRequest, NextApiResponse } from "next";
import {
  getAdminTursoClient,
  ensureAdminSchema,
} from "@/lib/db/turso-admin";

/**
 * Skip-times proxy.
 *
 *   GET /api/v2/skip/{malId}/{episode}?aniListId={id}
 *
 * Tries two upstream services, in order, and caches the result in
 * Turso forever (skip times don't meaningfully change once
 * submitted):
 *
 *   1. Anime-Skip (api.anime-skip.com) — far more accurate, but
 *      requires an AniList id to look up the showId via
 *      `findShowsByExternalId`. Free tier caps the WHOLE SITE at
 *      60 req/min via X-Client-ID, so we MUST cache aggressively.
 *
 *   2. AniSkip (api.aniskip.com) — broader coverage, less accurate.
 *      We pass `episodeLength` only when the client tells us the
 *      duration; without it AniSkip returns submissions timed
 *      against any rip, which is what shipped us bogus op times in
 *      the first place.
 *
 * Response shape (normalised across services):
 *   {
 *     source: "anime_skip" | "aniskip" | "none",
 *     skips: [{ start, end, type: "op" | "ed" | "recap" }]
 *   }
 */

export const config = {
  api: { bodyParser: false },
};

const ANIME_SKIP_ENDPOINT = "https://api.anime-skip.com/graphql";
const ANISKIP_ENDPOINT = "https://api.aniskip.com/v2/skip-times";

type Skip = { start: number; end: number; type: "op" | "ed" | "recap" };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  const malId = Number(req.query.malId);
  const episode = Number(req.query.episode);
  const aniListId = Number(req.query.aniListId) || null;
  const episodeLength = Number(req.query.episodeLength) || 0;
  if (!malId || !episode) {
    return res.status(400).json({ error: "malId + episode required" });
  }

  const db = getAdminTursoClient();
  if (db) await ensureAdminSchema();

  // 1. Cache hit?
  if (db) {
    try {
      const r = await db.execute({
        sql: `SELECT source, payload FROM skip_episodes
               WHERE mal_id = ? AND episode = ?`,
        args: [malId, episode],
      });
      if (r.rows.length) {
        const row: any = r.rows[0];
        // Long browser+CDN cache — skip times are practically static.
        res.setHeader(
          "Cache-Control",
          "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
        );
        return res.status(200).json({
          source: row.source,
          skips: safeParse(String(row.payload)),
          cached: true,
        });
      }
    } catch (e: any) {
      console.warn("[skip] cache read failed:", e?.message);
    }
  }

  // 2. Try Anime-Skip (needs AniList id).
  let skips: Skip[] = [];
  let source: "anime_skip" | "aniskip" | "none" = "none";
  if (aniListId) {
    try {
      skips = await fetchFromAnimeSkip(aniListId, episode);
      if (skips.length) source = "anime_skip";
    } catch (e: any) {
      console.warn("[skip] anime-skip failed:", e?.message);
    }
  }

  // 3. Fallback to AniSkip.
  if (!skips.length) {
    try {
      skips = await fetchFromAniSkip(malId, episode, episodeLength);
      if (skips.length) source = "aniskip";
    } catch (e: any) {
      console.warn("[skip] aniskip failed:", e?.message);
    }
  }

  // 4. Persist whatever we got — even "none", so subsequent loads
  //    skip the upstream cost. We use a coarse 7-day TTL on
  //    negative caches by writing source="none" and letting a
  //    later refresh job overwrite if needed.
  if (db) {
    try {
      await db.execute({
        sql: `INSERT OR REPLACE INTO skip_episodes
                (mal_id, episode, source, payload, fetched_at)
              VALUES (?, ?, ?, ?, strftime('%s','now'))`,
        args: [malId, episode, source, JSON.stringify(skips)],
      });
    } catch (e: any) {
      console.warn("[skip] cache write failed:", e?.message);
    }
  }

  res.setHeader(
    "Cache-Control",
    "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
  );
  return res.status(200).json({ source, skips, cached: false });
}

/* ─── Anime-Skip (preferred) ──────────────────────────────────── */

const ANIME_SKIP_CLIENT_ID =
  process.env.ANIME_SKIP_CLIENT_ID ||
  // Shared, heavily rate-limited client. Only used as a dev fallback —
  // production deployments MUST set ANIME_SKIP_CLIENT_ID.
  "ZGfO0sMF3eCwLYf8yMSCJjlynwNGRXWE";

// Map Anime-Skip's free-form timestamp type names to our normalised
// op/ed/recap vocabulary. Anything not in the map is ignored.
const ANIME_SKIP_TYPE: Record<string, "op" | "ed" | "recap"> = {
  "New Intro": "op",
  "Branding": "op",
  "Intro": "op",
  "Mixed Intro": "op",
  "New Credits": "ed",
  "New Ending": "ed",
  "Ending": "ed",
  "Mixed Credits": "ed",
  "Mixed Ending": "ed",
  "Recap": "recap",
  "Mixed Recap": "recap",
};

async function fetchFromAnimeSkip(
  aniListId: number,
  episode: number,
): Promise<Skip[]> {
  // 1. AniList id → Anime-Skip showId. Cached in Turso so we only
  //    hit Anime-Skip once per anime, ever.
  const showId = await resolveAnimeSkipShowId(aniListId);
  if (!showId) return [];

  // 2. Pull the matching episode + its raw timestamp points.
  const epRes = await gql<{
    findEpisodesByShowId: Array<{
      number: string | null;
      absoluteNumber: string | null;
      timestamps: Array<{
        at: number;
        type: { name: string };
      }>;
    }>;
  }>(
    `query($id: ID!) {
       findEpisodesByShowId(showId: $id) {
         number absoluteNumber
         timestamps { at type { name } }
       }
     }`,
    { id: showId },
  );
  const episodes = epRes?.findEpisodesByShowId || [];
  const ep =
    episodes.find((e) => Number(e.number) === episode) ||
    episodes.find((e) => Number(e.absoluteNumber) === episode);
  if (!ep) return [];

  // 3. Anime-Skip stores timestamps as POINTS, not intervals — each
  //    point marks the start of a region (Intro, Mixed Credits,
  //    Canon, Recap, etc.). We pair every op/ed/recap point with the
  //    NEXT point of any kind to derive an interval.
  const sorted = [...ep.timestamps].sort((a, b) => a.at - b.at);
  const skips: Skip[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const mapped = ANIME_SKIP_TYPE[cur.type?.name];
    if (!mapped) continue;
    const next = sorted[i + 1];
    if (!next) continue; // last point has no terminator
    if (next.at - cur.at < 5) continue; // too short
    skips.push({
      start: Math.round(cur.at),
      end: Math.round(next.at),
      type: mapped,
    });
  }
  return skips;
}

async function resolveAnimeSkipShowId(aniListId: number): Promise<string | null> {
  const db = getAdminTursoClient();
  if (db) {
    try {
      const r = await db.execute({
        sql: `SELECT anime_skip_id, not_found FROM skip_show_map
               WHERE anilist_id = ?`,
        args: [aniListId],
      });
      if (r.rows.length) {
        const row: any = r.rows[0];
        if (Number(row.not_found)) return null;
        return row.anime_skip_id ? String(row.anime_skip_id) : null;
      }
    } catch {}
  }

  const data = await gql<{
    findShowsByExternalId: Array<{ id: string }>;
  }>(
    `query($s: ExternalService!, $id: String!) {
       findShowsByExternalId(service: $s, serviceId: $id) { id }
     }`,
    { s: "ANILIST", id: String(aniListId) },
  );
  // Anime-Skip occasionally has multiple entries per AniList id (e.g.
  // dub + sub variants). We take the first — they share timestamps.
  const showId = data?.findShowsByExternalId?.[0]?.id || null;

  if (db) {
    try {
      await db.execute({
        sql: `INSERT OR REPLACE INTO skip_show_map
                (anilist_id, anime_skip_id, not_found, checked_at)
              VALUES (?, ?, ?, strftime('%s','now'))`,
        args: [aniListId, showId, showId ? 0 : 1],
      });
    } catch {}
  }
  return showId;
}

async function gql<T>(query: string, variables: any): Promise<T> {
  const res = await fetch(ANIME_SKIP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-ID": ANIME_SKIP_CLIENT_ID,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`anime-skip ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }
  return json.data as T;
}

/* ─── AniSkip (fallback) ──────────────────────────────────────── */

async function fetchFromAniSkip(
  malId: number,
  episode: number,
  episodeLength: number,
): Promise<Skip[]> {
  const params = new URLSearchParams();
  ["op", "ed", "recap"].forEach((t) => params.append("types[]", t));
  if (episodeLength > 0) {
    params.set("episodeLength", String(Math.round(episodeLength)));
  }
  const res = await fetch(
    `${ANISKIP_ENDPOINT}/${malId}/${episode}?${params.toString()}`,
  );
  if (!res.ok) return [];
  const json = await res.json();
  const KEEP = new Set(["op", "ed", "recap"]);
  return (json?.results || [])
    .filter((r: any) => KEEP.has(r?.skipType) && r?.interval)
    .map((r: any) => ({
      start: Math.round(r.interval.startTime),
      end: Math.round(r.interval.endTime),
      type: r.skipType as "op" | "ed" | "recap",
    }))
    .filter(
      (s: Skip) =>
        s.end > s.start &&
        s.end - s.start >= 5 &&
        !(s.type === "ed" && s.start < 3),
    );
}

function safeParse(s: string): Skip[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
