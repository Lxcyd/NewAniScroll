import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import {
  banMember,
  getHostId,
  listMembers,
  publishEvent,
  removeMember,
  roomExists,
} from "@/lib/watch2gether/redisRoom";

// Host-only moderation: kick (removable, can rejoin) or ban (cannot rejoin until
// the room is disbanded — bans expire with the room key).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { roomId, action, targetUserId } = req.body || {};
  if (!roomId || !action || !targetUserId) {
    return res.status(400).json({ error: "roomId, action and targetUserId are required" });
  }
  if (action !== "kick" && action !== "ban") {
    return res.status(400).json({ error: "action must be 'kick' or 'ban'" });
  }

  try {
    if (!(await roomExists(roomId))) {
      return res.status(404).json({ error: "Room not found or expired" });
    }

    // Only the current host may moderate.
    const hostId = await getHostId(roomId);
    if (hostId !== user.userId) {
      return res.status(403).json({ error: "Only the host can moderate" });
    }
    if (targetUserId === user.userId) {
      return res.status(400).json({ error: "You can't moderate yourself" });
    }

    const ts = Date.now();
    if (action === "ban") await banMember(roomId, targetUserId);
    await removeMember(roomId, targetUserId);

    // Tell the target to leave; everyone else just refreshes presence.
    await publishEvent(roomId, {
      type: action, // "kick" | "ban"
      senderId: user.userId,
      ts,
      payload: { targetUserId },
    });
    const members = await listMembers(roomId);
    await publishEvent(roomId, {
      type: "presence",
      senderId: user.userId,
      ts,
      payload: { members },
    });

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error("[w2g/moderate]", e?.message || e);
    return res.status(500).json({ error: "Failed to moderate" });
  }
}
