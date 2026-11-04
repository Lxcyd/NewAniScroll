import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser, requireUser } from "@/lib/auth/session";
import { checkThrottle } from "@/lib/auth/throttle";
import {
  act,
  cleanFav,
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
 * GET ?of=<tag>      → les amis (acceptés) d'un profil — public, sauf profil privé
 * GET ?with=<tag>    → où j'en suis avec ce profil (bouton du profil)
 * GET ?q=<texte>     → chercher quelqu'un à ajouter
 * GET ?tastes=1      → mes amis avec leurs goûts (widget Affinité)
 * POST {action, tag} → request | accept | remove
 * PUT  {taste, fav}  → ranger mes goûts et mes favoris (envoyé par mon profil)
 *
 * L'identité vient toujours du cookie de session, jamais du corps. Les
 * écritures n'acceptent que du JSON : un formulaire d'un autre site (seul
 * envoi cross-site possible sans preflight) ne passe pas.
 */
const ACTIONS = new Set<FriendAction>(["request", "accept", "remove"]);
const TAG_RE = /^[0-9A-Za-z]{6}$/;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store");

  if (req.method === "GET" && typeof req.query.of === "string") {
    if (!TAG_RE.test(req.query.of)) return res.status(200).json({ friends: [] });
    /* Public, mais jamais d'invité : un profil sans compte n'a pas d'amis. */
    const viewer = await getSessionUser(req, res);
    return res.status(200).json({ friends: await publicFriends(req.query.of, viewer?.id ?? null) });
  }

  if (req.method === "GET" && typeof req.query.with === "string") {
    const me = await getSessionUser(req, res);
    if (!me) return res.status(200).json({ state: "guest" });
    if (!TAG_RE.test(req.query.with)) return res.status(200).json({ state: "none" });
    return res.status(200).json({ state: (await relation(me.id, req.query.with)) ?? "none" });
  }

  if ((req.method === "POST" || req.method === "PUT") && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return res.status(415).json({ error: "json" });
  }

  const me = await requireUser(req, res);
  if (!me) return;

  if (req.method === "GET") {
    if (typeof req.query.q === "string") {
      /* La recherche liste des comptes : bornée pour qu'on ne puisse pas
         aspirer l'annuaire (la fenêtre attend 250 ms entre deux frappes). */
      const t = await checkThrottle(`friend-search:${me.id}`, 60, 300_000);
      if (!t.ok) return res.status(429).json({ error: "throttled", users: [] });
      return res.status(200).json({ users: await searchUsers(me.id, req.query.q.slice(0, 40)) });
    }
    if (req.query.tastes) return res.status(200).json({ friends: await friendTastes(me.id) });
    return res.status(200).json(await listFriends(me.id));
  }

  if (req.method === "POST") {
    const action = req.body?.action as FriendAction;
    const tag = String(req.body?.tag ?? "");
    if (!ACTIONS.has(action) || !TAG_RE.test(tag)) return res.status(400).json({ error: "bad" });
    const state = await act(me.id, tag, action);
    if (state === "throttled") return res.status(429).json({ error: "throttled" });
    if (state === "full") return res.status(409).json({ error: "full" });
    if (state === "error") return res.status(400).json({ error: "refused" });
    return res.status(200).json({ state });
  }

  if (req.method === "PUT") {
    const taste = cleanTaste(req.body?.taste);
    if (!taste) return res.status(400).json({ error: "taste" });
    await putTaste(me.id, taste, cleanFav(req.body?.fav));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method" });
}
