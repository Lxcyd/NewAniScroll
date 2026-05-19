import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { getTursoClient } from "@/lib/db/turso";
import { getFanartsClient } from "@/lib/db/turso-fanarts";
import { redis } from "@/lib/redis";

/* Counts are derived from full-table GROUP-BY scans (~30k+ rows each).
   They change slowly relative to how often the admin loads this page,
   so cache the bucket counts in Redis for 10 minutes. The items list
   itself is still live (cursor pagination needs fresh data). */
const COUNTS_KEY = "admin:fanarts-pending:counts:v1";
const COUNTS_TTL_S = 10 * 60;

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

  // `fanarts` holds the anime_fanarts table (which may be on a dedicated
  // Turso DB — see lib/db/turso-fanarts.ts). `main` holds the `anime`
  // table we need for title/color/is_adult lookup. They're the same
  // client object when the split isn't configured, in which case we
  // could JOIN — but doing a two-DB safe lookup keeps the code identical
  // regardless of configuration.
  const fanarts = getFanartsClient();
  const main = getTursoClient();
  if (!fanarts || !main) return res.status(503).json({ error: "DB unavailable" });

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
    // Stage 1 (fanarts DB): pick representative row ids per (url, type)
    // for the requested filter / cursor window. Uses idx_fanart_review.
    const idsRow = await fanarts.execute({
      sql: `SELECT MIN(id) AS id
              FROM anime_fanarts f
             WHERE ${whereClause}
             GROUP BY f.url, f.type
             ORDER BY id ${orderDir}
             LIMIT ?`,
      args: [...args, limit],
    });
    const ids = idsRow.rows.map((row: any) => Number(row.id));

    let fanartRows: any[] = [];
    let animeById = new Map<number, { title: string | null; isAdult: boolean; color: string | null }>();
    if (ids.length > 0) {
      const placeholders2 = ids.map(() => "?").join(",");
      // Stage 2 (fanarts DB): fetch the full fanart rows for those ids.
      const r = await fanarts.execute({
        sql: `SELECT id, anime_id, type, url, nsfw_label, nsfw_score,
                     likes, language, season
                FROM anime_fanarts
               WHERE id IN (${placeholders2})
               ORDER BY id ${orderDir}`,
        args: ids,
      });
      fanartRows = r.rows as any[];

      // Stage 3 (main DB): batch-fetch anime metadata for the distinct
      // anime_ids. Avoids the cross-DB JOIN that would otherwise force
      // both tables onto the same Turso instance.
      const animeIds = Array.from(
        new Set(fanartRows.map((row: any) => Number(row.anime_id)))
      );
      if (animeIds.length > 0) {
        const aPh = animeIds.map(() => "?").join(",");
        const aRows = await main.execute({
          sql: `SELECT id,
                       json_extract(data, '$.title.userPreferred') AS title,
                       is_adult,
                       json_extract(data, '$.coverImage.color') AS color
                  FROM anime
                 WHERE id IN (${aPh})`,
          args: animeIds,
        });
        for (const a of aRows.rows as any[]) {
          animeById.set(Number(a.id), {
            title: a.title ?? null,
            isAdult: Boolean(a.is_adult),
            color: a.color ?? null,
          });
        }
      }
    }

    let items = fanartRows.map((row: any) => {
      const meta = animeById.get(Number(row.anime_id));
      return {
        id:        Number(row.id),
        animeId:   Number(row.anime_id),
        title:     meta?.title ?? null,
        type:      row.type,
        url:       row.url,
        label:     row.nsfw_label,
        nsfwScore: row.nsfw_score != null ? Number(row.nsfw_score) : null,
        likes:     Number(row.likes ?? 0),
        language:  row.language,
        season:    row.season != null ? Number(row.season) : null,
        isAdult:   meta?.isAdult ?? false,
        color:     meta?.color ?? null,
      };
    });
    if (orderDir === "DESC") items.reverse();

    // Counts per bucket, deduplicated by (url, type). Each query scans
    // tens of thousands of rows so we cache the result for 10 minutes.
    // Pagination clicks within that window reuse the cached counts and
    // only pay the cost of the small item-list query above.
    let c: {
      suggestive: number;
      nsfw: number;
      error_perm: number;
      reviewed: number;
    } | null = null;
    if (redis) {
      try {
        const cached = await redis.get(COUNTS_KEY);
        if (cached) c = JSON.parse(cached);
      } catch {
        /* fall through */
      }
    }
    if (!c) {
      const [cSugg, cNsfw, cErr, cRev] = await Promise.all([
        fanarts.execute({
          sql: `SELECT COUNT(*) AS n FROM (
                  SELECT 1 FROM anime_fanarts
                   WHERE nsfw_label IN ('suggestive', 'manual-suggestive')
                   GROUP BY url, type)`,
          args: [],
        }),
        fanarts.execute({
          sql: `SELECT COUNT(*) AS n FROM (
                  SELECT 1 FROM anime_fanarts
                   WHERE nsfw_label IN ('nsfw', 'manual-nsfw', 'manual-explicit')
                   GROUP BY url, type)`,
          args: [],
        }),
        fanarts.execute({
          sql: `SELECT COUNT(*) AS n FROM (
                  SELECT 1 FROM anime_fanarts
                   WHERE nsfw_label IN ('error-perm', 'manual-error')
                   GROUP BY url, type)`,
          args: [],
        }),
        fanarts.execute({
          sql: `SELECT COUNT(*) AS n FROM (
                  SELECT 1 FROM anime_fanarts
                   WHERE nsfw_label LIKE 'manual-%'
                   GROUP BY url, type)`,
          args: [],
        }),
      ]);
      c = {
        suggestive: Number(cSugg.rows[0]?.n ?? 0),
        nsfw:       Number(cNsfw.rows[0]?.n ?? 0),
        error_perm: Number(cErr.rows[0]?.n ?? 0),
        reviewed:   Number(cRev.rows[0]?.n ?? 0),
      };
      if (redis) {
        try {
          await redis.set(COUNTS_KEY, JSON.stringify(c), "EX", COUNTS_TTL_S);
        } catch {
          /* non-fatal */
        }
      }
    }

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
