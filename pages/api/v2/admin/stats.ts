import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { getTursoClient } from "@/lib/db/turso";
import { getFanartsClient } from "@/lib/db/turso-fanarts";
import { redis } from "@/lib/redis";
import {
  getAdminTursoClient,
  ensureAdminSchema,
} from "@/lib/db/turso-admin";

/* Anime/fanart COUNT(*) over the full table each touch ~100k+ rows on
   Turso. The dashboard polls /admin so a refresh-happy admin would burn
   the free-plan row budget fast. Cache the whole payload for 15 minutes
   in Redis — these numbers don't move enough to need real-time anyway.
   `?fresh=1` bypasses the cache when an admin really wants live data. */
const STATS_CACHE_KEY = "admin:stats:v1";
const STATS_TTL_S = 15 * 60;

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

  const bypassCache = req.query.fresh === "1";
  if (redis && !bypassCache) {
    try {
      const cached = await redis.get(STATS_CACHE_KEY);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(JSON.parse(cached));
      }
    } catch {
      /* fall through */
    }
  }

  const main = getTursoClient();
  const fanartsDb = getFanartsClient();
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
    safeScalar(fanartsDb, "SELECT COUNT(*) FROM anime_fanarts"),
    safeScalar(fanartsDb, "SELECT COUNT(*) FROM anime_fanarts WHERE nsfw_label IS NOT NULL"),
    safeScalar(fanartsDb, "SELECT COUNT(*) FROM anime_fanarts WHERE nsfw_label IS NULL"),
    safeScalar(fanartsDb, "SELECT COUNT(*) FROM anime_fanarts WHERE nsfw_label = 'nsfw'"),
    safeScalar(fanartsDb, "SELECT COUNT(*) FROM anime_fanarts WHERE nsfw_label = 'safe'"),
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

  const payload = {
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
  };

  if (redis) {
    try {
      await redis.set(STATS_CACHE_KEY, JSON.stringify(payload), "EX", STATS_TTL_S);
    } catch {
      /* non-fatal */
    }
  }

  res.setHeader("X-Cache", "MISS");
  res.status(200).json(payload);
}
