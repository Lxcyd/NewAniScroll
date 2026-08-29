import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { logAuditEvent } from "@/lib/db/turso-admin";
import { getUsersClient } from "@/lib/db/turso-users";
import {
  findById,
  isUsernameTaken,
  listUsers,
  markEmailVerified,
  setStatus,
  setUsername,
  toPublicUser,
} from "@/lib/auth/users";
import { validateUsername } from "@/lib/auth/username";

/**
 * Users tab of the admin panel.
 *
 *   GET  ?q=&limit=&offset=  → paginated list
 *   POST { id, action }      → 'disable' | 'enable' | 'verifyEmail' | 'rename'
 *
 * The response never carries a password hash: it goes through toPublicUser,
 * which drops the field by construction rather than by remembering to omit it.
 * Every mutation is written to the existing audit log.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) return res.status(403).json({ error: "Forbidden" });
  if (!getUsersClient()) return res.status(500).json({ error: "Users DB unavailable" });

  const actor = (session as any)?.user?.name || "unknown";

  if (req.method === "GET") {
    const { users, total } = await listUsers({
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    });
    return res.status(200).json({ users, total });
  }

  if (req.method === "POST") {
    const id = String(req.body?.id || "");
    const action = String(req.body?.action || "");
    if (!id) return res.status(400).json({ error: "id required" });

    const user = await findById(id);
    if (!user) return res.status(404).json({ error: "not found" });

    if (action === "disable" || action === "enable") {
      await setStatus(id, action === "disable" ? "disabled" : "active");
      await logAuditEvent(actor, `user_${action}`, id, user.username || user.tag);
    } else if (action === "verifyEmail") {
      if (!user.email) return res.status(400).json({ error: "noEmail" });
      await markEmailVerified(id);
      await logAuditEvent(actor, "user_verify_email", id, user.email);
    } else if (action === "rename") {
      const username = String(req.body?.username || "").trim();
      const code = validateUsername(username);
      if (code) return res.status(400).json({ error: "username", code });
      if (await isUsernameTaken(username)) {
        return res.status(409).json({ error: "usernameTaken" });
      }
      await setUsername(id, username);
      await logAuditEvent(actor, "user_rename", id, `${user.username} → ${username}`);
    } else {
      return res.status(400).json({ error: "unknown action" });
    }

    const updated = await findById(id);
    return res.status(200).json({ user: updated ? toPublicUser(updated) : null });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
