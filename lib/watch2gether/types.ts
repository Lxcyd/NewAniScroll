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
}
