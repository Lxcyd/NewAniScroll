import type { NextApiRequest, NextApiResponse } from "next";
import { requireUser } from "@/lib/auth/session";
import { issueCode } from "@/lib/auth/tokens";
import { originFromRequest, sendCodeEmail } from "@/lib/auth/mail";
import { checkThrottle } from "@/lib/auth/throttle";

/**
 * Send a confirmation code to the account's address, for a change that needs
 * more than an open session: a new password, or deleting the account.
 *
 * A session cookie can be borrowed — an unlocked laptop is enough. Requiring a
 * code proves the mailbox is in reach too, which is the thing an attacker
 * sitting at someone's desk does not have.
 *
 * An account with no address (AniList-only) cannot be challenged; those
 * actions fall back to the session alone, and the route says so rather than
 * pretending to send something.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const user = await requireUser(req, res);
  if (!user) return;

  const action = String(req.body?.action || "");
  if (action !== "password" && action !== "delete") {
    return res.status(400).json({ error: "action" });
  }
  if (!user.email) return res.status(400).json({ error: "noEmail" });

  // Sending is what costs (a mail, and a Resend quota slot), so the limit is
  // on the send, not on the attempt — attempts are limited in me.ts.
  const gate = await checkThrottle(`code:send:${user.id}`, 5, 60 * 60 * 1000);
  if (!gate.ok) {
    return res.status(429).json({ error: "throttled", retryAfterMs: gate.retryAfterMs });
  }

  const code = await issueCode(user.id, action);
  if (!code) return res.status(503).json({ error: "accounts-unavailable" });

  await sendCodeEmail(user.email, code, action, originFromRequest(req));
  // The address is echoed back so the UI can say where to look, but only
  // because it is the signed-in user's own address.
  return res.status(200).json({ ok: true, email: user.email });
}
