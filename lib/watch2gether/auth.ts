// Shared session-extraction helper for Watch2gether API routes.
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../pages/api/auth/[...nextauth]";
import type { Member } from "./redisRoom";

export async function getPartyUser(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<Member | null> {
  const session = await getServerSession(req, res, authOptions);
  const user: any = session?.user;
  if (!user?.id) return null;
  // AniList avatar object is { large, medium }; fall back gracefully.
  const image =
    typeof user.image === "string" ? user.image : user.image?.medium || user.image?.large || "";
  return { userId: String(user.id), name: String(user.name || "User"), image };
}
