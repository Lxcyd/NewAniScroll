import type { NextApiRequest, NextApiResponse } from "next";
import { setUsername, toPublicUser } from "@/lib/auth/users";
import { validateUsername } from "@/lib/auth/username";
import { requireUser } from "@/lib/auth/session";
import { getUsersClient } from "@/lib/db/turso-users";

/**
 * PUT { username } → rename the signed-in account.
 *
 * There used to be a GET here answering "is this pseudo free". Pseudos are no
 * longer unique — the tag is what tells two "Lucyd" apart — so the question
 * has no answer to give, and the endpoint that answered it was also the one
 * place where anyone could enumerate which pseudos exist. The form validates
 * the shape locally with the same lib/auth/username rules.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!getUsersClient()) return res.status(503).json({ error: "accounts-unavailable" });

  if (req.method === "PUT") {
    const user = await requireUser(req, res);
    if (!user) return;

    const username = String(req.body?.username || "").trim();
    const code = validateUsername(username);
    if (code) return res.status(400).json({ error: "username", code });

    const updated = await setUsername(user.id, username);
    return res.status(200).json({ user: updated ? toPublicUser(updated) : null });
  }

  return res.status(405).json({ error: "method" });
}
