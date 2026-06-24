import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import {
  banMember,
  getHostId,
  getSnapshot,
  listMembers,
  publishEvent,
  removeMember,
  roomExists,
  setHost,
  setMute,
  setRoomFlags,
} from "@/lib/watch2gether/redisRoom";

type Action = "kick" | "ban" | "mute" | "unmute" | "transfer-host" | "set-flags";
const ACTIONS: Action[] = ["kick", "ban", "mute", "unmute", "transfer-host", "set-flags"];

// Host-only moderation:
//   kick / ban       — remove a member (ban also blocks rejoin until disband)
//   mute / unmute    — toggle a member's chat
//   transfer-host    — hand the crown to another member
//   set-flags        — toggle room-level flags (playbackLocked / locked)
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { roomId, action, targetUserId, flags } = req.body || {};
  if (!roomId || !action) {
    return res.status(400).json({ error: "roomId and action are required" });
  }
  if (!ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of ${ACTIONS.join(", ")}` });
  }
  // Member-targeted actions require a target.
  const needsTarget = action !== "set-flags";
  if (needsTarget && !targetUserId) {
    return res.status(400).json({ error: "targetUserId is required" });
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
    if (needsTarget && targetUserId === user.userId) {
      return res.status(400).json({ error: "You can't moderate yourself" });
    }

    const ts = Date.now();
    const sender = user.userId;

    switch (action as Action) {
      case "kick":
      case "ban": {
        if (action === "ban") await banMember(roomId, targetUserId);
        await removeMember(roomId, targetUserId);
        await publishEvent(roomId, { type: action, senderId: sender, ts, payload: { targetUserId } });
        break;
      }
      case "mute":
      case "unmute": {
        await setMute(roomId, targetUserId, action === "mute");
        await publishEvent(roomId, { type: action, senderId: sender, ts, payload: { targetUserId } });
        break;
      }
      case "transfer-host": {
        await setHost(roomId, targetUserId);
        await publishEvent(roomId, {
          type: "host",
          senderId: sender,
          ts,
          payload: { hostId: targetUserId },
        });
        break;
      }
      case "set-flags": {
        const next: { playbackLocked?: boolean; locked?: boolean } = {};
        if (typeof flags?.playbackLocked === "boolean") next.playbackLocked = flags.playbackLocked;
        if (typeof flags?.locked === "boolean") next.locked = flags.locked;
        if (Object.keys(next).length === 0) {
          return res.status(400).json({ error: "no valid flags provided" });
        }
        await setRoomFlags(roomId, next);
        const snapshot = await getSnapshot(roomId);
        await publishEvent(roomId, { type: "settings", senderId: sender, ts, payload: { snapshot } });
        break;
      }
    }

    // Everyone refreshes the participant list (host/mute badges, removals).
    const members = await listMembers(roomId);
    await publishEvent(roomId, { type: "presence", senderId: sender, ts, payload: { members } });

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error("[w2g/moderate]", e?.message || e);
    return res.status(500).json({ error: "Failed to moderate" });
  }
}
