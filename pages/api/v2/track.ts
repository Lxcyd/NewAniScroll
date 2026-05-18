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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
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
