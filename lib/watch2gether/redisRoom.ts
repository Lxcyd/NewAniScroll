// Watch 2gether — Redis-backed ephemeral room state.
//
// All state lives in the project's existing Redis (ioredis via REDIS_URL,
// see lib/redis.ts). NO Vercel KV / Vercel database is used.
//
// Key design (prefix `w2g:`):
//   w2g:room:{id}            Hash   playback snapshot (source of truth for joiners)
//   w2g:room:{id}:members    Set    member userIds currently present
//   w2g:presence:{id}:{uid}  String JSON {name,image} — heartbeat key, short TTL
//   w2g:chat:{id}            List   recent chat messages (capped), JSON entries
//   w2g:channel:{id}         Pub/Sub channel for live event fan-out

import { redis } from "@/lib/redis";

export const ROOM_TTL = 6 * 60 * 60; // 6h
export const PRESENCE_TTL = 30; // seconds — refreshed by client heartbeat
export const CHAT_MAX = 100;

export type PartyEventType =
  | "play"
  | "pause"
  | "seek"
  | "rate"
  | "position"
  | "episode"
  | "chat"
  | "presence"
  | "snapshot";

export interface PartyEvent {
  type: PartyEventType;
  senderId: string;
  ts: number;
  payload?: any;
}

export interface RoomSnapshot {
  aniId: string;
  epiNumber: string;
  dub: boolean;
  server: string;
  position: number;
  paused: boolean;
  rate: number;
  hostId: string;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  name: string;
  image?: string;
  text: string;
  ts: number;
}

export interface Member {
  userId: string;
  name: string;
  image?: string;
}

const roomKey = (id: string) => `w2g:room:${id}`;
const membersKey = (id: string) => `w2g:room:${id}:members`;
const presenceKey = (id: string, uid: string) => `w2g:presence:${id}:${uid}`;
const chatKey = (id: string) => `w2g:chat:${id}`;
export const channelKey = (id: string) => `w2g:channel:${id}`;

function assertRedis() {
  if (!redis) throw new Error("REDIS_URL is not configured — Watch2gether is unavailable");
}

/** Short, URL-safe room id without adding a dependency. */
export function generateRoomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = require("crypto").randomBytes(8) as Buffer;
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export async function createRoom(
  roomId: string,
  init: Pick<RoomSnapshot, "aniId" | "epiNumber" | "dub" | "server" | "hostId"> &
    Partial<RoomSnapshot>,
): Promise<void> {
  assertRedis();
  const snapshot: RoomSnapshot = {
    aniId: String(init.aniId),
    epiNumber: String(init.epiNumber),
    dub: !!init.dub,
    server: String(init.server || ""),
    position: Number(init.position || 0),
    paused: init.paused ?? true,
    rate: Number(init.rate || 1),
    hostId: String(init.hostId),
    updatedAt: Date.now(),
  };
  await redis.hset(roomKey(roomId), serialize(snapshot));
  await redis.expire(roomKey(roomId), ROOM_TTL);
}

export async function roomExists(roomId: string): Promise<boolean> {
  assertRedis();
  return (await redis.exists(roomKey(roomId))) === 1;
}

export async function getSnapshot(roomId: string): Promise<RoomSnapshot | null> {
  assertRedis();
  const h = await redis.hgetall(roomKey(roomId));
  if (!h || Object.keys(h).length === 0) return null;
  return {
    aniId: h.aniId,
    epiNumber: h.epiNumber,
    dub: h.dub === "true",
    server: h.server,
    position: Number(h.position) || 0,
    paused: h.paused === "true",
    rate: Number(h.rate) || 1,
    hostId: h.hostId,
    updatedAt: Number(h.updatedAt) || 0,
  };
}

/** Apply a partial update to the snapshot and bump TTL. */
export async function setSnapshotPartial(
  roomId: string,
  fields: Partial<RoomSnapshot>,
): Promise<void> {
  assertRedis();
  const merged = { ...fields, updatedAt: Date.now() };
  await redis.hset(roomKey(roomId), serialize(merged));
  await redis.expire(roomKey(roomId), ROOM_TTL);
}

export async function addMember(roomId: string, member: Member): Promise<void> {
  assertRedis();
  await redis.sadd(membersKey(roomId), member.userId);
  await redis.expire(membersKey(roomId), ROOM_TTL);
  await touchPresence(roomId, member);
}

export async function removeMember(roomId: string, userId: string): Promise<void> {
  assertRedis();
  await redis.srem(membersKey(roomId), userId);
  await redis.del(presenceKey(roomId, userId));
}

/** Refresh a member's presence key TTL (heartbeat). */
export async function touchPresence(roomId: string, member: Member): Promise<void> {
  assertRedis();
  await redis.set(
    presenceKey(roomId, member.userId),
    JSON.stringify({ name: member.name, image: member.image || "" }),
    "EX",
    PRESENCE_TTL,
  );
  await redis.sadd(membersKey(roomId), member.userId);
  await redis.expire(membersKey(roomId), ROOM_TTL);
}

/** Build the live member list, pruning any whose presence key has expired. */
export async function listMembers(roomId: string): Promise<Member[]> {
  assertRedis();
  const ids = await redis.smembers(membersKey(roomId));
  if (!ids.length) return [];
  const members: Member[] = [];
  const stale: string[] = [];
  for (const userId of ids) {
    const raw = await redis.get(presenceKey(roomId, userId));
    if (!raw) {
      stale.push(userId);
      continue;
    }
    try {
      const p = JSON.parse(raw);
      members.push({ userId, name: p.name, image: p.image });
    } catch {
      stale.push(userId);
    }
  }
  if (stale.length) await redis.srem(membersKey(roomId), ...stale);
  return members;
}

export async function pushChat(roomId: string, msg: ChatMessage): Promise<void> {
  assertRedis();
  await redis.rpush(chatKey(roomId), JSON.stringify(msg));
  await redis.ltrim(chatKey(roomId), -CHAT_MAX, -1);
  await redis.expire(chatKey(roomId), ROOM_TTL);
}

export async function getChat(roomId: string): Promise<ChatMessage[]> {
  assertRedis();
  const raw = await redis.lrange(chatKey(roomId), 0, -1);
  return raw
    .map((r) => {
      try {
        return JSON.parse(r) as ChatMessage;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as ChatMessage[];
}

/** Fan-out an event to all SSE subscribers of the room. */
export async function publishEvent(roomId: string, event: PartyEvent): Promise<void> {
  assertRedis();
  await redis.publish(channelKey(roomId), JSON.stringify(event));
}

// ioredis hset expects string values; coerce everything.
function serialize(obj: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = typeof v === "boolean" ? String(v) : String(v);
  }
  return out;
}
