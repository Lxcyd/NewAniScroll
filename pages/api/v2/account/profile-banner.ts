import type { NextApiRequest, NextApiResponse } from "next";
import { requireUser } from "@/lib/auth/session";
import { setProfileBanner } from "@/lib/auth/users";
import { isAllowedBannerUrl } from "@/lib/profile/banner";
import {
  isAllowedMediaUrl,
  isVideoKind,
  normalizeDressing,
} from "@/lib/profile/dressing";

/**
 * PUT    → pin an habillage on the signed-in account (lib/profile/dressing.ts):
 *          `{ kind, url|color, animeId?, title?, source?, music?, blur? }`.
 * DELETE → un-pin it, so the profile follows the favourite anime again.
 *
 * Everything stored here is served to every visitor of the profile, which makes
 * it a set of arbitrary-URL fields on a public page — hence the host allow-lists
 * rather than bare string writes. Two lists, because the media are not
 * interchangeable: images come from the fanart mirrors (lib/profile/banner.ts),
 * video and music from AnimeThemes (lib/profile/dressing.ts).
 *
 * The old body — a bare `{url, animeId, title, source}` — still validates: it
 * normalises to a "banner" habillage, which is exactly what it was.
 *
 * A guest has no account and never reaches here: /en/profile/me keeps its
 * choice in localStorage, next to the list it is showing.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === "DELETE") {
    await setProfileBanner(user.id, null);
    return res.status(200).json({ ok: true, banner: null });
  }

  if (req.method === "PUT") {
    const dressing = normalizeDressing(req.body);
    if (!dressing) return res.status(400).json({ error: "shape" });

    /* Le fond. Une couleur n'a rien à valider au-delà de son écriture — c'est
       normalizeDressing qui l'a déjà refusée si ce n'était pas un #rrggbb. */
    /* Une bande-annonce n'a pas d'URL à valider : `normalizeDressing` n'a gardé
       son identifiant que s'il avait la forme exacte d'un id YouTube, et c'est
       la seule chose qui parte ensuite dans l'iframe. */
    if (dressing.kind !== "color" && !dressing.trailerId) {
      const ok = isVideoKind(dressing.kind)
        ? isAllowedMediaUrl(dressing.url)
        : isAllowedBannerUrl(dressing.url);
      if (!ok) return res.status(400).json({ error: "url" });
    }

    if (dressing.music && !isAllowedMediaUrl(dressing.music.url)) {
      return res.status(400).json({ error: "music" });
    }

    const value = JSON.stringify(dressing);
    await setProfileBanner(user.id, value);
    return res.status(200).json({ ok: true, banner: dressing });
  }

  return res.status(405).json({ error: "method" });
}
