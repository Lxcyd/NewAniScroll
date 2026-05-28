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

  // Fetch both in parallel — Anime-Skip tends to have very accurate
  // intros (manual curation) but spotty outro coverage; AniSkip has
  // broad outro coverage from crowdsourcing. We MERGE per-type with
  // Anime-Skip winning when both have the same type, and AniSkip
  // filling in whatever Anime-Skip is missing (typically the ed).
  const [animeSkip, aniSkip] = await Promise.all([
    aniListId
      ? fetchFromAnimeSkip(aniListId, episode).catch((e: any) => {
          console.warn("[skip] anime-skip failed:", e?.message);
          return [] as Skip[];
        })
      : Promise.resolve([] as Skip[]),
    fetchFromAniSkip(malId, episode, episodeLength).catch((e: any) => {
      console.warn("[skip] aniskip failed:", e?.message);
      return [] as Skip[];
    }),
  ]);

  const byType = new Map<string, Skip>();
  // AniSkip first so Anime-Skip overwrites for shared types.
  for (const s of aniSkip) if (!byType.has(s.type)) byType.set(s.type, s);
  for (const s of animeSkip) byType.set(s.type, s);
  const skips: Skip[] = Array.from(byType.values()).sort(
    (a, b) => a.start - b.start,
  );

  let source: "merged" | "anime_skip" | "aniskip" | "none" = "none";
  if (animeSkip.length && aniSkip.length) source = "merged";
  else if (animeSkip.length) source = "anime_skip";
  else if (aniSkip.length) source = "aniskip";

  // Cache hits only on success. A 24-hour cache on `source=none` would pin
  // the empty response in the browser even after the upstream API is fixed
  // or the data lands — bit us when AniSkip changed its episodeLength
  // requirement and every visitor kept seeing "no skips" for a full day.
  // Failures get a 60 s cushion so the SkipOverlay fetch fan-out (one per
  // mount) doesn't re-hammer both upstreams for the same anime+episode.
  if (source === "none") {
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  } else {
    res.setHeader(
      "Cache-Control",
      "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
    );
  }
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
  // AniSkip now hard-rejects the request with HTTP 400 when episodeLength
  // is missing (`episodeLength must not be less than 0`). Sending 0 is
  // still accepted and just disables their best-submission tiebreak — the
  // primary intro/outro entries come back the same. SkipOverlay no longer
  // waits for the player's duration before firing the fetch, so we just
  // default the param to 0 instead of reintroducing the 2-3 s wait.
  const params = new URLSearchParams();
  ["op", "ed"].forEach((t) => params.append("types[]", t));
  params.set("episodeLength", String(Math.max(0, Math.round(episodeLength))));
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
