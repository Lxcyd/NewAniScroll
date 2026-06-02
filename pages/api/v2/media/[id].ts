import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { getMediaMeta } from "@/lib/anilist/getMediaMeta";
import { anilistFetch } from "@/lib/anilist/anilistFetch";

/**
 * GET /api/v2/media/[id]
 *
 * Client-side Media fetch for the watch page's instant SPA navigation. The
 * watch page navigates with `router.push` (SPA — React tree stays mounted, no
 * full reload) and renders the player as soon as it has `info`. To avoid the
 * blocking SSR re-fetch on every navigation, the page mounts with whatever
 * `info` is in the shared client cache (primed by the anime info page) and
 * falls back to this endpoint when it's a cold/direct hit.
 *
 * `info` (FULL_MEDIA_FIELDS) is served from the warm three-layer cache
 * (memory → AniList → Turso) — almost always a memory hit because the info
 * page primed it. `mediaListEntry` is per-user and can't be cached, so when
 * the caller is signed in we fetch just that tiny field with their token and
 * merge it in.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Number(req.query.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Missing or invalid id" });
  }

  const media = await getMediaMeta(id);
  if (!media) {
    return res.status(404).json({ error: "Anime not found" });
  }

  // Per-user list entry — only when signed in. Small query, separate from the
  // cacheable metadata so the heavy `info` stays shareable across users.
  let mediaListEntry: any = null;
  const session: any = await getServerSession(req, res, authOptions);
  const accessToken: string | null = session?.user?.token || null;
  if (accessToken) {
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
      mediaListEntry = json?.data?.Media?.mediaListEntry ?? null;
    } catch {
      /* leave null — the page degrades gracefully without list state */
    }
  }

  // The metadata is shareable; the response as a whole is not (it carries the
  // signed-in user's list entry), so don't let any shared cache store it.
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json({ ...media, mediaListEntry });
}
