// Shared Watch 2gether types. Kept in a dedicated, dependency-free module so
// CLIENT code (hook, components) can import these without ever pulling in
// `redisRoom.ts` → `ioredis` (a Node-only module that crashes in the browser).

export type PartyEventType =
  | "play"
  | "pause"
  | "seek"
  | "rate"
  | "position"
  | "episode"
  | "server"
  | "chat"
  | "presence"
  | "snapshot"
  | "host"
  | "kick"
  | "ban"
  | "mute"
  | "unmute"
  | "settings"; // room-level flags or per-member moderation changed

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
  /** Host-only: no new members may join (existing ones stay). */
  locked?: boolean;
  /** Whether `position` is a REAL playhead read from a native <video> at create
   *  time, or just the `0` fallback for an iframe embed whose position is
   *  unreadable. When `false`, `position === 0` means "unknown", not "the start",
   *  so the host's player must NOT be paused/rewound from this snapshot. Absent
   *  (older rooms / native servers) is treated as `true`. */
  positionKnown?: boolean;
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
  /** True for the room host (computed in listMembers). */
  isHost?: boolean;
  /** True when the host has muted this member in chat. */
  muted?: boolean;
  /** True when the host has blocked this member from controlling playback. */
  playbackBlocked?: boolean;
  /** True while the member's short presence (heartbeat) key is live. False when
   *  they're offline but still a member (phone asleep, tab backgrounded) — the
   *  avatar stays, just dimmed. Absent (undefined) is treated as online. */
  online?: boolean;
}
