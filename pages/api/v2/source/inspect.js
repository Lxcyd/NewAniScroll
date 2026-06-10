import { inspectAnimeSama, inspectVoiranime } from "./index";

/**
 * GET /api/v2/source/inspect?aniId=<id>&source=animesama|voiranime&lang=vostfr|vf
 *
 * Read-only audit endpoint. Runs the SAME resolution the player uses
 * (detectSeasonNumber + findSlug + season/episode listing) but stops BEFORE
 * stream extraction, returning the matching metadata:
 *
 *   { source, lang, found, slug, seasonNum, chosenSeasonDir, episodeCount, … }
 *
 * The audit script (scripts/audit-players.mjs) compares `episodeCount` against
 * the AniList episode count for the entry to find anime that resolve to the
 * WRONG season/slug (e.g. a Season 2 that falls back to the Season 1 panel) or
 * that are missing a player entirely.
 *
 * Never 500s — on any failure the helper returns { found: false }.
 */
export default async function handler(req, res) {
  const aniId = Number(req.query.aniId);
  const source = String(req.query.source || "animesama").toLowerCase();
  const lang = String(req.query.lang || "vostfr").toLowerCase() === "vf" ? "vf" : "vostfr";

  if (!aniId || !Number.isFinite(aniId)) {
    return res.status(400).json({ error: "Missing or invalid aniId" });
  }

  try {
    let result;
    if (source === "voiranime") {
      result = await inspectVoiranime(aniId, lang);
    } else if (source === "animesama") {
      result = await inspectAnimeSama(aniId, lang);
    } else {
      return res.status(400).json({ error: "Unknown source (use animesama|voiranime)" });
    }
    // Short edge cache — the underlying slug/season resolution is Redis-cached
    // anyway; this keeps a re-run of the audit cheap without pinning stale data.
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(result);
  } catch (e) {
    // The helpers already swallow errors, but guard the route too so the audit
    // batch always gets a JSON answer it can classify.
    return res.status(200).json({ source, lang, found: false, error: e?.message || String(e) });
  }
}
