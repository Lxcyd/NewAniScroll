import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import {
  acquireThrottle,
  getSnapshot,
  isBanned,
  isInactive,
  isMember,
  isValidRoomId,
  listMembers,
  publishEvent,
  reapInactiveMembers,
  roomExists,
  touchPresence,
} from "@/lib/watch2gether/redisRoom";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { roomId } = req.body || {};
  if (!isValidRoomId(roomId)) return res.status(400).json({ error: "valid roomId is required" });

  try {
    if (!(await roomExists(roomId))) return res.status(404).json({ error: "Room not found" });
    // touchPresence adds the caller to the member set, so it must enforce the
    // same gates as join() — otherwise a banned/locked-out user could POST
    // /presence directly to sneak back in.
    if (await isBanned(roomId, user.userId)) {
      return res.status(403).json({ error: "You are banned from this room" });
    }
    // Reap timed-out members, then reject a heartbeat from someone reaped for
    // inactivity — otherwise touchPresence below would silently re-admit them
    // before the client's join() rejection strips the room.
    await reapInactiveMembers(roomId);
    if (!(await isMember(roomId, user.userId)) && (await isInactive(roomId, user.userId))) {
      return res.status(403).json({ error: "Removed for inactivity" });
    }
    const snap = await getSnapshot(roomId);
    if (snap?.locked && !(await isMember(roomId, user.userId))) {
      return res.status(403).json({ error: "This room is locked" });
    }
    await touchPresence(roomId, user);

    // Throttled prune + broadcast: once every ~6s (per room), recompute the
    // member list (which prunes anyone whose presence key lapsed — e.g. a tab
    // closed without the leave beacon) and push it so departed members vanish
    // for everyone promptly, instead of only on the next join/moderate action.
    if (await acquireThrottle(roomId, "presence-broadcast", 6)) {
      const members = await listMembers(roomId);
      await publishEvent(roomId, {
        type: "presence",
        senderId: "server",
        ts: Date.now(),
        payload: { members },
      });
    }
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error("[w2g/presence]", e?.message || e);
    return res.status(500).json({ error: "Failed to update presence" });
  }
}
