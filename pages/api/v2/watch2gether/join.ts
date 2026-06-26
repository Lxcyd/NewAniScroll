import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import { allowByIp } from "@/lib/watch2gether/rateLimit";
import {
  addMember,
  consumeInactive,
  getChat,
  getSnapshot,
  isBanned,
  isMember,
  isValidRoomId,
  listMembers,
  publishEvent,
  reapInactiveMembers,
  roomExists,
} from "@/lib/watch2gether/redisRoom";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // Per-IP throttle: the room code space is only 4 digits (10k), so /join is the
  // prime brute-force / enumeration vector. Keyed on IP (a guest's id is
  // client-supplied, so a user-key is bypassable). Legit reconnects stay well
  // under 20/s.
  if (!(await allowByIp(req, "join", "strict"))) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { roomId } = req.body || {};
  if (!isValidRoomId(roomId)) return res.status(400).json({ error: "valid roomId is required" });

  try {
    if (!(await roomExists(roomId))) {
      return res.status(404).json({ error: "Room not found or expired" });
    }
    if (await isBanned(roomId, user.userId)) {
      return res.status(403).json({ error: "You are banned from this room" });
    }
    // Reap timed-out members FIRST so the inactivity flag is set even when the
    // room was quiet/solo while this user's phone slept (otherwise nothing would
    // have triggered the reap, and they'd rejoin silently — the reported bug).
    await reapInactiveMembers(roomId);
    // Reaped for inactivity? Reject this (auto-)reconnect with a notice. One-shot:
    // consuming the flag means a deliberate manual rejoin right after succeeds.
    // (Skip if they're somehow still a member — only ex-members get the notice.)
    if (!(await isMember(roomId, user.userId)) && (await consumeInactive(roomId, user.userId))) {
      return res.status(403).json({ error: "Removed for inactivity" });
    }
    // When the room is locked, only existing members may (re)connect; new
    // arrivals are turned away. A reconnect of someone already in the room
    // (e.g. the SSE 55s recycle) must still succeed.
    const snap = await getSnapshot(roomId);
    if (snap?.locked && !(await isMember(roomId, user.userId))) {
      return res.status(403).json({ error: "This room is locked" });
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
