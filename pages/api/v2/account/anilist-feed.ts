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
 *   GET  → { anilistId, last } — où reprendre la lecture.
 *   POST → { last, e: [[secondes, id, épisode], …] } — les nouvelles lignes,
 *          ajoutées à celles déjà rangées. `full: true` remplace tout (relecture
 *          complète : les lignes supprimées sur AniList disparaissent aussi).
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
    return res.status(200).json({ anilistId: user.anilistId, last: feed?.last ?? 0, n: feed?.e.length ?? 0 });
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
    await putAnilistFeed(user.id, { last: Math.max(last, old?.last ?? 0), e: all.slice(0, FEED_MAX_EVENTS) });
    return res.status(200).json({ n: Math.min(all.length, FEED_MAX_EVENTS) });
  }

  return res.status(405).json({ error: "method" });
}
