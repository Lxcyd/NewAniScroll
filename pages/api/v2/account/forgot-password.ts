import type { NextApiRequest, NextApiResponse } from "next";
import { findByEmail } from "@/lib/auth/users";
import { issueToken } from "@/lib/auth/tokens";
import { originFromRequest, sendResetEmail } from "@/lib/auth/mail";
import { checkThrottle, clientIp } from "@/lib/auth/throttle";

/**
 * Start a password reset.
 *
 * Always answers 200, whether or not the address exists: the response must
 * not tell an attacker which e-mails have an account here. The throttle is
 * keyed on both the IP and the address so neither axis can be used to
 * enumerate.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email" });

  const ip = clientIp(req);
  const byIp = await checkThrottle(`reset:ip:${ip}`, 10, 60 * 60 * 1000);
  const byEmail = await checkThrottle(`reset:email:${email}`, 3, 60 * 60 * 1000);
  if (!byIp.ok || !byEmail.ok) return res.status(200).json({ ok: true });

  const user = await findByEmail(email);
  // An AniList-only row has no password to reset; same silent 200.
  if (user?.email && user.passwordHash) {
    const token = await issueToken(user.id, "reset");
    if (token) await sendResetEmail(user.email, token, originFromRequest(req));
  }

  return res.status(200).json({ ok: true });
}
