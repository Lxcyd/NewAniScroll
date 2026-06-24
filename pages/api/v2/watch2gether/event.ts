import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import { rateLimiterRedis } from "@/lib/redis";
import {
  isMuted,
  isPlaybackBlocked,
  publishEvent,
  pushChat,
  roomExists,
  setSnapshotPartial,
  type ChatMessage,
  type PartyEventType,
} from "@/lib/watch2gether/redisRoom";

const PLAYBACK_TYPES: PartyEventType[] = ["play", "pause", "seek", "rate", "position", "episode", "server"];
const CHAT_MAX_LEN = 500;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // Reuse the project's general rate limiter (50 pts/sec) keyed per user.
  try {
    if (rateLimiterRedis) await rateLimiterRedis.consume(`w2g:${user.userId}`);
  } catch {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { roomId, type, payload } = req.body || {};
  if (!roomId || !type) return res.status(400).json({ error: "roomId and type are required" });

  try {
    if (!(await roomExists(roomId))) {
      return res.status(404).json({ error: "Room not found or expired" });
    }

    const ts = Date.now();

    if (PLAYBACK_TYPES.includes(type)) {
      // The host may block specific members from driving playback.
      if (await isPlaybackBlocked(roomId, user.userId)) {
        return res.status(403).json({ error: "The host blocked you from controlling playback" });
      }
      // Persist the relevant bits into the snapshot so late joiners are correct.
      const fields: Record<string, any> = {};
      if (type === "play") fields.paused = false;
      if (type === "pause") fields.paused = true;
      if (typeof payload?.position === "number") fields.position = payload.position;
      if (type === "rate" && typeof payload?.rate === "number") fields.rate = payload.rate;
      if (type === "episode") {
        if (payload?.epiNumber != null) fields.epiNumber = String(payload.epiNumber);
        if (payload?.dub != null) fields.dub = !!payload.dub;
        if (payload?.server != null) fields.server = String(payload.server);
        if (payload?.aniId != null) fields.aniId = String(payload.aniId);
        fields.position = Number(payload?.position) || 0;
        fields.paused = true;
      }
      if (type === "server" && payload?.server != null) {
        fields.server = String(payload.server);
      }
      if (Object.keys(fields).length) await setSnapshotPartial(roomId, fields);

      await publishEvent(roomId, { type, senderId: user.userId, ts, payload });
      return res.status(200).json({ ok: true });
    }

    if (type === "chat") {
      // Muted members can't post.
      if (await isMuted(roomId, user.userId)) {
        return res.status(403).json({ error: "You are muted" });
      }
      const text = String(payload?.text || "").trim().slice(0, CHAT_MAX_LEN);
      if (!text) return res.status(400).json({ error: "Empty message" });
      const msg: ChatMessage = {
        id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
        userId: user.userId,
        name: user.name,
        image: user.image,
        text,
        ts,
      };
      await pushChat(roomId, msg);
      await publishEvent(roomId, { type: "chat", senderId: user.userId, ts, payload: msg });
      return res.status(200).json({ ok: true, message: msg });
    }

    return res.status(400).json({ error: `Unsupported event type: ${type}` });
  } catch (e: any) {
    console.error("[w2g/event]", e?.message || e);
    return res.status(500).json({ error: "Failed to publish event" });
  }
}
