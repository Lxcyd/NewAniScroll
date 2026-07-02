// TEMPORARY diagnostic — exposes exactly what the season resolution computes
// for an aniId, on BOTH paths (cached vs skipCache), plus the raw resolver
// output and the media relations actually seen. Remove after debugging.
//
//   GET /api/v2/source/debug-season?aniId=16498
//
// This is read-only and never writes player_map.

import { getMediaMeta } from "@/lib/anilist/getMediaMeta";
import { resolveSeasonNumber } from "@/lib/anilist/resolveSeason";
import { inspectVoiranime, __debugDetectSeasonNumber, __debugFindVoiranimeSlug, __debugVoiranimeTrace } from "./index";

export default async function handler(req, res) {
  const aniId = Number(req.query.aniId);
  if (!aniId) return res.status(400).json({ error: "aniId required" });

  const out = { aniId };

  // -1. The ACTUAL detectSeasonNumber the player path uses (no RO). This is the
  //     number the coherence guard compares against. If this is 2, the guard
  //     thinks "-2" is coherent and lets the poisoned row through.
  try {
    out.detectSeasonNumber_raw = await __debugDetectSeasonNumber(aniId);
  } catch (e) {
    out.detectSeasonNumber_error = String(e?.message || e);
  }

  // 0. What the REAL player path computes: inspectVoiranime runs the same
  //    detectSeasonNumber + findVoiranimeSlug the resolver uses. Its seasonNum
  //    and slug are the ground truth for the bug.
  try {
    const iv = await inspectVoiranime(aniId, "vostfr");
    out.inspectVoiranime = { seasonNum: iv.seasonNum, slug: iv.slug, found: iv.found };
  } catch (e) {
    out.inspectVoiranime_error = String(e?.message || e);
  }

  // The WRITER path: what slug does findVoiranimeSlug return for S1 (vostfr)?
  // If this returns shingeki-no-kyojin-2, the fallback search is generating the
  // poison even though detectSeasonNumber is 1.
  try {
    out.findVoiranimeSlug_S1 = await __debugFindVoiranimeSlug(aniId, "Shingeki no Kyojin", false, 1);
  } catch (e) {
    out.findVoiranimeSlug_error = String(e?.message || e);
  }

  // The FULL real path with a trace — shows mapRow served, guard result, slug.
  try {
    out.voiranimeTrace = await __debugVoiranimeTrace(aniId, "Shingeki no Kyojin");
  } catch (e) {
    out.voiranimeTrace_error = String(e?.message || e);
  }

  // 1. Raw multi-signal resolver (what inspect uses, indirectly).
  try {
    out.resolveSeasonNumber = await resolveSeasonNumber(aniId);
  } catch (e) {
    out.resolveSeasonNumber_error = String(e?.message || e);
  }

  // 2. Media relations as seen by the CACHED path (what the real resolver uses).
  try {
    const cached = await getMediaMeta(aniId);
    out.cached_media = {
      title: cached?.title?.romaji,
      seasonYear: cached?.seasonYear,
      startYear: cached?.startDate?.year,
      prequels: (cached?.relations?.edges || [])
        .filter((e) => e.relationType === "PREQUEL")
        .map((e) => ({
          id: e.node?.id,
          title: e.node?.title?.romaji,
          format: e.node?.format,
          seasonYear: e.node?.seasonYear,
          startYear: e.node?.startDate?.year,
        })),
    };
  } catch (e) {
    out.cached_media_error = String(e?.message || e);
  }

  // 3. Media relations as seen by the FRESH path (skipCache).
  try {
    const fresh = await getMediaMeta(aniId, { skipCache: true });
    out.fresh_media = {
      title: fresh?.title?.romaji,
      seasonYear: fresh?.seasonYear,
      startYear: fresh?.startDate?.year,
      prequels: (fresh?.relations?.edges || [])
        .filter((e) => e.relationType === "PREQUEL")
        .map((e) => ({
          id: e.node?.id,
          title: e.node?.title?.romaji,
          format: e.node?.format,
          seasonYear: e.node?.seasonYear,
          startYear: e.node?.startDate?.year,
        })),
    };
  } catch (e) {
    out.fresh_media_error = String(e?.message || e);
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(out);
}
