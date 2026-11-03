import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser, requireUser } from "@/lib/auth/session";
import {
  act,
  cleanTaste,
  friendTastes,
  listFriends,
  publicFriends,
  putTaste,
  relation,
  searchUsers,
  type FriendAction,
} from "@/lib/auth/friends";

/**
 * Les amis d'AniScroll (lib/auth/friends.ts).
 *
 * GET                → mes amis, demandes reçues, demandes envoyées
 * GET ?of=<tag>      → les amis (acceptés) d'un profil — public
 * GET ?with=<tag>    → où j'en suis avec ce profil (bouton du profil)
 * GET ?q=<texte>     → chercher quelqu'un à ajouter
 * GET ?tastes=1      → mes amis avec leurs goûts (widget Affinité)
 * POST {action, tag} → request | accept | remove
 * PUT  {taste}       → ranger mes goûts (envoyé par mon profil)
 *
 * L'identité vient toujours du cookie de session, jamais du corps.
 */
const ACTIONS = new Set<FriendAction>(["request", "accept", "remove"]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store");

  if (req.method === "GET" && typeof req.query.of === "string") {
    /* Public, mais jamais d'invité : un profil sans compte n'a pas d'amis. */
    return res.status(200).json({ friends: await publicFriends(req.query.of) });
  }

  if (req.method === "GET" && typeof req.query.with === "string") {
    const me = await getSessionUser(req, res);
    if (!me) return res.status(200).json({ state: "guest" });
    return res.status(200).json({ state: (await relation(me.id, req.query.with)) ?? "none" });
  }

  const me = await requireUser(req, res);
  if (!me) return;

  if (req.method === "GET") {
    if (typeof req.query.q === "string") {
      return res.status(200).json({ users: await searchUsers(me.id, req.query.q.slice(0, 40)) });
    }
    if (req.query.tastes) return res.status(200).json({ friends: await friendTastes(me.id) });
    return res.status(200).json(await listFriends(me.id));
  }

  if (req.method === "POST") {
    const action = req.body?.action as FriendAction;
    const tag = String(req.body?.tag ?? "");
    if (!ACTIONS.has(action) || !/^[0-9A-Za-z]{6}$/.test(tag)) return res.status(400).json({ error: "bad" });
    const state = await act(me.id, tag, action);
    if (state === "error") return res.status(400).json({ error: "refused" });
    return res.status(200).json({ state });
  }

  if (req.method === "PUT") {
    const taste = cleanTaste(req.body?.taste);
    if (!taste) return res.status(400).json({ error: "taste" });
    await putTaste(me.id, taste);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method" });
}
