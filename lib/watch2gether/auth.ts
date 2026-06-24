// Shared identity helper for Watch2gether API routes.
//
// Watch parties are open to everyone: a signed-in AniList user is identified by
// their account, while an anonymous visitor passes a stable guest identity
// (generated + persisted client-side). Signed-in identity always wins.
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../pages/api/auth/[...nextauth]";
import type { Member } from "./redisRoom";

export async function getPartyUser(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<Member | null> {
  // 1) Prefer the authenticated AniList session. The AniList user id is on
  //    `id` (set by profile()) or `sub` (set by the userinfo request) depending
  //    on the path — accept either so a signed-in user is identified server-side
  //    with the SAME id the client computes (otherwise they'd be treated as a
  //    guest and never match as host/self).
  const session = await getServerSession(req, res, authOptions);
  const user: any = session?.user;
  const sessionUserId = user?.id ?? user?.sub;
  if (sessionUserId != null) {
    // AniList avatar object is { large, medium }; fall back gracefully.
    const image =
      typeof user.image === "string"
        ? user.image
        : user.image?.medium || user.image?.large || "";
    return { userId: String(sessionUserId), name: String(user.name || "User"), image };
  }

  // 2) Fall back to a guest identity supplied by the client.
  const src = req.method === "GET" ? req.query : req.body || {};
  const rawId = String(src.guestId || "").trim();
  if (!rawId) return null;
  // Namespace guest ids so they can never collide with numeric AniList ids.
  const userId = `g:${rawId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32)}`;
  if (userId === "g:") return null;
  const name = String(src.guestName || "").trim().slice(0, 24) || "Guest";
  return { userId, name, image: "" };
}

export function isGuest(member: Member): boolean {
  return member.userId.startsWith("g:");
}
