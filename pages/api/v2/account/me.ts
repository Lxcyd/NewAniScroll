import type { NextApiRequest, NextApiResponse } from "next";
import { requireUser } from "@/lib/auth/session";
import {
  deleteAccount,
  setPasswordHash,
  toPublicUser,
  touchLastSeen,
} from "@/lib/auth/users";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/auth/password";
import { getAllData } from "@/lib/auth/userData";
import { consumeCode } from "@/lib/auth/tokens";
import { checkThrottle } from "@/lib/auth/throttle";

/**
 * GET    → the current profile (never a password hash).
 * PATCH  → change the password: { currentPassword, password }.
 * DELETE → erase the account and every backed-up category. Guarded by the
 *          current password when the account has one; an AniList-only
 *          account is already proven by its session.
 *
 * `?export=1` on the GET returns every stored category as well, which is the
 * "export my data" button in settings — and the reason deleting is safe to
 * offer next to it.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "GET") {
    void touchLastSeen(user.id);
    if (req.query.export === "1") {
      const data = await getAllData(user.id);
      return res.status(200).json({ user: toPublicUser(user), data });
    }
    return res.status(200).json({ user: toPublicUser(user) });
  }

  /**
   * Both sensitive actions below ask for the code mailed by
   * /api/v2/account/challenge. An open session is not enough on its own: a
   * borrowed laptop has the cookie, not the mailbox.
   *
   * Six digits only hold up behind a strict attempt limit, so verification is
   * throttled per user and the code is burned on first use either way.
   * An account with no address cannot be challenged, and falls back to the
   * session plus its current password.
   */
  async function codeAccepted(kind: "password" | "delete"): Promise<boolean> {
    if (!user!.email) return true;
    const gate = await checkThrottle(`code:try:${user!.id}:${kind}`, 5, 15 * 60 * 1000);
    if (!gate.ok) return false;
    return consumeCode(user!.id, kind, String(req.body?.code || ""));
  }

  if (req.method === "PATCH") {
    const password = String(req.body?.password || "");
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ error: "password", code: passwordError });
    }
    // An AniList-only account setting its first password has no current one to
    // prove; the mailed code is what stands in for it once an address exists.
    if (user.passwordHash) {
      const current = String(req.body?.currentPassword || "");
      if (!(await verifyPassword(current, user.passwordHash))) {
        return res.status(403).json({ error: "wrongPassword" });
      }
    }
    if (!(await codeAccepted("password"))) {
      return res.status(403).json({ error: "badCode" });
    }
    await setPasswordHash(user.id, await hashPassword(password));
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    if (user.passwordHash) {
      const current = String(req.body?.currentPassword || "");
      if (!(await verifyPassword(current, user.passwordHash))) {
        return res.status(403).json({ error: "wrongPassword" });
      }
    }
    if (!(await codeAccepted("delete"))) {
      return res.status(403).json({ error: "badCode" });
    }
    await deleteAccount(user.id);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method" });
}
