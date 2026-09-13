import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { ensureAdminSchema, getAdminTursoClient, logAuditEvent } from "@/lib/db/turso-admin";
import { getUsersClient } from "@/lib/db/turso-users";
import {
  clearUserData,
  countAdmins,
  deleteAccount,
  detachAniList,
  findById,
  listUsers,
  markEmailVerified,
  purgeOrphanData,
  revokeTokens,
  setRole,
  setStatus,
  setUsername,
  toPublicUser,
  userDetail,
  userStats,
  type UserFilters,
} from "@/lib/auth/users";
import { validateUsername } from "@/lib/auth/username";

/**
 * Users tab of the admin panel.
 *
 *   GET  ?q=&role=&status=&auth=&verified=&sort=&dir=&limit=&offset=
 *                              → { users, total, stats }
 *   GET  ?id=                  → one account in detail, plus its audit trail
 *   POST { id, action, … }     → see ACTIONS below
 *
 * No response ever carries a password hash or an AniList token: rows go
 * through toPublicUser, which drops them by construction. Every mutation is
 * written to the audit log.
 *
 * Guard rails that are not about permissions but about not locking the site
 * out of its own admin panel: an admin cannot demote, disable or delete
 * themselves, and the last admin cannot be demoted.
 */

const ENUMS = {
  role: ["user", "admin"],
  status: ["active", "disabled"],
  auth: ["password", "anilist", "both", "none"],
  verified: ["yes", "no"],
  sort: ["created", "lastSeen", "data", "name"],
  dir: ["asc", "desc"],
} as const;

function pick<K extends keyof typeof ENUMS>(v: unknown, k: K) {
  return (ENUMS[k] as readonly string[]).includes(String(v)) ? (String(v) as any) : undefined;
}

async function auditFor(userId: string) {
  const db = getAdminTursoClient();
  if (!db) return [];
  try {
    await ensureAdminSchema();
    const r = await db.execute({
      sql: `SELECT actor, action, detail, created_at FROM audit_log
             WHERE target = ? ORDER BY id DESC LIMIT 50`,
      args: [userId],
    });
    return r.rows.map((x: any) => ({
      actor: String(x.actor),
      action: String(x.action),
      detail: x.detail == null ? null : String(x.detail),
      createdAt: Number(x.created_at) * 1000,
    }));
  } catch {
    return [];
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!isAdminSession(session)) return res.status(403).json({ error: "Forbidden" });
  if (!getUsersClient()) return res.status(500).json({ error: "Users DB unavailable (TURSO_USERS_URL)" });
  res.setHeader("Cache-Control", "private, no-store");

  const me = (session as any)?.user;
  const actor = me?.username || me?.name || "unknown";

  if (req.method === "GET") {
    if (typeof req.query.id === "string") {
      const detail = await userDetail(req.query.id);
      if (!detail) return res.status(404).json({ error: "not found" });
      return res.status(200).json({ ...detail, audit: await auditFor(req.query.id) });
    }
    const filters: UserFilters = {
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      role: pick(req.query.role, "role"),
      status: pick(req.query.status, "status"),
      auth: pick(req.query.auth, "auth"),
      verified: pick(req.query.verified, "verified"),
      sort: pick(req.query.sort, "sort"),
      dir: pick(req.query.dir, "dir"),
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    };
    const [{ users, total }, stats] = await Promise.all([listUsers(filters), userStats()]);
    return res.status(200).json({ users, total, stats, me: me?.uid ?? null });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const action = String(req.body?.action || "");

  /* The one action that is not about a single account. */
  if (action === "purgeOrphans") {
    const n = await purgeOrphanData();
    await logAuditEvent(actor, "user_data_purge_orphans", null, `${n} rows`);
    return res.status(200).json({ removed: n });
  }

  const id = String(req.body?.id || "");
  if (!id) return res.status(400).json({ error: "id required" });
  const user = await findById(id);
  if (!user) return res.status(404).json({ error: "not found" });
  const label = user.username ? `${user.username}#${user.tag}` : `#${user.tag}`;
  const self = id === me?.uid;

  switch (action) {
    case "disable":
    case "enable":
      if (self && action === "disable") return res.status(400).json({ error: "Tu ne peux pas désactiver ton propre compte." });
      await setStatus(id, action === "disable" ? "disabled" : "active");
      await logAuditEvent(actor, `user_${action}`, id, label);
      break;

    case "verifyEmail":
      if (!user.email) return res.status(400).json({ error: "Ce compte n'a pas d'e-mail." });
      await markEmailVerified(id);
      await logAuditEvent(actor, "user_verify_email", id, user.email);
      break;

    case "rename": {
      const username = String(req.body?.username || "").trim();
      const code = validateUsername(username);
      if (code) return res.status(400).json({ error: `Pseudo refusé (${code}).` });
      await setUsername(id, username);
      await logAuditEvent(actor, "user_rename", id, `${user.username} → ${username}`);
      break;
    }

    case "promote":
    case "demote":
      if (action === "demote") {
        if (self) return res.status(400).json({ error: "Tu ne peux pas retirer ton propre rôle admin." });
        if (user.role === "admin" && (await countAdmins()) <= 1)
          return res.status(400).json({ error: "C'est le dernier admin." });
      }
      await setRole(id, action === "promote" ? "admin" : "user");
      await logAuditEvent(actor, `user_${action}`, id, label);
      break;

    case "revokeTokens": {
      const n = await revokeTokens(id);
      await logAuditEvent(actor, "user_revoke_tokens", id, `${n} tokens`);
      break;
    }

    case "clearData": {
      const kind = req.body?.kind ? String(req.body.kind) : undefined;
      const n = await clearUserData(id, kind);
      await logAuditEvent(actor, "user_clear_data", id, `${kind ?? "all"} (${n} rows)`);
      break;
    }

    case "detachAnilist":
      try {
        await detachAniList(id);
      } catch {
        return res.status(400).json({ error: "Compte AniList uniquement : le délier le rendrait inaccessible." });
      }
      await logAuditEvent(actor, "user_detach_anilist", id, user.anilistName);
      break;

    case "delete":
      if (self) return res.status(400).json({ error: "Tu ne peux pas supprimer ton propre compte ici." });
      /* The tag must be typed back: a delete is the one action with no undo. */
      if (String(req.body?.confirm || "") !== user.tag)
        return res.status(400).json({ error: "Confirmation incorrecte." });
      await deleteAccount(id);
      await logAuditEvent(actor, "user_delete", id, `${label} ${user.email ?? ""}`.trim());
      return res.status(200).json({ deleted: true });

    default:
      return res.status(400).json({ error: "unknown action" });
  }

  const updated = await findById(id);
  return res.status(200).json({ user: updated ? toPublicUser(updated) : null });
}
