import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { ensureAdminSchema, getAdminTursoClient } from "@/lib/db/turso-admin";

/**
 * GET /api/v2/admin/audit?q=&action=&limit=&offset=
 *
 * The audit log every admin mutation already writes to (logAuditEvent) had no
 * screen: it was written and never read. `actions` lists the distinct action
 * names so the tab can offer them as a filter instead of a free-text guess.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) return res.status(403).json({ error: "Forbidden" });
  res.setHeader("Cache-Control", "private, no-store");

  const db = getAdminTursoClient();
  if (!db) return res.status(500).json({ error: "Admin DB unavailable" });
  await ensureAdminSchema();

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const clauses: string[] = [];
  const args: any[] = [];
  if (typeof req.query.action === "string" && req.query.action) {
    clauses.push("action = ?");
    args.push(req.query.action);
  }
  if (typeof req.query.q === "string" && req.query.q.trim()) {
    const q = `%${req.query.q.trim().toLowerCase()}%`;
    clauses.push("(LOWER(actor) LIKE ? OR LOWER(target) LIKE ? OR LOWER(detail) LIKE ?)");
    args.push(q, q, q);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const [rows, count, actions] = await Promise.all([
      db.execute({
        sql: `SELECT id, actor, action, target, detail, created_at FROM audit_log
              ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
        args: [...args, limit, offset],
      }),
      db.execute({ sql: `SELECT COUNT(*) AS n FROM audit_log ${where}`, args }),
      db.execute(`SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC`),
    ]);
    return res.status(200).json({
      entries: rows.rows.map((r: any) => ({
        id: Number(r.id),
        actor: String(r.actor),
        action: String(r.action),
        target: r.target == null ? null : String(r.target),
        detail: r.detail == null ? null : String(r.detail),
        createdAt: Number(r.created_at) * 1000,
      })),
      total: Number((count.rows[0] as any)?.n ?? 0),
      actions: actions.rows.map((r: any) => ({ action: String(r.action), n: Number(r.n) })),
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
