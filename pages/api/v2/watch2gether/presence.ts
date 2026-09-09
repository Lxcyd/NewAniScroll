import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import { allowByIp } from "@/lib/watch2gether/rateLimit";
import {
  acquireThrottle,
  isValidRoomId,
  listMembers,
  publishEvent,
  readRoomGate,
  reapInactiveMembers,
  touchPresence,
} from "@/lib/watch2gether/redisRoom";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { roomId } = req.body || {};
  if (!isValidRoomId(roomId)) return res.status(400).json({ error: "valid roomId is required" });

  // Per-IP backstop (a guest userId is client-supplied). Legit heartbeat is
  // 1 / 5s per client; 50/s/IP only trips on scripted abuse.
  if (!(await allowByIp(req, "presence", "normal"))) {
    return res.status(429).json({ error: "Too many requests" });
  }

  try {
    /* Reap FIRST, then read the gates — the reap is what flags a member as
       inactive, so reading before it would let a just-reaped user through for
       one more beat. Throttled to once every 30 s per room: MEMBER_TTL is five
       minutes, so nothing is decided any later than it used to be, and the
       broadcast branch below reaps again via listMembers every ~6 s anyway.
       Un-throttled, this ran on EVERY heartbeat of EVERY participant. */
    if (await acquireThrottle(roomId, "presence-reap", 30)) {
      await reapInactiveMembers(roomId);
    }

    /* One command for the five questions this route used to ask one at a time.
       touchPresence adds the caller to the member set, so it must enforce the
       same gates as join() — otherwise a banned/locked-out user could POST
       /presence directly to sneak back in. */
    const gate = await readRoomGate(roomId, user.userId);
    if (!gate.exists) return res.status(404).json({ error: "Room not found" });
    if (gate.banned) {
      return res.status(403).json({ error: "You are banned from this room" });
    }
    // Reject a heartbeat from someone reaped for inactivity — otherwise
    // touchPresence below would silently re-admit them before the client's
    // join() rejection strips the room.
    if (!gate.member && gate.inactive) {
      return res.status(403).json({ error: "Removed for inactivity" });
    }
    const snap = gate.snapshot;
    if (snap?.locked && !gate.member) {
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
