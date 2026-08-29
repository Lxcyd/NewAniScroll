import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import {
  createAccount,
  findByEmail,
  findById,
  isUsernameTaken,
  toPublicUser,
  upgradeToAccount,
} from "@/lib/auth/users";
import { hashPassword, validatePassword } from "@/lib/auth/password";
import { validateUsername } from "@/lib/auth/username";
import { issueToken } from "@/lib/auth/tokens";
import { sendVerifyEmail } from "@/lib/auth/mail";
import { checkThrottle, clientIp } from "@/lib/auth/throttle";
import { getUsersClient } from "@/lib/db/turso-users";
import { isDataKind, putData } from "@/lib/auth/userData";

/**
 * Create an AniScroll account.
 *
 * Two shapes, one route:
 *   - no session          → a brand-new account;
 *   - active AniList one  → UPGRADE that row instead of creating a second.
 *     This is the "compte AniScroll par-dessus AniList" case: one account, the
 *     AniScroll side taking precedence, the anilist_id kept.
 *
 * `snapshot` optionally carries the visitor's local data so a guest doesn't
 * lose their list by signing up. It is written under the new user id before
 * we answer, so the client can sign in and pull immediately.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!getUsersClient()) return res.status(503).json({ error: "accounts-unavailable" });

  const ip = clientIp(req);
  const gate = await checkThrottle(`signup:ip:${ip}`, 5, 60 * 60 * 1000);
  if (!gate.ok) {
    return res.status(429).json({ error: "throttled", retryAfterMs: gate.retryAfterMs });
  }

  const email = String(req.body?.email || "").trim();
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "email" });
  }
  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: "username", code: usernameError });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: "password", code: passwordError });

  if (await findByEmail(email)) return res.status(409).json({ error: "emailTaken" });
  if (await isUsernameTaken(username)) return res.status(409).json({ error: "usernameTaken" });

  const session = (await getServerSession(req, res, authOptions)) as any;
  const existingId: string | undefined = session?.user?.uid;

  let user;
  try {
    const passwordHash = await hashPassword(password);
    if (existingId) {
      const existing = await findById(existingId);
      // Only an AniList-only row can be upgraded; a real account signing up
      // again is a mistake, not an upgrade.
      if (existing && !existing.passwordHash) {
        user = await upgradeToAccount(existingId, { username, email, passwordHash });
      }
    }
    if (!user) user = await createAccount({ username, email, passwordHash });
  } catch (err: any) {
    // Lost a race on one of the UNIQUE indexes between the checks above and
    // the insert. The index is the authority, so report the conflict.
    if (/UNIQUE/i.test(String(err?.message))) {
      return res.status(409).json({ error: "conflict" });
    }
    console.error("[signup]", err);
    return res.status(500).json({ error: "server" });
  }
  if (!user) return res.status(500).json({ error: "server" });

  // Carry the guest's local data over, best effort — a rejected category
  // (too large, unknown kind) must not fail the signup itself.
  const snapshot = req.body?.snapshot;
  if (snapshot && typeof snapshot === "object") {
    for (const [kind, payload] of Object.entries(snapshot)) {
      if (!isDataKind(kind)) continue;
      try {
        await putData(user.id, kind, payload);
      } catch {}
    }
  }

  const token = await issueToken(user.id, "verify");
  if (token) await sendVerifyEmail(email, token);

  return res.status(201).json({ user: toPublicUser(user) });
}
