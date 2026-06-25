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
// Presence (ONLINE) TTL — short, refreshed by the client heartbeat. Its
// expiry no longer REMOVES a member; it only flips them to "offline" (e.g. a
// phone that went to sleep). Membership itself is durable (see MEMBER_TTL).
export const PRESENCE_TTL = 12; // seconds — refreshed by client heartbeat
// Membership safety net. A member stays in the room (avatar shown, slot kept)
// even while offline — through phone sleep, a backgrounded tab, etc. They're
// only removed on an explicit leave / kick / ban, OR if no heartbeat has
// arrived for MEMBER_TTL (a missed `pagehide` beacon from a real departure /
// crash). 5 min comfortably covers a sleeping phone while still reaping ghosts.
export const MEMBER_TTL_MS = 5 * 60 * 1000; // 5 min
export const CHAT_MAX = 100;

const roomKey = (id: string) => `w2g:room:${id}`;
const membersKey = (id: string) => `w2g:room:${id}:members`;
const orderKey = (id: string) => `w2g:room:${id}:order`;
const bansKey = (id: string) => `w2g:room:${id}:bans`;
const mutesKey = (id: string) => `w2g:room:${id}:mutes`;
const pbBlockKey = (id: string) => `w2g:room:${id}:pbblock`;
const presenceKey = (id: string, uid: string) => `w2g:presence:${id}:${uid}`;
// Durable per-member profile (name/image) that survives presence-key expiry, so
// a sleeping member's avatar/name still render. Hash: userId -> JSON.
const profilesKey = (id: string) => `w2g:room:${id}:profiles`;
// Last-seen wall-clock (ms) per member, for the MEMBER_TTL safety prune. Zset:
// userId -> lastSeenMs. Distinct from `order` (first-seen, never bumped).
const seenKey = (id: string) => `w2g:room:${id}:seen`;
// Members reaped for inactivity (no heartbeat for MEMBER_TTL). One-shot: the
// next (re)connect is rejected with an "inactive" notice and the flag is
// consumed, so a deliberate manual rejoin afterwards succeeds. Set, room TTL.
const inactiveKey = (id: string) => `w2g:room:${id}:inactive`;
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
/** True if the user belongs to the room — based on the DURABLE member set, not
 *  the short online presence key. A member whose phone is asleep (presence
 *  expired) is still a member, so a locked-room gate must not 403 them out when
 *  their device wakes and reconnects. */
export async function isMember(roomId: string, userId: string): Promise<boolean> {
  assertRedis();
  return (await redis.sismember(membersKey(roomId), userId)) === 1;
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
  // Track join order (NX = keep the first join time) for host transfer + render
  // order. This timestamp is NEVER bumped afterwards, so a member who goes
  // offline and comes back keeps their original slot.
  await redis.zadd(orderKey(roomId), "NX", Date.now(), member.userId);
  await redis.expire(orderKey(roomId), ROOM_TTL);
  // A successful (re)join clears any lingering inactivity flag so they're not
  // wrongly told "removed for inactivity" on a later reconnect.
  await redis.srem(inactiveKey(roomId), member.userId);
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
  await redis.zrem(seenKey(roomId), userId);
  await redis.hdel(profilesKey(roomId), userId);
  await redis.del(presenceKey(roomId, userId));
  // Explicit removal (leave/kick/ban) isn't an inactivity reap — drop any
  // inactive flag so a rejoin reports the right reason (or just succeeds).
  await redis.srem(inactiveKey(roomId), userId);

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

/** The earliest-joined member to inherit the host role. Prefers the oldest
 *  member who is ONLINE (a sleeping member shouldn't silently become host and
 *  freeze playback control); falls back to the oldest overall if nobody is
 *  currently online. Null when the room is empty. */
export async function oldestMember(roomId: string): Promise<string | null> {
  assertRedis();
  const ordered = await redis.zrange(orderKey(roomId), 0, -1);
  if (!ordered.length) return null;
  for (const id of ordered) {
    if ((await redis.exists(presenceKey(roomId, id))) === 1) return id;
  }
  return ordered[0];
}

export async function getHostId(roomId: string): Promise<string | null> {
  assertRedis();
  return (await redis.hget(roomKey(roomId), "hostId")) || null;
}

// ── Inactivity reap marker ──
// The flag itself is written inline by listMembers when it reaps a stale member
// (see `inactiveGhosts`). These two helpers read it back from the join / stream
// gates.
/** Consume the inactivity flag: returns true if the user was reaped for
 *  inactivity (and clears it, so a deliberate manual rejoin afterwards works). */
export async function consumeInactive(roomId: string, userId: string): Promise<boolean> {
  assertRedis();
  const removed = await redis.srem(inactiveKey(roomId), userId);
  return removed === 1;
}

/** Peek the inactivity flag WITHOUT consuming it (for the SSE stream gate, which
 *  must not race-consume the flag the join route needs to report the reason). */
export async function isInactive(roomId: string, userId: string): Promise<boolean> {
  assertRedis();
  return (await redis.sismember(inactiveKey(roomId), userId)) === 1;
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

/** Refresh a member's presence (online flag), durable profile and last-seen
 *  timestamp (heartbeat). */
export async function touchPresence(roomId: string, member: Member): Promise<void> {
  assertRedis();
  const now = Date.now();
  const profile = JSON.stringify({ name: member.name, image: member.image || "" });
  // ONLINE flag — short TTL; its expiry only flips the member to offline.
  await redis.set(presenceKey(roomId, member.userId), profile, "EX", PRESENCE_TTL);
  // DURABLE profile — survives the online flag so a sleeping member still renders.
  await redis.hset(profilesKey(roomId), member.userId, profile);
  await redis.expire(profilesKey(roomId), ROOM_TTL);
  await redis.sadd(membersKey(roomId), member.userId);
  await redis.expire(membersKey(roomId), ROOM_TTL);
  // Keep this member in the join-order zset (NX = preserve their first-seen
  // time so render order is stable across offline/online transitions).
  await redis.zadd(orderKey(roomId), "NX", now, member.userId);
  await redis.expire(orderKey(roomId), ROOM_TTL);
  // Bump last-seen (NOT NX — this one DOES advance) for the MEMBER_TTL prune.
  await redis.zadd(seenKey(roomId), now, member.userId);
  await redis.expire(seenKey(roomId), ROOM_TTL);
}

/** Build the member list. Membership is DURABLE: a member stays (avatar shown,
 *  slot kept) while offline — through sleep / a backgrounded tab — and is only
 *  dropped on explicit leave/kick/ban OR when no heartbeat has arrived for
 *  MEMBER_TTL_MS (a missed departure beacon / crash). The `online` flag tracks
 *  whether the short presence key is still live, so the UI can dim sleepers. */
export async function listMembers(roomId: string): Promise<Member[]> {
  assertRedis();
  // Iterate in join order (oldest first) — this is the stable render order, and
  // it survives offline/online because the order zset is never re-stamped.
  const ordered = await redis.zrange(orderKey(roomId), 0, -1);
  if (!ordered.length) return [];

  const now = Date.now();
  // Last-seen per member (for the MEMBER_TTL prune). zrange WITHSCORES → flat
  // [member, score, member, score, …].
  const seenFlat = await redis.zrange(seenKey(roomId), 0, -1, "WITHSCORES");
  const lastSeen = new Map<string, number>();
  for (let i = 0; i < seenFlat.length; i += 2) {
    lastSeen.set(seenFlat[i], Number(seenFlat[i + 1]) || 0);
  }

  const profiles = await redis.hgetall(profilesKey(roomId));
  const hostId = await getHostId(roomId);
  const mutes = await getMutes(roomId);
  const pbBlocks = await getPlaybackBlocks(roomId);

  const members: Member[] = [];
  const ghosts: string[] = [];
  // Subset of ghosts removed specifically for INACTIVITY (a real member who went
  // quiet past MEMBER_TTL) — flagged so their next reconnect gets a "kicked for
  // inactivity" notice instead of silently rejoining.
  const inactiveGhosts: string[] = [];
  for (const userId of ordered) {
    const online = (await redis.exists(presenceKey(roomId, userId))) === 1;
    const seen = lastSeen.get(userId);
    // Reap only a member who is offline AND last seen beyond the safety window
    // (a missed departure beacon / crash). A member with no `seen` record yet
    // (e.g. mid-migration, or one that just joined) is kept as long as they're
    // online OR have a durable profile — the next heartbeat writes their score.
    const hasProfile = !!profiles?.[userId];
    const stale = seen !== undefined && now - seen > MEMBER_TTL_MS;
    const unknown = seen === undefined && !online && !hasProfile;
    if (!online && (stale || unknown)) {
      ghosts.push(userId);
      if (stale) inactiveGhosts.push(userId); // genuine inactivity, not migration junk
      continue;
    }
    // Durable profile (survives presence expiry); fall back to the online key.
    let raw = profiles?.[userId];
    if (!raw) raw = (await redis.get(presenceKey(roomId, userId))) || "";
    let name = "";
    let image = "";
    try {
      const p = JSON.parse(raw);
      name = p.name;
      image = p.image;
    } catch {
      /* missing profile — keep the member but with empty name/image */
    }
    members.push({
      userId,
      name,
      image,
      isHost: userId === hostId,
      muted: mutes.has(userId),
      playbackBlocked: pbBlocks.has(userId),
      online,
    });
  }
  if (ghosts.length) {
    await redis.srem(membersKey(roomId), ...ghosts);
    await redis.zrem(orderKey(roomId), ...ghosts);
    await redis.zrem(seenKey(roomId), ...ghosts);
    await redis.hdel(profilesKey(roomId), ...ghosts);
    if (inactiveGhosts.length) {
      await redis.sadd(inactiveKey(roomId), ...inactiveGhosts);
      await redis.expire(inactiveKey(roomId), ROOM_TTL);
    }
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
