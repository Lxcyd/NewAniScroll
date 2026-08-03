import type { NextApiRequest, NextApiResponse } from "next";
import { getOpedSkips, type OpedSkipRow } from "@/lib/db/opedSkips";
import { getHostSkip, type OpedHostSkipRow } from "@/lib/db/opedHostSkips";
import { serverToHost } from "@/lib/hostRegistry";

/**
 * Skip-times proxy.
 *
 *   GET /api/v2/skip/{malId}/{episode}?aniListId={id}&episodeLength={sec}&lang={lang}
 *
 * Source priority (precision-first):
 *   1. Our OWN offline OP/ED detector (oped_skips in Turso) — audio fingerprint
 *      vs the AnimeThemes clean clip, cross-host reconciled, fade edges extended
 *      by the video signal. Only rows the detector flagged `serve` (≥2 hosts
 *      agree, or 1 + video confirms) are returned — a doubtful timing is never
 *      shipped. An ED is re-projected onto the caller's real duration from its
 *      duration-independent `from_end_*` anchor, so a differently-trimmed encode
 *      stays correct.
 *   2. FALLBACK (temporary, while the detector's catalogue coverage ramps up):
 *      Anime-Skip then AniSkip — the crowdsourced sources. Used ONLY when the
 *      detector has no servable timing for this episode, so no episode loses its
 *      skip button during the transition.
 *
 * Response: { source, skips: [{ start, end, type: "op" | "ed", confidence? }] }
 *
 * The oped read is a single indexed Turso lookup (no Upstash); combined with the
 * 24 h Cache-Control below, the vast majority of hits are served by the CDN/
 * browser and never re-invoke this function.
 */
export const config = {
  api: { bodyParser: false },
};

type Skip = {
  start: number;
  end: number;
  type: "op" | "ed";
  /** Present only on detector-sourced skips: "audio" | "video" | "mixed". Lets
   *  the player down-rank auto-skip on a coarser (video-only) timing later. */
  confidence?: string;
};

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
  const lang = typeof req.query.lang === "string" ? req.query.lang : "vostfr";
  // The player's ACTIVE server (lib/servers.js id). When present it pins the
  // exact encode, which matters for the OP: its absolute start is encode-specific
  // (SnK ep1 OP is 2:02 on sibnet but 2:19 on megaplay), so a per-host row is the
  // only correct answer. Absent → fall back to the reconciled oped_skips below.
  const serverId = typeof req.query.server === "string" ? req.query.server : null;
  const mapped = serverId ? serverToHost(serverId) : null;
  // A mapped server also fixes the language (its id encodes vo/vf); use that for
  // every downstream lookup so the fallback reads the matching panel too.
  const effLang = mapped ? mapped.lang : lang;
  if (!malId || !episode) {
    return res.status(400).json({ error: "malId + episode required" });
  }

  // 0. PER-HOST: if we know which server the viewer is on, return that encode's
  //    own OP/ED (correct absolute OP; ED re-projected from its from_end anchor).
  if (mapped) {
    const hostRow = await getHostSkipSafe(malId, episode, mapped.lang, mapped.host);
    if (hostRow && hostRow.serve) {
      const skips = hostRowToSkips(hostRow, episodeLength);
      if (skips.length) {
        res.setHeader(
          "Cache-Control",
          "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
        );
        return res
          .status(200)
          .json({ source: "oped-host", host: mapped.host, skips });
      }
    }
  }

  // 1. Our own detector first. Only servable rows; ED re-projected onto the
  //    caller's real duration from its from_end anchor.
  const oped = await getOpedSkipsSafe(malId, episode, effLang);
  const opedSkips = oped
    .filter((r) => r.serve)
    .map((r) => opedRowToSkip(r, episodeLength))
    .filter((s): s is Skip => s !== null)
    .sort((a, b) => a.start - b.start);
  if (opedSkips.length) {
    // 24 h cache like the crowdsourced path — this data is quasi-static.
    res.setHeader(
      "Cache-Control",
      "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
    );
    return res.status(200).json({ source: "oped", skips: opedSkips });
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

  let source: "oped" | "merged" | "anime_skip" | "aniskip" | "none" = "none";
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

/** Read one host's row without ever throwing into the request path. */
async function getHostSkipSafe(
  malId: number,
  episode: number,
  lang: string,
  host: string,
): Promise<OpedHostSkipRow | null> {
  try {
    return await getHostSkip(malId, episode, lang, host);
  } catch (e: any) {
    console.warn("[skip] host lookup failed:", e?.message);
    return null;
  }
}

/** Build the OP/ED skips for ONE host's encode. The OP start is absolute in this
 *  host's own encode (no re-projection — that's the whole point of per-host). The
 *  ED is re-projected from its host-independent from_end anchor onto the player's
 *  real duration, so a differently-trimmed encode of the SAME host stays right. */
function hostRowToSkips(r: OpedHostSkipRow, episodeLength: number): Skip[] {
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const out: Skip[] = [];

  if (r.opStart != null && r.opEnd != null) {
    let end = r.opEnd;
    if (episodeLength > 0) end = Math.min(end, episodeLength);
    if (end - r.opStart >= 5) {
      out.push({ start: round2(r.opStart), end: round2(end), type: "op", confidence: r.source });
    }
  }

  if (r.edStart != null && r.edEnd != null) {
    let start = r.edStart;
    let end = r.edEnd;
    if (episodeLength > 0 && r.edFromEndStart != null && r.edFromEndEnd != null) {
      start = Math.max(0, episodeLength - r.edFromEndStart);
      end = Math.max(start, episodeLength - r.edFromEndEnd);
    }
    if (episodeLength > 0) end = Math.min(end, episodeLength);
    if (end - start >= 5) {
      out.push({ start: round2(start), end: round2(end), type: "ed", confidence: r.source });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}

/** Read oped_skips without ever throwing into the request path — a DB hiccup
 *  must fall through to the crowdsourced fallback, never 500 the skip button. */
async function getOpedSkipsSafe(
  malId: number,
  episode: number,
  lang: string,
): Promise<OpedSkipRow[]> {
  try {
    return await getOpedSkips(malId, episode, lang);
  } catch (e: any) {
    console.warn("[skip] oped lookup failed:", e?.message);
    return [];
  }
}

/** Convert one stored detector row into a Skip, re-projecting the ED onto the
 *  player's real duration from its host-independent from_end anchor.
 *
 *  Why re-project: the stored ED start/end are absolute in the detector's
 *  CANONICAL (median) duration; the encode the user is actually watching can be
 *  a few seconds shorter/longer. `from_end_*` ("seconds before the end") is
 *  duration-independent, so `realDuration - from_end` puts the ED at the right
 *  spot on THIS encode. The OP (anchored from the start) needs no re-projection.
 */
function opedRowToSkip(r: OpedSkipRow, episodeLength: number): Skip | null {
  let start = r.start;
  let end = r.end;
  if (
    r.kind === "ed" &&
    episodeLength > 0 &&
    r.fromEndStart != null &&
    r.fromEndEnd != null
  ) {
    start = Math.max(0, episodeLength - r.fromEndStart);
    end = Math.max(start, episodeLength - r.fromEndEnd);
  }
  if (episodeLength > 0) end = Math.min(end, episodeLength);
  if (end - start < 5) return null; // sub-frame / degenerate — not worth a button
  // Keep sub-second precision: the detector now pins ED/OP edges to the image
  // transition to ~0.25s (dense credited refine), so rounding to whole seconds
  // here would throw that away and land the "last frame" up to a second off.
  // 2 decimals is well below the ~0.25s target and the DB already stores floats.
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return {
    start: round2(start),
    end: round2(end),
    type: r.kind,
    confidence: r.source,
  };
}

async function fetchFromAnimeSkip(
  aniListId: number,
  episode: number,
): Promise<Skip[]> {
  // 1. AniList id → Anime-Skip showId(s). Anime-Skip can have MULTIPLE
  //    shows under the same external id (different submitters, different
  //    completeness levels). We previously hard-picked [0], which on
  //    Demon Slayer dropped us into a near-empty submission and missed
  //    the fully timestamped one sitting at index 1.
  const showRes = await gql<{
    findShowsByExternalId: Array<{ id: string }>;
  }>(
    `query($s: ExternalService!, $id: String!) {
       findShowsByExternalId(service: $s, serviceId: $id) { id }
     }`,
    { s: "ANILIST", id: String(aniListId) },
  );
  const showIds =
    showRes?.findShowsByExternalId?.map((s) => s.id).filter(Boolean) || [];
  if (showIds.length === 0) return [];

  // 2. Fetch every show's episode list in parallel and merge candidates
  //    for the requested episode number. Pick the candidate with the most
  //    op/ed timestamps after the points→intervals conversion — that's the
  //    "most useful" submission for the player.
  const epLists = await Promise.all(
    showIds.map((id) =>
      gql<{
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
        { id },
      ).catch(() => null),
    ),
  );

  // Points → intervals: pair each op/ed point with the NEXT point of any
  // kind to derive an end time. Returns the resulting Skip[] for one
  // episode submission.
  const toSkips = (
    timestamps: Array<{ at: number; type: { name: string } }>,
  ): Skip[] => {
    const sorted = [...timestamps].sort((a, b) => a.at - b.at);
    const out: Skip[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const mapped = ANIME_SKIP_TYPE[cur.type?.name];
      if (!mapped) continue;
      const next = sorted[i + 1];
      if (!next) continue;
      if (next.at - cur.at < 5) continue;
      out.push({
        start: Math.round(cur.at),
        end: Math.round(next.at),
        type: mapped,
      });
    }
    return out;
  };

  let best: Skip[] = [];
  for (const epList of epLists) {
    const episodes = epList?.findEpisodesByShowId || [];
    const ep =
      episodes.find((e) => Number(e.number) === episode) ||
      episodes.find((e) => Number(e.absoluteNumber) === episode);
    if (!ep) continue;
    const candidate = toSkips(ep.timestamps);
    if (candidate.length > best.length) best = candidate;
  }
  return best;
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
