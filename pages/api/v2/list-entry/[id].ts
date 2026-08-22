import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { anilistFetch } from "@/lib/anilist/anilistFetch";

/**
 * GET /api/v2/list-entry/[id]
 *
 * The signed-in viewer's AniList list entry for one anime, and nothing else.
 *
 * Split out of GET /api/v2/media/[id] on 2026-08-22. That route merged this
 * field into its ~30 kB metadata payload, which made the whole response
 * per-user and therefore `private, no-store` — it was the one endpoint on the
 * site that never hit the edge cache. Keeping the per-user field in its own
 * ~100-byte response lets the heavy half be shared by everyone.
 *
 * Anonymous callers get `{ mediaListEntry: null }` rather than a 401: the
 * watch page only asks when it has a session, and a 401 in the console for a
 * signed-out viewer would read as a bug.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Number(req.query.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Missing or invalid id" });
  }

  // Per-user by construction — never let a shared cache store it.
  res.setHeader("Cache-Control", "private, no-store");

  const session: any = await getServerSession(req, res, authOptions);
  const accessToken: string | null = session?.user?.token || null;
  if (!accessToken) return res.status(200).json({ mediaListEntry: null });

  try {
    const json = await anilistFetch({
      query: `query ($id: Int) {
        Media (id: $id) {
          mediaListEntry { progress status customLists repeat }
        }
      }`,
      variables: { id },
      authToken: accessToken,
      timeoutMs: 3000,
      label: `media-listentry:${id}`,
      cacheSeconds: 0,
    });
    return res
      .status(200)
      .json({ mediaListEntry: json?.data?.Media?.mediaListEntry ?? null });
  } catch {
    /* The page degrades gracefully without list state — say "no entry" rather
       than erroring out the caller's fetch. */
    return res.status(200).json({ mediaListEntry: null });
  }
}
