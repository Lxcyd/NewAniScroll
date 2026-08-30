import type { NextApiRequest, NextApiResponse } from "next";
import { requireUser } from "@/lib/auth/session";
import { setProfileBanner } from "@/lib/auth/users";
import { isAllowedBannerUrl } from "@/lib/profile/banner";

/**
 * PUT    → pin a banner on the signed-in account: { url, animeId?, title? }.
 * DELETE → un-pin it, so the profile follows the favourite anime again.
 *
 * The pinned URL is served to every visitor of the profile, which makes this an
 * arbitrary-URL field on a public page — hence the host allow-list in
 * lib/profile/banner.ts rather than a bare string write.
 *
 * A guest has no account and never reaches here: /en/profile/me keeps its
 * choice in localStorage, next to the list it is showing.
 */
const SOURCES = new Set(["background", "thumb", "banner", "anilist", "cover"]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "DELETE") {
    await setProfileBanner(user.id, null);
    return res.status(200).json({ ok: true, banner: null });
  }

  if (req.method === "PUT") {
    const url = req.body?.url;
    if (!isAllowedBannerUrl(url)) {
      return res.status(400).json({ error: "url" });
    }
    const animeId = Number(req.body?.animeId);
    const title = req.body?.title;
    /* The art KIND is stored with the URL: it decides whether the plate is worn
       as the page's background or as a strip (lib/profile/types.plateMode), and
       nothing downstream could infer it from the URL alone. */
    const source = SOURCES.has(String(req.body?.source))
      ? String(req.body?.source)
      : "background";
    const value = JSON.stringify({
      url,
      animeId: Number.isFinite(animeId) ? animeId : null,
      title: typeof title === "string" ? title.slice(0, 200) : null,
      source,
    });
    await setProfileBanner(user.id, value);
    return res.status(200).json({ ok: true, banner: JSON.parse(value) });
  }

  return res.status(405).json({ error: "method" });
}
