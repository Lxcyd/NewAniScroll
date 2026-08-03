import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import { allowByIp } from "@/lib/watch2gether/rateLimit";
import { addMember, allocateRoomId, createRoom } from "@/lib/watch2gether/redisRoom";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // Per-IP throttle so a script can't mass-create rooms and exhaust the 4-digit
  // code space (each room holds a code for up to ROOM_TTL = 6h).
  if (!(await allowByIp(req, "create", "strict"))) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { aniId, epiNumber, dub, server, position, paused, positionKnown } = req.body || {};
  // Reject falsy AND the literal "undefined"/"null" strings a client String()
  // can produce from un-hydrated metadata — a room seeded with those sends every
  // joiner to /anime/watch/undefined/…, which crashes the page.
  const bad = (v: unknown) => {
    const s = String(v ?? "").trim();
    return s === "" || s === "undefined" || s === "null";
  };
  if (bad(aniId) || bad(epiNumber)) {
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
      // Default to paused (safe seed); only start "playing" when the client
      // explicitly reports the host was mid-playback at create time.
      paused: paused === false ? false : true,
      // Only false when the client couldn't read a live <video> (iframe embed),
      // so `position: 0` here means "unknown" and must not rewind the host.
      positionKnown: positionKnown !== false,
    });
    // Register the creator as the first member so they can emit events before
    // their SSE join() round-trip completes (the event route gates on this).
    await addMember(roomId, user);
    return res.status(201).json({ roomId });
  } catch (e: any) {
    console.error("[w2g/create]", e?.message || e);
    return res.status(500).json({ error: "Failed to create room" });
  }
}
