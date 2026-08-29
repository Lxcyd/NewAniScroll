import type { NextApiRequest, NextApiResponse } from "next";
import { requireUser } from "@/lib/auth/session";
import { detachAniList, toPublicUser } from "@/lib/auth/users";

/**
 * DELETE → unlink AniList from the current AniScroll account.
 *
 * There is no POST: linking happens through the AniList OAuth round-trip in
 * pages/api/auth/[...nextauth].ts, where the identity is actually proven. A
 * route that took an anilist_id from the body would let anyone claim someone
 * else's AniList account.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "DELETE") return res.status(405).json({ error: "method" });

  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const updated = await detachAniList(user.id);
    return res.status(200).json({ user: updated ? toPublicUser(updated) : null });
  } catch (err: any) {
    // Unlinking the only credential would lock the account out for good.
    if (String(err?.message) === "anilist-only-account") {
      return res.status(400).json({ error: "anilistOnlyAccount" });
    }
    console.error("[link-anilist]", err);
    return res.status(500).json({ error: "server" });
  }
}
