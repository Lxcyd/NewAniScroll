import type { NextApiRequest, NextApiResponse } from "next";
import { requireUser } from "@/lib/auth/session";
import {
  FEED_MAX_EVENTS,
  getAnilistFeed,
  putAnilistFeed,
  type FeedEvent,
} from "@/lib/auth/userData";
import { finsOf } from "@/lib/anilist/feedFins";
import { mergeFeed, validEvent as valid } from "@/lib/anilist/feedMerge";

/**
 * Le fil d'activité AniList du compte (cf. lib/anilist/feedImport.ts).
 *
 *   GET  → { anilistId, last, oldest, done } — où reprendre la lecture.
 *   GET ?fins=1 → en plus, `f` : { id: secondes }, quand chaque anime a été fini.
 *   POST → { last, e: [[secondes, id, épisode], …], oldest?, done? } — les
 *          lignes lues, ajoutées à celles déjà rangées, et où en est la lecture
 *          du passé. `full: true` remplace tout.
 */
export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!user.anilistId) return res.status(409).json({ error: "no-anilist" });

  if (req.method === "GET") {
    const feed = await getAnilistFeed(user.id);
    return res.status(200).json({
      anilistId: user.anilistId,
      last: feed?.last ?? 0,
      oldest: feed?.oldest ?? 0,
      done: !!feed?.done,
      cOldest: feed?.cOldest ?? 0,
      cDone: !!feed?.cDone,
      n: feed?.e.length ?? 0,
      /* Les heures datees du fil (10/11/2026), pour les badges de serie, qui se
         calculent dans le navigateur : ~un entier par heure regardee, pas un par
         episode. Le navigateur en tire ses jours LOCAUX. */
      ...(req.query.hours
        ? { h: [...new Set((feed?.e ?? []).map((ev) => Math.floor(ev[0] / 3600)))].sort((a, b) => a - b) }
        : {}),
      /* Les lignes elles-mêmes, pour les badges de rythme (24/11/2026). Les
         20 000 plus récentes : ce qui tient sans danger en localStorage. */
      ...(req.query.events ? { ev: (feed?.e ?? []).slice(0, 20_000), c: feed?.c ?? {} } : {}),
      ...(req.query.fins ?{ f: finsOf(feed?.e ?? [], feed?.c) } : {}),
    });
  }

  if (req.method === "POST") {
    const now = Date.now();
    const last = Number(req.body?.last);
    const incoming = Array.isArray(req.body?.e) ? (req.body.e as unknown[]).filter((x) => valid(x, now)) : null;
    if (!Number.isInteger(last) || last < 0 || !incoming) return res.status(400).json({ error: "body" });

    const old = req.body?.full ? null : await getAnilistFeed(user.id);
    /* La fusion est partagée avec tools/anilist-feed/backfill.mjs (25/11/2026). */
    const feed = mergeFeed(old, { ...req.body, last, e: incoming as FeedEvent[] }, now, FEED_MAX_EVENTS);
    await putAnilistFeed(user.id, feed);
    return res.status(200).json({ n: feed.e.length });
  }

  return res.status(405).json({ error: "method" });
}
