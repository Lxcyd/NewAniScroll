import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { getTursoClient } from "@/lib/db/turso";
import { getFanartsClient } from "@/lib/db/turso-fanarts";

/**
 * GET /api/v2/admin/fanarts-by-anime?anime=<anilist_id>
 *
 * Returns EVERY fanart row attached to one AniList id, including NSFW,
 * manual-* labels, and unclassified rows. The /admin/fanarts-by-anime UI
 * uses this to let the admin browse a single anime and reclassify any
 * image — the public /api/v2/fanarts endpoint can't be used here because
 * it hides everything that isn't `safe`.
 *
 * Auth: admin only.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) return res.status(403).json({ error: "Forbidden" });

  const animeId = Number(req.query.anime);
  if (!Number.isFinite(animeId) || animeId <= 0) {
    return res.status(400).json({ error: "Missing/invalid `anime` query param" });
  }

  // anime row lives on the main DB; fanart rows on the (potentially
  // separate) fanarts DB. See lib/db/turso-fanarts.ts.
  const main = getTursoClient();
  const fanarts = getFanartsClient();
  if (!main || !fanarts) return res.status(503).json({ error: "DB unavailable" });

  try {
    const [animeRow, fanartRows] = await Promise.all([
      main.execute({
        sql: "SELECT id, data FROM anime WHERE id = ?",
        args: [animeId],
      }),
      fanarts.execute({
        sql: `SELECT id, anime_id, type, url, language, likes, season,
                     nsfw_label, nsfw_score,
                     nsfw_drawing, nsfw_hentai, nsfw_neutral, nsfw_porn, nsfw_sexy,
                     classified_at
                FROM anime_fanarts
               WHERE anime_id = ?
               ORDER BY
                 CASE type
                   WHEN 'clearart'     THEN 1
                   WHEN 'logo'         THEN 2
                   WHEN 'poster'       THEN 3
                   WHEN 'background'   THEN 4
                   WHEN 'banner'       THEN 5
                   WHEN 'thumb'        THEN 6
                   WHEN 'seasonposter' THEN 7
                   WHEN 'seasonbanner' THEN 8
                   WHEN 'seasonthumb'  THEN 9
                   ELSE 99
                 END,
                 likes DESC`,
        args: [animeId],
      }),
    ]);

    let title: string | null = null;
    let cover: string | null = null;
    let banner: string | null = null;
    if (animeRow.rows.length > 0) {
      try {
        const data = JSON.parse(String((animeRow.rows[0] as any).data || "{}"));
        title = data?.title?.english || data?.title?.romaji || null;
        cover = data?.coverImage?.medium || data?.coverImage?.large || null;
        banner = data?.bannerImage || null;
      } catch {
        /* the row exists but its JSON column is unparseable — fall back to null
           and let the UI render a placeholder card header. */
      }
    }

    const items = fanartRows.rows.map((r: any) => ({
      id: Number(r.id),
      animeId: Number(r.anime_id),
      type: String(r.type),
      url: String(r.url),
      language: r.language != null ? String(r.language) : null,
      likes: Number(r.likes ?? 0),
      season: r.season != null ? Number(r.season) : null,
      label: r.nsfw_label != null ? String(r.nsfw_label) : null,
      nsfwScore: r.nsfw_score != null ? Number(r.nsfw_score) : null,
      scores: {
        drawing: r.nsfw_drawing != null ? Number(r.nsfw_drawing) : null,
        hentai:  r.nsfw_hentai  != null ? Number(r.nsfw_hentai)  : null,
        neutral: r.nsfw_neutral != null ? Number(r.nsfw_neutral) : null,
        porn:    r.nsfw_porn    != null ? Number(r.nsfw_porn)    : null,
        sexy:    r.nsfw_sexy    != null ? Number(r.nsfw_sexy)    : null,
      },
      classifiedAt: r.classified_at != null ? Number(r.classified_at) : null,
    }));

    // Counts per bucket for the header badges. Keeps the UI honest about how
    // many of each label the admin is looking at without doing arithmetic in
    // the browser on the full payload.
    const counts = {
      total: items.length,
      safe: 0,
      suggestive: 0,
      nsfw: 0,
      error: 0,
      unclassified: 0,
      manual: 0,
    };
    for (const it of items) {
      if (!it.label) counts.unclassified += 1;
      else if (it.label.startsWith("manual-")) counts.manual += 1;
      if (it.label === "safe" || it.label === "safe-skipped" || it.label === "manual-safe")
        counts.safe += 1;
      else if (it.label === "suggestive" || it.label === "manual-suggestive")
        counts.suggestive += 1;
      else if (it.label === "nsfw" || it.label === "manual-nsfw" || it.label === "manual-explicit")
        counts.nsfw += 1;
      else if (it.label === "error-perm" || it.label === "manual-error")
        counts.error += 1;
    }

    return res.status(200).json({
      animeId,
      title,
      cover,
      banner,
      counts,
      items,
    });
  } catch (e: any) {
    console.error("[admin/fanarts-by-anime]", e?.message);
    return res.status(500).json({ error: e?.message });
  }
}
