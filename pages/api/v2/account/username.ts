import type { NextApiRequest, NextApiResponse } from "next";
import { isUsernameTaken, setUsername, toPublicUser } from "@/lib/auth/users";
import { validateUsername } from "@/lib/auth/username";
import { requireUser } from "@/lib/auth/session";
import { checkThrottle, clientIp } from "@/lib/auth/throttle";
import { getUsersClient } from "@/lib/db/turso-users";

/**
 * GET ?u=name → { available, code } for the live check in the signup form.
 * PUT { username } → rename the signed-in account.
 *
 * The GET is throttled per IP: it is the one endpoint that would otherwise
 * let anyone enumerate which pseudos exist, at the debounce rate of a form.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!getUsersClient()) return res.status(503).json({ error: "accounts-unavailable" });

  if (req.method === "GET") {
    const gate = await checkThrottle(`uname:ip:${clientIp(req)}`, 120, 10 * 60 * 1000);
    if (!gate.ok) return res.status(429).json({ error: "throttled" });

    const candidate = String(req.query.u || "");
    const code = validateUsername(candidate);
    if (code) return res.status(200).json({ available: false, code });
    const taken = await isUsernameTaken(candidate);
    return res.status(200).json({ available: !taken, code: taken ? "taken" : null });
  }

  if (req.method === "PUT") {
    const user = await requireUser(req, res);
    if (!user) return;

    const username = String(req.body?.username || "").trim();
    const code = validateUsername(username);
    if (code) return res.status(400).json({ error: "username", code });

    // Case-only change on one's own name is fine; anything else must be free.
    if (username.toLowerCase() !== (user.usernameLower ?? "")) {
      if (await isUsernameTaken(username)) {
        return res.status(409).json({ error: "usernameTaken" });
      }
    }

    const updated = await setUsername(user.id, username);
    return res.status(200).json({ user: updated ? toPublicUser(updated) : null });
  }

  return res.status(405).json({ error: "method" });
}
