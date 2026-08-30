import type { NextApiRequest, NextApiResponse } from "next";
import { issueToken } from "@/lib/auth/tokens";
import { requireUser } from "@/lib/auth/session";
import { originFromRequest, sendVerifyEmail } from "@/lib/auth/mail";
import { checkThrottle } from "@/lib/auth/throttle";

/**
 * GET  ?token=…  → hand the token to the settings page, which confirms the
 *                  address and signs this device in. This is clicked from a
 *                  mail client, so it must answer with a redirect, never JSON.
 * POST           → resend the verification mail to the signed-in user.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    /* This route no longer confirms anything: it hands the token to the page,
       which submits it to the "verify" provider — that one burns it, marks the
       address confirmed and signs this device in, so confirming from a phone
       leaves that phone logged into the account it just confirmed.
       Consuming here instead would mean any mail scanner, link preview or
       antivirus that follows the URL burns the link before the human clicks.

       The #account fragment matters too: the settings page is long, the
       outcome is announced inside the account section, and without it the
       visitor lands at the top and sees nothing — which is exactly what
       happened to the first person who confirmed from a phone. */
    const token = String(req.query.token || "");
    if (!token) return res.redirect(302, "/en/settings?verify=invalid#account");
    return res.redirect(
      302,
      `/en/settings?verify=${encodeURIComponent(token)}#account`
    );
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
