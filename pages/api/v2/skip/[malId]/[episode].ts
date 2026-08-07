import type { NextApiRequest, NextApiResponse } from "next";
import { getOpedSkips, type OpedSkipRow } from "@/lib/db/opedSkips";
import { getHostSkip, type OpedHostSkipRow } from "@/lib/db/opedHostSkips";
import { serverToHost } from "@/lib/hostRegistry";
import {
  fetchFromAniSkip,
  fetchFromAnimeSkip,
  type Skip,
} from "@/lib/skip/providers";

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
      ? fetchFromAnimeSkip(aniListId, episode, episodeLength).catch((e: any) => {
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
