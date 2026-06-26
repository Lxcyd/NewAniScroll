import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import { rateLimiterRedis } from "@/lib/redis";
import { allowByIp } from "@/lib/watch2gether/rateLimit";
import {
  canEmit,
  isBanned,
  isMuted,
  isPlaybackBlocked,
  isValidRoomId,
  publishEvent,
  pushChat,
  roomExists,
  setSnapshotPartial,
  type ChatMessage,
  type PartyEventType,
} from "@/lib/watch2gether/redisRoom";

// Clamp a numeric payload field to a sane finite range (defends against NaN /
// Infinity / absurd values from a malicious or buggy client).
function clampNum(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

const PLAYBACK_TYPES: PartyEventType[] = ["play", "pause", "seek", "rate", "position", "episode", "server"];
const CHAT_MAX_LEN = 500;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // Two limiters: per-user (50/s, smooths a single client's bursts) AND per-IP
  // (a guest's userId is client-supplied, so the user-key alone is bypassable by
  // rotating guestId — the IP key is the real abuse guard).
  try {
    if (rateLimiterRedis) await rateLimiterRedis.consume(`w2g:${user.userId}`);
  } catch {
    return res.status(429).json({ error: "Too many requests" });
  }
  if (!(await allowByIp(req, "event", "normal"))) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const { roomId, type, payload } = req.body || {};
  if (!isValidRoomId(roomId) || !type) {
    return res.status(400).json({ error: "valid roomId and type are required" });
  }

  try {
    if (!(await roomExists(roomId))) {
      return res.status(404).json({ error: "Room not found or expired" });
    }

    // Only ACTIVE members of the room may emit events. Without this, anyone who
    // guesses the 4-digit room code (brute-forceable) could spam chat or hijack
    // playback without ever joining. A banned user is rejected outright.
    if (await isBanned(roomId, user.userId)) {
      return res.status(403).json({ error: "You are banned from this room" });
    }
    if (!(await canEmit(roomId, user.userId))) {
      return res.status(403).json({ error: "Join the room before sending events" });
    }

    const ts = Date.now();

    if (PLAYBACK_TYPES.includes(type)) {
      // The host may block specific members from driving playback.
      if (await isPlaybackBlocked(roomId, user.userId)) {
        return res.status(403).json({ error: "The host blocked you from controlling playback" });
      }
      // Persist the relevant bits into the snapshot so late joiners are correct.
      // All numbers are clamped and strings are length-capped to keep the Redis
      // hash bounded regardless of what a client sends.
      const fields: Record<string, any> = {};
      if (type === "play") fields.paused = false;
      if (type === "pause") fields.paused = true;
      const pos = clampNum(payload?.position, 0, 24 * 60 * 60); // ≤ 24h
      if (pos !== undefined) fields.position = pos;
      if (type === "rate") {
        const rate = clampNum(payload?.rate, 0.25, 4);
        if (rate !== undefined) fields.rate = rate;
      }
      if (type === "episode") {
        if (payload?.epiNumber != null) fields.epiNumber = String(payload.epiNumber).slice(0, 16);
        if (payload?.dub != null) fields.dub = !!payload.dub;
        if (payload?.server != null) fields.server = String(payload.server).slice(0, 64);
        if (payload?.aniId != null) fields.aniId = String(payload.aniId).slice(0, 16);
        fields.position = clampNum(payload?.position, 0, 24 * 60 * 60) ?? 0;
        fields.paused = true;
      }
      if (type === "server" && payload?.server != null) {
        fields.server = String(payload.server).slice(0, 64);
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
