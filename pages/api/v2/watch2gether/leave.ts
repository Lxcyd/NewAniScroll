import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import { listMembers, publishEvent, removeMember } from "@/lib/watch2gether/redisRoom";

// Best-effort: called via navigator.sendBeacon on pagehide. Presence TTL also
// reaps members automatically, so a missed beacon is not fatal.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { roomId } = req.body || {};
  if (!roomId) return res.status(400).json({ error: "roomId is required" });

  try {
    // removeMember transfers host to the oldest remaining member if needed and
    // returns the (possibly new) hostId.
    const newHost = await removeMember(roomId, user.userId);
    const members = await listMembers(roomId);
    if (newHost) {
      await publishEvent(roomId, {
        type: "host",
        senderId: user.userId,
        ts: Date.now(),
        payload: { hostId: newHost },
      });
    }
    await publishEvent(roomId, {
      type: "presence",
      senderId: user.userId,
      ts: Date.now(),
      payload: { members },
    });
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error("[w2g/leave]", e?.message || e);
    return res.status(200).json({ ok: true }); // never block unload
  }
}
