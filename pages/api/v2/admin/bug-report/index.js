import { getServerSession } from "next-auth";
import { authOptions } from "pages/api/auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import {
  getAdminTursoClient,
  ensureAdminSchema,
  logAuditEvent,
} from "@/lib/db/turso-admin";

// Accept large payloads because attached images travel inline as base64.
// 5 images × ~1.5 MB each → ~10 MB ceiling.
export const config = {
  api: { bodyParser: { sizeLimit: "12mb" } },
};

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB per image after base64 decode
const SPAM_WINDOW_S = 600; // 10 minutes
const SPAM_THRESHOLD = 3;  // > this many reports in window → block

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length) return xff[0];
  return req.socket?.remoteAddress || null;
}

/**
 * Bug-report endpoint backed by the admin Turso DB.
 *
 *   POST   → public; any user can file a report (anti-spam: max
 *            SPAM_THRESHOLD reports per IP within SPAM_WINDOW_S, then 429).
 *            Accepts up to MAX_IMAGES base64 images inline.
 *   GET    → admin-only; lists unresolved reports for the dashboard.
 *   DELETE → admin-only; marks a report resolved.
 */
export default async function handler(req, res) {
  const db = getAdminTursoClient();
  if (!db) {
    return res.status(500).json({ error: "Admin DB unavailable" });
  }
  await ensureAdminSchema();

  if (req.method === "POST") {
    const { data } = req.body || {};
    if (!data) return res.status(400).json({ error: "data required" });
    const session = await getServerSession(req, res, authOptions);
    const reporter = session?.user?.name || null;
    const ip = getClientIp(req);

    // Anti-spam: how many reports has this IP filed in the last window?
    if (ip) {
      const cutoff = Math.floor(Date.now() / 1000) - SPAM_WINDOW_S;
      const cnt = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM bug_reports
               WHERE reporter_ip = ? AND created_at >= ?`,
        args: [ip, cutoff],
      });
      const n = Number(cnt.rows?.[0]?.n) || 0;
      if (n >= SPAM_THRESHOLD) {
        return res.status(429).json({
          error: "spam_threshold",
          message:
            "You have submitted too many reports recently. Please wait a few minutes before sending another one.",
          retryAfterSeconds: SPAM_WINDOW_S,
        });
      }
    }

    // Validate images: array of data-URLs (data:image/png;base64,...).
    let images = [];
    if (Array.isArray(data.images)) {
      images = data.images.slice(0, MAX_IMAGES).filter((d) => {
        if (typeof d !== "string") return false;
        if (!d.startsWith("data:image/")) return false;
        // Rough size check: base64 length × 0.75 ≈ decoded bytes.
        const decoded = (d.length - d.indexOf(",") - 1) * 0.75;
        return decoded <= MAX_IMAGE_BYTES;
      });
    }

    const r = await db.execute({
      sql: `INSERT INTO bug_reports
              (title, url, description, severity, reporter, reporter_ip, images)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        data.title || null,
        data.url || null,
        data.desc || null,
        data.severity || null,
        reporter,
        ip,
        images.length ? JSON.stringify(images) : null,
      ],
    });
    return res.status(200).json({
      message: "Report received",
      id: Number(r.lastInsertRowid),
      imagesAccepted: images.length,
    });
  }

  // Admin gate from here on.
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const actor = session?.user?.name || "unknown";

  if (req.method === "GET") {
    const r = await db.execute(
      `SELECT id, title, url, description AS desc, severity, reporter,
              reporter_ip, images, created_at
         FROM bug_reports
        WHERE resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT 100`
    );
    // Parse the JSON-encoded images column for each row.
    const reports = r.rows.map((row) => ({
      ...row,
      images: row.images ? safeJsonParse(row.images) : [],
    }));
    return res.status(200).json({ reports });
  }

  if (req.method === "DELETE") {
    const { reportId } = req.body || {};
    if (!reportId) return res.status(400).json({ error: "reportId required" });
    await db.execute({
      sql: `UPDATE bug_reports
              SET resolved_at = strftime('%s','now')
            WHERE id = ?`,
      args: [Number(reportId)],
    });
    await logAuditEvent(actor, "report_resolve", String(reportId));
    return res.status(200).json({ message: "Report resolved" });
  }

  return res.status(405).json({ message: "Method not allowed" });
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return []; }
}
