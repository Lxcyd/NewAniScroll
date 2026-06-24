import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import {
  addMember,
  getChat,
  getSnapshot,
  isBanned,
  listMembers,
  publishEvent,
  roomExists,
} from "@/lib/watch2gether/redisRoom";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { roomId } = req.body || {};
  if (!roomId) return res.status(400).json({ error: "roomId is required" });

  try {
    if (!(await roomExists(roomId))) {
      return res.status(404).json({ error: "Room not found or expired" });
    }
    if (await isBanned(roomId, user.userId)) {
      return res.status(403).json({ error: "You are banned from this room" });
    }
    await addMember(roomId, user);

    const [snapshot, chat, members] = await Promise.all([
      getSnapshot(roomId),
      getChat(roomId),
      listMembers(roomId),
    ]);

    // Let everyone refresh their participant list.
    await publishEvent(roomId, {
      type: "presence",
      senderId: user.userId,
      ts: Date.now(),
      payload: { members },
    });

    return res.status(200).json({ snapshot, chat, members, me: user });
  } catch (e: any) {
    console.error("[w2g/join]", e?.message || e);
    return res.status(500).json({ error: "Failed to join room" });
  }
}
