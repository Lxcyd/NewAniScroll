/**
 * Bridge between a NextAuth session and the `users` row it points at.
 *
 * Every account route starts here so the identity always comes from the
 * signed cookie (`uid` in the JWT) and never from the request body — the
 * exact hole the legacy /api/user/* routes had.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../pages/api/auth/[...nextauth]";
import { findById, type UserRecord } from "./users";

/** The fields our callbacks put on session.user. */
export type SessionUser = {
  uid?: string;
  tag?: string;
  username?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  role?: "user" | "admin";
  name?: string | null;
  image?: any;
  /** AniList access token — kept for the existing AniList calls. */
  token?: string;
  anilistId?: number | null;
};

export async function getSessionUser(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<UserRecord | null> {
  const session = (await getServerSession(req, res, authOptions)) as any;
  const uid = session?.user?.uid;
  if (!uid || typeof uid !== "string") return null;
  const user = await findById(uid);
  if (!user || user.status === "disabled") return null;
  return user;
}

/** Same, but writes the 401 for you. Returns null once it has answered. */
export async function requireUser(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<UserRecord | null> {
  const user = await getSessionUser(req, res);
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  return user;
}
