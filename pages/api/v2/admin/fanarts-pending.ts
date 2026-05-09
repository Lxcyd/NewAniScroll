import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { getTursoClient } from "@/lib/db/turso";

/**
 * GET /api/v2/admin/fanarts-pending?cursor=N&limit=20
 *
 * Returns fanarts the IA flagged (suggestive | nsfw | error-perm) so the
 * admin can review them by hand. Cursor pagination on `anime_fanarts.id` for
 * a stable order even as labels are written by other workers.
 *
 * Manually-reviewed rows (label LIKE 'manual-%') are excluded — once you've
 * decided, we don't show them again unless the admin explicitly resets.
 *
 * Auth: same gate as /admin (session.user.name must equal ADMIN_USERNAME).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Not signed in" });
  if (session.user?.name !== process.env.ADMIN_USERNAME) {
    return res.status(403).json({ error: "Not admin" });
  }

  const cursor = Number(req.query.cursor);
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;

  // For the previous-button to work without re-paginating from scratch, we
  // accept either a forward `cursor` (id > cursor) or a backward `before`
  // (id < before).
  const before = Number(req.query.before);

  // Filter mode — picks which subset of labels to show.
  //   all (default): suggestive + nsfw + error-perm  (everything the IA
  //                  flagged that hasn't been reviewed)
  //   suggestive:    auto + manual suggestive
  //   nsfw:          auto + manual nsfw/explicit
  //   error:         auto + manual error
  //   reviewed:      every manual-* label — lets the admin revisit decisions
  const filter = String(req.query.filter || "all");

  const FILTER_LABELS: Record<string, string[]> = {
    all:        ["suggestive", "nsfw", "error-perm"],
    suggestive: ["suggestive", "manual-suggestive"],
    nsfw:       ["nsfw", "manual-nsfw", "manual-explicit"],
    error:      ["error-perm", "manual-error"],
    reviewed:   ["manual-safe", "manual-suggestive", "manual-nsfw",
                 "manual-explicit", "manual-error"],
  };
  const statuses = FILTER_LABELS[filter] || FILTER_LABELS.all;
  const placeholders = statuses.map(() => "?").join(",");

  const db = getTursoClient();
  if (!db) return res.status(503).json({ error: "DB unavailable" });

  // Build the WHERE depending on cursor vs before.
  // We always exclude manually-reviewed rows.
  let whereClause = `nsfw_label IN (${placeholders})`;
  const args: any[] = [...statuses];

  if (Number.isFinite(before) && before > 0) {
    whereClause += " AND f.id < ?";
    args.push(before);
  } else if (Number.isFinite(cursor) && cursor >= 0) {
    whereClause += " AND f.id > ?";
    args.push(cursor);
  }

  // Order: ascending for forward navigation, descending for backward (we
  // reverse the result back to ascending for the client).
  const orderDir = Number.isFinite(before) && before > 0 ? "DESC" : "ASC";

  try {
    // We need each (url, type) once — Pokémon shares 43 rows, etc. Doing
    // the GROUP BY directly on the joined table scanned ~30k rows and took
    // 2+ minutes. The fix: 2-stage query.
    //   Stage 1: pick the representative row id per (url, type) WITH the
    //            sort/limit applied. Uses idx_fanart_review and is fast.
    //   Stage 2: fetch the full row + JOIN with anime metadata for those
    //            ids only. ~20 rows max → trivial.
    const idsRow = await db.execute({
      sql: `SELECT MIN(id) AS id
              FROM anime_fanarts f
             WHERE ${whereClause}
             GROUP BY f.url, f.type
             ORDER BY id ${orderDir}
             LIMIT ?`,
      args: [...args, limit],
    });
    const ids = idsRow.rows.map((row: any) => Number(row.id));

    let r: { rows: any[] } = { rows: [] };
    if (ids.length > 0) {
      const placeholders2 = ids.map(() => "?").join(",");
      const orderBy = orderDir === "DESC" ? "DESC" : "ASC";
      r = await db.execute({
        sql: `SELECT f.id, f.anime_id, f.type, f.url, f.nsfw_label, f.nsfw_score,
                     f.likes, f.language, f.season,
                     json_extract(a.data, '$.title.userPreferred') AS title,
                     a.is_adult,
                     json_extract(a.data, '$.coverImage.color') AS color
                FROM anime_fanarts f
                JOIN anime a ON a.id = f.anime_id
               WHERE f.id IN (${placeholders2})
               ORDER BY f.id ${orderBy}`,
        args: ids,
      });
    }

    let items = r.rows.map((row: any) => ({
      id:        Number(row.id),
      animeId:   Number(row.anime_id),
      title:     row.title,
      type:      row.type,
      url:       row.url,
      label:     row.nsfw_label,
      nsfwScore: row.nsfw_score != null ? Number(row.nsfw_score) : null,
      likes:     Number(row.likes ?? 0),
      language:  row.language,
      season:    row.season != null ? Number(row.season) : null,
      isAdult:   Boolean(row.is_adult),
      color:     row.color,
    }));
    if (orderDir === "DESC") items.reverse();

    // Counts per bucket, deduplicated by (url, type). We previously did this
    // with a CTE that scanned every row and grouped — 6s on a fresh DB.
    // Now we run 4 small COUNT(DISTINCT url || type) queries, each filtered
    // by the relevant labels. Each one uses idx_fanart_review and finishes
    // in tens of ms.
    const [cSugg, cNsfw, cErr, cRev] = await Promise.all([
      db.execute({
        sql: `SELECT COUNT(*) AS n FROM (
                SELECT 1 FROM anime_fanarts
                 WHERE nsfw_label IN ('suggestive', 'manual-suggestive')
                 GROUP BY url, type)`,
        args: [],
      }),
      db.execute({
        sql: `SELECT COUNT(*) AS n FROM (
                SELECT 1 FROM anime_fanarts
                 WHERE nsfw_label IN ('nsfw', 'manual-nsfw', 'manual-explicit')
                 GROUP BY url, type)`,
        args: [],
      }),
      db.execute({
        sql: `SELECT COUNT(*) AS n FROM (
                SELECT 1 FROM anime_fanarts
                 WHERE nsfw_label IN ('error-perm', 'manual-error')
                 GROUP BY url, type)`,
        args: [],
      }),
      db.execute({
        sql: `SELECT COUNT(*) AS n FROM (
                SELECT 1 FROM anime_fanarts
                 WHERE nsfw_label LIKE 'manual-%'
                 GROUP BY url, type)`,
        args: [],
      }),
    ]);
    const c = {
      suggestive: cSugg.rows[0]?.n,
      nsfw:       cNsfw.rows[0]?.n,
      error_perm: cErr.rows[0]?.n,
      reviewed:   cRev.rows[0]?.n,
    };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      items,
      counts: {
        suggestive: Number(c.suggestive ?? 0),
        nsfw:       Number(c.nsfw ?? 0),
        errorPerm:  Number(c.error_perm ?? 0),
        reviewed:   Number(c.reviewed ?? 0),
      },
    });
  } catch (e: any) {
    console.error("[admin/fanarts-pending]", e?.message);
    return res.status(500).json({ error: e?.message });
  }
}
