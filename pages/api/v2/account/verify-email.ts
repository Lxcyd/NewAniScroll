import type { NextApiRequest, NextApiResponse } from "next";
import { consumeToken, issueToken, pruneTokens } from "@/lib/auth/tokens";
import { markEmailVerified } from "@/lib/auth/users";
import { requireUser } from "@/lib/auth/session";
import { originFromRequest, sendVerifyEmail } from "@/lib/auth/mail";
import { checkThrottle } from "@/lib/auth/throttle";

/**
 * GET  ?token=…  → consume a verification link and redirect to the settings
 *                  page with a readable outcome in the query string. This is
 *                  clicked from a mail client, so it must answer with a
 *                  redirect, never JSON.
 * POST           → resend the verification mail to the signed-in user.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    /* The #account fragment matters: the settings page is long, the outcome is
       announced inside the account section, and without it the visitor lands
       at the top of the page and sees nothing — which is exactly what happened
       to the first person who confirmed from a phone. */
    const token = String(req.query.token || "");
    if (!token) return res.redirect(302, "/en/settings?verify=invalid#account");

    const userId = await consumeToken(token, "verify");
    if (!userId) return res.redirect(302, "/en/settings?verify=invalid#account");

    await markEmailVerified(userId);
    void pruneTokens();
    return res.redirect(302, "/en/settings?verify=ok#account");
  }

  if (req.method === "POST") {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.email) return res.status(400).json({ error: "noEmail" });
    if (user.emailVerifiedAt) return res.status(200).json({ ok: true, already: true });

    const gate = await checkThrottle(`verify:user:${user.id}`, 3, 60 * 60 * 1000);
    if (!gate.ok) {
      return res.status(429).json({ error: "throttled", retryAfterMs: gate.retryAfterMs });
    }

    const token = await issueToken(user.id, "verify");
    if (token) await sendVerifyEmail(user.email, token, originFromRequest(req));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method" });
}
