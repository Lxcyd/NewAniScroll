import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import {
  getAdminTursoClient,
  ensureAdminSchema,
  logAuditEvent,
} from "@/lib/db/turso-admin";

/**
 * IP-ban admin endpoint. Backed by the dedicated admin Turso DB.
 *
 *   GET    → returns { bans: [{ ip, reason, created_at, created_by }, …] }
 *   POST   → { ip: string, reason?: string }      adds a ban
 *   DELETE → { ip: string }                       removes a ban
 *
 * All mutations are written to audit_log so admin actions stay traceable.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const actor = session?.user?.name || "unknown";

  const db = getAdminTursoClient();
  if (!db) return res.status(500).json({ error: "Admin DB unavailable" });
  await ensureAdminSchema();

  if (req.method === "GET") {
    const r = await db.execute(
      "SELECT ip, reason, created_at, created_by FROM banned_ips ORDER BY created_at DESC LIMIT 200"
    );
    return res.status(200).json({ bans: r.rows });
  }

  if (req.method === "POST") {
    const ip = String(req.body?.ip || "").trim();
    const reason = String(req.body?.reason || "").trim() || null;
    if (!ip) return res.status(400).json({ error: "ip required" });
    await db.execute({
      sql: `INSERT OR REPLACE INTO banned_ips (ip, reason, created_at, created_by)
            VALUES (?, ?, strftime('%s','now'), ?)`,
      args: [ip, reason, actor],
    });
    await logAuditEvent(actor, "ban_ip", ip, reason);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    const ip = String(req.body?.ip || "").trim();
    if (!ip) return res.status(400).json({ error: "ip required" });
    await db.execute({
      sql: "DELETE FROM banned_ips WHERE ip = ?",
      args: [ip],
    });
    await logAuditEvent(actor, "unban_ip", ip);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
