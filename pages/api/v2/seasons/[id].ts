import type { NextApiRequest, NextApiResponse } from "next";
import { resolveSeasonList } from "@/lib/anilist/seasonChain";
import { setEdgeErrorCache } from "@/lib/http/edgeCache";

/**
 * GET /api/v2/seasons/[id]
 *
 * The franchise's ordered season list, thinned to what a picker needs.
 *
 * The info page resolves the same list in its getServerSideProps, but the watch
 * page is the busiest route on the site and `resolveSeasonList` walks the
 * franchise (Redis, then getMediaMeta) — putting it in that SSR would tax every
 * episode open for a control most viewers never touch. So the season picker
 * fetches it after mount instead.
 *
 * A franchise's season list is the same for everybody and changes about once a
 * season, so the answer caches at the edge for a day: a warm season picker
 * costs one round trip per anime, mostly 304s, and does NOT spend an Upstash
 * command per viewer.
 */

const TTL_S = 24 * 60 * 60;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Number(req.query.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "Missing or invalid id" });
  }

  let seasons: any[] = [];
  try {
    seasons = await resolveSeasonList(id);
  } catch {
    // A failed walk is not "no seasons" — say nothing rather than caching a
    // lie that would hide the picker for a day.
    setEdgeErrorCache(res);
    return res.status(200).json([]);
  }

  /* An EMPTY list takes the short window too, and that is not the same case as
     the catch above — which is why it was missed. `resolveSeasonList` does not
     throw when the upstream is unreachable; it returns `[]`. So during the
     02/09/2026 AniList outage the catch never fired, the success path ran, and
     a "this anime has no seasons" answer went to the edge for a FULL DAY. An
     empty list is legitimate for a film or an OVA, so this isn't an error — it
     just isn't worth a day when it might be an artefact. */
  if (!seasons?.length) {
    setEdgeErrorCache(res, 300);
    return res.status(200).json([]);
  }

  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("CDN-Cache-Control", `public, s-maxage=${TTL_S}, stale-while-revalidate=86400`);
  return res.status(200).json(
    (seasons || []).map((s) => ({
      id: s.id,
      number: s.number,
      label: s.label,
      year: s.year ?? null,
      episodes: s.episodes ?? null,
      format: s.format ?? null,
      // Le statut voyage jusqu'au selecteur : une saison NOT_YET_RELEASED n'a
      // aucun episode a jouer, et l'y envoyer quand meme donne un lecteur qui
      // retombe sur les episodes de la saison precedente.
      status: s.status ?? null,
    }))
  );
}
