import type { NextApiRequest, NextApiResponse } from "next";
import { requireUser } from "@/lib/auth/session";
import {
  FEED_MAX_EVENTS,
  getAnilistFeed,
  putAnilistFeed,
  type FeedEvent,
} from "@/lib/auth/userData";

/**
 * Le fil d'activité AniList du compte (cf. lib/anilist/feedImport.ts).
 *
 *   GET  → { anilistId, last, oldest, done } — où reprendre la lecture.
 *   POST → { last, e: [[secondes, id, épisode], …], oldest?, done? } — les
 *          lignes lues, ajoutées à celles déjà rangées, et où en est la lecture
 *          du passé. `full: true` remplace tout.
 */
export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

function valid(x: unknown, now: number): x is FeedEvent {
  if (!Array.isArray(x) || x.length !== 3) return false;
  const [t, m, ep] = x;
  return (
    Number.isInteger(t) &&
    t > 1_000_000_000 &&
    t < now / 1000 + 86_400 &&
    Number.isInteger(m) &&
    m > 0 &&
    Number.isInteger(ep) &&
    ep > 0 &&
    ep < 10_000
  );
}

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
      n: feed?.e.length ?? 0,
      /* Les heures datees du fil (10/11/2026), pour les badges de serie, qui se
         calculent dans le navigateur : ~un entier par heure regardee, pas un par
         episode. Le navigateur en tire ses jours LOCAUX. */
      ...(req.query.hours
        ? { h: [...new Set((feed?.e ?? []).map((ev) => Math.floor(ev[0] / 3600)))].sort((a, b) => a - b) }
        : {}),
    });
  }

  if (req.method === "POST") {
    const now = Date.now();
    const last = Number(req.body?.last);
    const incoming = Array.isArray(req.body?.e) ? (req.body.e as unknown[]).filter((x) => valid(x, now)) : null;
    if (!Number.isInteger(last) || last < 0 || !incoming) return res.status(400).json({ error: "body" });

    const old = req.body?.full ? null : await getAnilistFeed(user.id);
    const seen = new Set<string>();
    const all: FeedEvent[] = [];
    for (const ev of [...incoming, ...(old?.e ?? [])] as FeedEvent[]) {
      const k = ev.join(":");
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(ev);
    }
    all.sort((a, b) => b[0] - a[0]);
    /* La reprise de la lecture du passé : la date la plus ancienne lue, et si
       on est arrivé au bout. */
    const sent = Number(req.body?.oldest);
    const oldest = [old?.oldest, Number.isInteger(sent) && sent > 0 ? sent : undefined]
      .filter((x): x is number => !!x)
      .reduce((a, b) => Math.min(a, b), Infinity);
    await putAnilistFeed(user.id, {
      last: Math.max(last, old?.last ?? 0),
      e: all.slice(0, FEED_MAX_EVENTS),
      ...(Number.isFinite(oldest) ? { oldest } : {}),
      ...(req.body?.done === true || old?.done ? { done: true } : {}),
    });
    return res.status(200).json({ n: Math.min(all.length, FEED_MAX_EVENTS) });
  }

  return res.status(405).json({ error: "method" });
}
