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
  | "ban";

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
  /** True for the room host (computed in listMembers). */
  isHost?: boolean;
}
