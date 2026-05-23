import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Skip-times proxy.
 *
 *   GET /api/v2/skip/{malId}/{episode}?aniListId={id}
 *
 * Tries Anime-Skip first (better data, manually curated, accurate
 * timestamps like Miruro), falls back to AniSkip. Both are public
 * crowdsourced services with very different coverage and quality.
 *
 * Response: { source, skips: [{ start, end, type: "op" | "ed" }] }
 *
 * No DB cache here — Anime-Skip and AniSkip are both fast enough to
 * hit per page load, and the browser/CDN cache headers below give
 * us 24 h of free re-serving anyway.
 */
export const config = {
  api: { bodyParser: false },
};

type Skip = { start: number; end: number; type: "op" | "ed" };

const ANIME_SKIP_ENDPOINT = "https://api.anime-skip.com/graphql";
const ANIME_SKIP_CLIENT_ID =
  process.env.ANIME_SKIP_CLIENT_ID ||
  // Shared rate-limited public client. Set ANIME_SKIP_CLIENT_ID in
  // env for a dedicated quota.
  "ZGfO0sMF3eCwLYf8yMSCJjlynwNGRXWE";

// Anime-Skip stores timestamps as POINTS (each marker is a single
// `at` second, not an interval). We map their free-form timestamp
// type names to our op/ed vocabulary; any point whose type isn't
// here is treated as a section boundary that terminates a preceding
// op/ed interval.
const ANIME_SKIP_TYPE: Record<string, "op" | "ed"> = {
  "New Intro": "op",
  Intro: "op",
  Branding: "op",
  "Mixed Intro": "op",
  "New Credits": "ed",
  "New Ending": "ed",
  Ending: "ed",
  "Mixed Credits": "ed",
  "Mixed Ending": "ed",
};

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

  // 1. Try Anime-Skip first (needs AniList id).
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

  // 2. Fallback to AniSkip.
  if (!skips.length) {
    try {
      skips = await fetchFromAniSkip(malId, episode, episodeLength);
      if (skips.length) source = "aniskip";
    } catch (e: any) {
      console.warn("[skip] aniskip failed:", e?.message);
    }
  }

  res.setHeader(
    "Cache-Control",
    "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
  );
  return res.status(200).json({ source, skips });
}

async function fetchFromAnimeSkip(
  aniListId: number,
  episode: number,
): Promise<Skip[]> {
  // 1. AniList id → Anime-Skip showId.
  const showRes = await gql<{
    findShowsByExternalId: Array<{ id: string }>;
  }>(
    `query($s: ExternalService!, $id: String!) {
       findShowsByExternalId(service: $s, serviceId: $id) { id }
     }`,
    { s: "ANILIST", id: String(aniListId) },
  );
  const showId = showRes?.findShowsByExternalId?.[0]?.id;
  if (!showId) return [];

  // 2. Pull every episode with its timestamps. Anime-Skip has no
  //    "episode by number" query — we filter client-side.
  const epRes = await gql<{
    findEpisodesByShowId: Array<{
      number: string | null;
      absoluteNumber: string | null;
      timestamps: Array<{ at: number; type: { name: string } }>;
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

  // 3. Anime-Skip's points → intervals: pair each op/ed point with
  //    the NEXT point of any kind to derive an end time.
  const sorted = [...ep.timestamps].sort((a, b) => a.at - b.at);
  const skips: Skip[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const mapped = ANIME_SKIP_TYPE[cur.type?.name];
    if (!mapped) continue;
    const next = sorted[i + 1];
    if (!next) continue;
    if (next.at - cur.at < 5) continue;
    skips.push({
      start: Math.round(cur.at),
      end: Math.round(next.at),
      type: mapped,
    });
  }
  return skips;
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
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}

async function fetchFromAniSkip(
  malId: number,
  episode: number,
  episodeLength: number,
): Promise<Skip[]> {
  const params = new URLSearchParams();
  ["op", "ed"].forEach((t) => params.append("types[]", t));
  if (episodeLength > 0) {
    params.set("episodeLength", String(Math.round(episodeLength)));
  }
  const res = await fetch(
    `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?${params}`,
  );
  if (!res.ok) return [];
  const json = await res.json();
  const KEEP = new Set(["op", "ed"]);
  return (json?.results || [])
    .filter((r: any) => KEEP.has(r?.skipType) && r?.interval)
    .map((r: any) => ({
      start: Math.round(r.interval.startTime),
      end: Math.round(r.interval.endTime),
      type: r.skipType as "op" | "ed",
    }))
    .filter(
      (s: Skip) =>
        s.end > s.start && s.end - s.start >= 5 && !(s.type === "ed" && s.start < 3),
    );
}
