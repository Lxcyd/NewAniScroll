import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { getTursoClient } from "@/lib/db/turso";
import {
  getAdminTursoClient,
  ensureAdminSchema,
} from "@/lib/db/turso-admin";

/**
 * Returns dashboard stats. Admin-only.
 *
 * Pulls in parallel from two databases:
 *   - main Turso (anime + fanarts counts)
 *   - admin Turso (bans, analytics, reports)
 *
 * Every individual scalar fetch is wrapped in safeScalar() so a missing
 * table doesn't 500 the whole endpoint — UI gets `0` for that field and
 * the rest of the dashboard still renders.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const main = getTursoClient();
  const admin = getAdminTursoClient();
  if (admin) await ensureAdminSchema();

  const safeScalar = async (
    db: ReturnType<typeof getTursoClient>,
    sql: string,
  ): Promise<number> => {
    if (!db) return 0;
    try {
      const r = await db.execute(sql);
      const row = r.rows?.[0] as any;
      const v = row ? Object.values(row)[0] : 0;
      return Number(v) || 0;
    } catch {
      return 0;
    }
  };

  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const weekAgo = now - 7 * 86400;
  const monthAgo = now - 30 * 86400;

  const [
    anime,
    animeStale,
    fanarts,
    classified,
    unclassified,
    nsfw,
    safe,
    bannedIps,
    uniqueVisitors24h,
    uniqueVisitorsWeek,
    uniqueVisitorsMonth,
    uniqueVisitorsAll,
    pageviews24h,
    bugReports,
  ] = await Promise.all([
    safeScalar(main, "SELECT COUNT(*) FROM anime"),
    safeScalar(main, `SELECT COUNT(*) FROM anime WHERE expires_at < ${now}`),
    safeScalar(main, "SELECT COUNT(*) FROM anime_fanarts"),
    safeScalar(main, "SELECT COUNT(*) FROM anime_fanarts WHERE nsfw_label IS NOT NULL"),
    safeScalar(main, "SELECT COUNT(*) FROM anime_fanarts WHERE nsfw_label IS NULL"),
    safeScalar(main, "SELECT COUNT(*) FROM anime_fanarts WHERE nsfw_label = 'nsfw'"),
    safeScalar(main, "SELECT COUNT(*) FROM anime_fanarts WHERE nsfw_label = 'safe'"),
    safeScalar(admin, "SELECT COUNT(*) FROM banned_ips"),
    safeScalar(
      admin,
      `SELECT COUNT(DISTINCT visitor_id) FROM user_analytics WHERE created_at >= ${dayAgo}`
    ),
    safeScalar(
      admin,
      `SELECT COUNT(DISTINCT visitor_id) FROM user_analytics WHERE created_at >= ${weekAgo}`
    ),
    safeScalar(
      admin,
      `SELECT COUNT(DISTINCT visitor_id) FROM user_analytics WHERE created_at >= ${monthAgo}`
    ),
    safeScalar(
      admin,
      "SELECT COUNT(DISTINCT visitor_id) FROM user_analytics"
    ),
    safeScalar(
      admin,
      `SELECT COUNT(*) FROM user_analytics WHERE created_at >= ${dayAgo}`
    ),
    safeScalar(admin, "SELECT COUNT(*) FROM bug_reports WHERE resolved_at IS NULL"),
  ]);

  res.status(200).json({
    anime,
    animeStale,
    fanarts,
    classified,
    unclassified,
    nsfw,
    safe,
    bannedIps,
    uniqueVisitors24h,
    uniqueVisitorsWeek,
    uniqueVisitorsMonth,
    uniqueVisitorsAll,
    pageviews24h,
    bugReports,
  });
}
