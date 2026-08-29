import type { NextApiRequest, NextApiResponse } from "next";
import { consumeToken, pruneTokens } from "@/lib/auth/tokens";
import { hashPassword, validatePassword } from "@/lib/auth/password";
import {
  findById,
  markEmailVerified,
  setPasswordHash,
} from "@/lib/auth/users";
import { checkThrottle, clientIp } from "@/lib/auth/throttle";

/**
 * Finish a password reset: { token, password }.
 *
 * Reaching a reset link proves control of the mailbox, so a still-unverified
 * address is marked verified here — otherwise a user who never clicked the
 * signup mail would stay unverified forever after a reset.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const gate = await checkThrottle(`resetdo:ip:${clientIp(req)}`, 20, 60 * 60 * 1000);
  if (!gate.ok) {
    return res.status(429).json({ error: "throttled", retryAfterMs: gate.retryAfterMs });
  }

  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");
  if (!token) return res.status(400).json({ error: "token" });

  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: "password", code: passwordError });

  const userId = await consumeToken(token, "reset");
  if (!userId) return res.status(400).json({ error: "invalidToken" });

  await setPasswordHash(userId, await hashPassword(password));

  const user = await findById(userId);
  if (user && user.email && !user.emailVerifiedAt) await markEmailVerified(userId);

  void pruneTokens();
  return res.status(200).json({ ok: true });
}
