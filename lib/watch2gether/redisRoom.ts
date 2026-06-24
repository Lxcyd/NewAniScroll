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
import type { ChatMessage, Member, PartyEvent, RoomSnapshot } from "./types";

// Re-export the shared types so existing `from "@/lib/watch2gether/redisRoom"`
// type imports (API routes) keep working. The canonical home is ./types, which
// is dependency-free so client code never reaches `ioredis` through it.
export type { ChatMessage, Member, PartyEvent, PartyEventType, RoomSnapshot } from "./types";

export const ROOM_TTL = 6 * 60 * 60; // 6h
// Presence TTL kept tight so a member who closes the tab (sendBeacon may not
// fire) vanishes quickly. Heartbeat (client) must be < TTL with margin.
export const PRESENCE_TTL = 12; // seconds — refreshed by client heartbeat
export const CHAT_MAX = 100;

const roomKey = (id: string) => `w2g:room:${id}`;
const membersKey = (id: string) => `w2g:room:${id}:members`;
const orderKey = (id: string) => `w2g:room:${id}:order`;
const bansKey = (id: string) => `w2g:room:${id}:bans`;
const mutesKey = (id: string) => `w2g:room:${id}:mutes`;
const pbBlockKey = (id: string) => `w2g:room:${id}:pbblock`;
const presenceKey = (id: string, uid: string) => `w2g:presence:${id}:${uid}`;
const chatKey = (id: string) => `w2g:chat:${id}`;
export const channelKey = (id: string) => `w2g:channel:${id}`;

function assertRedis() {
  if (!redis) throw new Error("REDIS_URL is not configured — Watch2gether is unavailable");
}

/** A room id is a 4-5 digit code (allocateRoomId may extend to 5 on collision).
 *  Validating it in routes keeps malicious/oversized ids out of Redis keys. */
export function isValidRoomId(id: unknown): id is string {
  return typeof id === "string" && /^\d{4,5}$/.test(id);
}

/** Random 4-digit room code (0000–9999), usable both as the URL id and as the
 *  manual join code. */
function random4(): string {
  const n = require("crypto").randomInt(0, 10000) as number;
  return String(n).padStart(4, "0");
}

/** Allocate an unused 4-digit room code. Retries on collision; falls back to a
 *  longer code in the (very unlikely) event the 4-digit space is saturated. */
export async function allocateRoomId(): Promise<string> {
  assertRedis();
  for (let i = 0; i < 12; i++) {
    const code = random4();
    if ((await redis.exists(roomKey(code))) === 0) return code;
  }
  // Extremely unlikely: extend the space rather than fail.
  return `${random4()}${require("crypto").randomInt(0, 10)}`;
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
    locked: false,
  };
  await redis.hset(roomKey(roomId), serialize(snapshot));
  await redis.expire(roomKey(roomId), ROOM_TTL);
}

export async function roomExists(roomId: string): Promise<boolean> {
  assertRedis();
  return (await redis.exists(roomKey(roomId))) === 1;
}

/** True only if the user is ACTIVELY present (has a live presence key), not
 *  merely lingering in the members set. Used for the locked-room gate so a stale
 *  set entry (e.g. a reused 4-digit room code) can't let a non-member back in. */
export async function isMember(roomId: string, userId: string): Promise<boolean> {
  assertRedis();
  return (await redis.exists(presenceKey(roomId, userId))) === 1;
}

/** True if the user is in the room's member set OR actively present. Used to
 *  gate event emission (chat/playback): tolerant of brief presence-key gaps for
 *  a legitimate member, while still rejecting someone who never joined (e.g. a
 *  room-code brute-forcer). */
export async function canEmit(roomId: string, userId: string): Promise<boolean> {
  assertRedis();
  if ((await redis.sismember(membersKey(roomId), userId)) === 1) return true;
  return (await redis.exists(presenceKey(roomId, userId))) === 1;
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
    locked: h.locked === "true",
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
  // Track join order (NX = keep the first join time) for host transfer.
  await redis.zadd(orderKey(roomId), "NX", Date.now(), member.userId);
  await redis.expire(orderKey(roomId), ROOM_TTL);
  await touchPresence(roomId, member);
}

/** Remove a member. If they were the host, transfer host to the oldest remaining
 *  member. Returns the (possibly new) hostId, or null if the room is now empty. */
export async function removeMember(
  roomId: string,
  userId: string,
): Promise<string | null> {
  assertRedis();
  await redis.srem(membersKey(roomId), userId);
  await redis.zrem(orderKey(roomId), userId);
  await redis.del(presenceKey(roomId, userId));

  const currentHost = await getHostId(roomId);
  if (currentHost && currentHost === userId) {
    const next = await oldestMember(roomId);
    if (next) {
      await setHost(roomId, next);
      return next;
    }
    return null; // room emptied — host stays recorded but nobody's present
  }
  return currentHost;
}

/** The earliest-joined member still in the order set, or null. */
export async function oldestMember(roomId: string): Promise<string | null> {
  assertRedis();
  const res = await redis.zrange(orderKey(roomId), 0, 0);
  return res[0] || null;
}

export async function getHostId(roomId: string): Promise<string | null> {
  assertRedis();
  return (await redis.hget(roomKey(roomId), "hostId")) || null;
}

export async function setHost(roomId: string, userId: string): Promise<void> {
  assertRedis();
  await redis.hset(roomKey(roomId), { hostId: userId, updatedAt: String(Date.now()) });
  await redis.expire(roomKey(roomId), ROOM_TTL);
  // A host can't be muted or playback-blocked — clear any such flag on promotion
  // (whether via explicit transfer or automatic succession when the host leaves).
  await redis.srem(mutesKey(roomId), userId);
  await redis.srem(pbBlockKey(roomId), userId);
}

// ── Bans ──
// Bans live in a Set tied to the room's lifetime: when the room key/TTL lapses
// (everyone left, room disbanded), the ban set expires too — so a freshly
// created room with the same code starts with a clean slate.
export async function banMember(roomId: string, userId: string): Promise<void> {
  assertRedis();
  await redis.sadd(bansKey(roomId), userId);
  await redis.expire(bansKey(roomId), ROOM_TTL);
}

export async function isBanned(roomId: string, userId: string): Promise<boolean> {
  assertRedis();
  return (await redis.sismember(bansKey(roomId), userId)) === 1;
}

// ── Mutes ──
// A muted member stays in the room but the event route rejects their chat. The
// mute set is tied to the room TTL like bans.
export async function setMute(roomId: string, userId: string, muted: boolean): Promise<void> {
  assertRedis();
  if (muted) {
    await redis.sadd(mutesKey(roomId), userId);
    await redis.expire(mutesKey(roomId), ROOM_TTL);
  } else {
    await redis.srem(mutesKey(roomId), userId);
  }
}

export async function isMuted(roomId: string, userId: string): Promise<boolean> {
  assertRedis();
  return (await redis.sismember(mutesKey(roomId), userId)) === 1;
}

export async function getMutes(roomId: string): Promise<Set<string>> {
  assertRedis();
  return new Set(await redis.smembers(mutesKey(roomId)));
}

// ── Per-member playback block ──
// A blocked member stays in the room but the event route rejects their playback
// events (play/pause/seek/episode/server). Tied to the room TTL like mutes.
export async function setPlaybackBlock(
  roomId: string,
  userId: string,
  blocked: boolean,
): Promise<void> {
  assertRedis();
  if (blocked) {
    await redis.sadd(pbBlockKey(roomId), userId);
    await redis.expire(pbBlockKey(roomId), ROOM_TTL);
  } else {
    await redis.srem(pbBlockKey(roomId), userId);
  }
}

export async function isPlaybackBlocked(roomId: string, userId: string): Promise<boolean> {
  assertRedis();
  return (await redis.sismember(pbBlockKey(roomId), userId)) === 1;
}

export async function getPlaybackBlocks(roomId: string): Promise<Set<string>> {
  assertRedis();
  return new Set(await redis.smembers(pbBlockKey(roomId)));
}

// ── Room settings (host-only flags stored in the room hash) ──
export async function setRoomFlags(
  roomId: string,
  flags: Partial<Pick<RoomSnapshot, "locked">>,
): Promise<void> {
  assertRedis();
  const out: Record<string, string> = { updatedAt: String(Date.now()) };
  if (typeof flags.locked === "boolean") out.locked = String(flags.locked);
  await redis.hset(roomKey(roomId), out);
  await redis.expire(roomKey(roomId), ROOM_TTL);
}

/** Acquire a short-lived per-room throttle lock. Returns true to the FIRST
 *  caller within the window, false to the rest. Used so that only one heartbeat
 *  per window triggers the (relatively heavy) prune+broadcast of the member
 *  list — keeping departed members from lingering without spamming the channel
 *  on every client's heartbeat. */
export async function acquireThrottle(roomId: string, key: string, seconds: number): Promise<boolean> {
  assertRedis();
  const res = await redis.set(`w2g:throttle:${roomId}:${key}`, "1", "EX", seconds, "NX");
  return res === "OK";
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
  // Keep this member in the join-order zset (NX = preserve their first-seen
  // time). Without this, a heartbeat that lands after a stale-prune re-adds the
  // member to the set but not the order set, scrambling the rendered order.
  await redis.zadd(orderKey(roomId), "NX", Date.now(), member.userId);
  await redis.expire(orderKey(roomId), ROOM_TTL);
}

/** Build the live member list, pruning any whose presence key has expired, and
 *  flagging the host. */
export async function listMembers(roomId: string): Promise<Member[]> {
  assertRedis();
  // Iterate in join order (oldest first) so the UI renders members left→right by
  // arrival. The order zset is the source of truth; any member set entry missing
  // from it (shouldn't happen) is appended at the end.
  const ordered = await redis.zrange(orderKey(roomId), 0, -1);
  const present = await redis.smembers(membersKey(roomId));
  if (!present.length) return [];
  const presentSet = new Set(present);
  const orderedSet = new Set(ordered);
  const ids = [
    ...ordered.filter((id) => presentSet.has(id)),
    ...present.filter((id) => !orderedSet.has(id)),
  ];
  const hostId = await getHostId(roomId);
  const mutes = await getMutes(roomId);
  const pbBlocks = await getPlaybackBlocks(roomId);
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
      members.push({
        userId,
        name: p.name,
        image: p.image,
        isHost: userId === hostId,
        muted: mutes.has(userId),
        playbackBlocked: pbBlocks.has(userId),
      });
    } catch {
      stale.push(userId);
    }
  }
  if (stale.length) {
    await redis.srem(membersKey(roomId), ...stale);
    await redis.zrem(orderKey(roomId), ...stale);
  }
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
