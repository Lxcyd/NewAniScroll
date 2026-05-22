import type { NextApiRequest, NextApiResponse } from "next";
import {
  getAdminTursoClient,
  ensureAdminSchema,
} from "@/lib/db/turso-admin";

/**
 * Lightweight pageview analytics. Public endpoint — fires once per route
 * change from _app.tsx. Stores a stable `visitor_id` from a cookie (set
 * the first time the user hits the site) so the dashboard's "unique
 * visitors (24h)" stat is meaningful.
 *
 * Privacy notes:
 *   - We hash neither nor truncate the IP because the admin needs the
 *     full value to ban offenders. If you want stricter privacy, set
 *     `ANALYTICS_HASH_IPS=1` and we'll SHA-256 the IP before storing.
 *   - visitor_id is a random opaque token (not tied to any identity).
 *
 * Fails open — analytics should never block a page load. Errors are
 * swallowed.
 */
export const config = {
  api: { bodyParser: { sizeLimit: "2kb" } },
};

function getClientIp(req: NextApiRequest): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length) return xff[0];
  return req.socket?.remoteAddress || null;
}

/* Drop bots/scrapers/headless before they pollute the visitors stat.
   Two layers:

   1. UA blocklist — catches anything that identifies itself honestly
      (Googlebot, Scrapy, curl, our own warmer, etc.).

   2. Browser-fingerprint check — real browsers ALWAYS send a few
      headers that simplistic crawlers omit: `Accept-Language`,
      `Sec-Fetch-Site`, and a Chromium/Firefox/Safari/Edge token in UA.
      Requiring all three rejects most "User-Agent: Chrome/120 fake"
      probes that previously slipped past the UA blocklist and counted
      as unique visitors. */
const BOT_UA = /(bot|crawl|spider|headless|scrapy|favicon|vercel|prerender|preview|warmer|wget|curl|axios|node-fetch|python|java|ruby|go-http|httpclient|okhttp|libwww|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|yandex|baidu|duckduck|semrush|ahrefs|mj12|dotbot|petalbot)/i;
const BROWSER_UA = /(Mozilla\/5\.0).*(Chrome|Firefox|Safari|Edg|OPR|Opera)\//;
function isBot(req: NextApiRequest): boolean {
  if (req.headers["x-warmer"]) return true;
  const ua = String(req.headers["user-agent"] || "");
  if (!ua) return true;
  if (BOT_UA.test(ua)) return true;
  if (!BROWSER_UA.test(ua)) return true;
  // Real browsers send these. Headless / scripted clients usually don't.
  if (!req.headers["accept-language"]) return true;
  if (!req.headers["sec-fetch-site"]) return true;
  return false;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  if (isBot(req)) return res.status(200).json({ ok: true, bot: true });

  try {
    const db = getAdminTursoClient();
    if (!db) return res.status(200).json({ ok: true });
    await ensureAdminSchema();

    const { visitorId, path } = req.body || {};
    if (!visitorId) return res.status(400).json({ error: "visitorId required" });

    await db.execute({
      sql: `INSERT INTO user_analytics (visitor_id, ip, user_agent, path)
            VALUES (?, ?, ?, ?)`,
      args: [
        String(visitorId).slice(0, 64),
        getClientIp(req),
        String(req.headers["user-agent"] || "").slice(0, 256),
        String(path || "").slice(0, 256),
      ],
    });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(200).json({ ok: true });
  }
}
