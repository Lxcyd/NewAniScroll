import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import { allocateRoomId, createRoom } from "@/lib/watch2gether/redisRoom";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { aniId, epiNumber, dub, server, position } = req.body || {};
  if (!aniId || !epiNumber) {
    return res.status(400).json({ error: "aniId and epiNumber are required" });
  }

  try {
    const roomId = await allocateRoomId();
    await createRoom(roomId, {
      aniId: String(aniId),
      epiNumber: String(epiNumber),
      dub: !!dub,
      server: String(server || ""),
      hostId: user.userId,
      position: Number(position) || 0,
      paused: true,
    });
    return res.status(201).json({ roomId });
  } catch (e: any) {
    console.error("[w2g/create]", e?.message || e);
    return res.status(500).json({ error: "Failed to create room" });
  }
}
