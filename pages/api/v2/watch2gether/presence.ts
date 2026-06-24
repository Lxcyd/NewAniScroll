import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import { roomExists, touchPresence } from "@/lib/watch2gether/redisRoom";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { roomId } = req.body || {};
  if (!roomId) return res.status(400).json({ error: "roomId is required" });

  try {
    if (!(await roomExists(roomId))) return res.status(404).json({ error: "Room not found" });
    await touchPresence(roomId, user);
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error("[w2g/presence]", e?.message || e);
    return res.status(500).json({ error: "Failed to update presence" });
  }
}
