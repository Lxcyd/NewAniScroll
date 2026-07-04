// Server-side Ably client for the Watch 2gether realtime transport.
//
// Why Ably: the previous transport was a long-lived SSE function on Vercel
// (pages/api/v2/watch2gether/stream.ts) that kept a serverless function ALIVE
// for ~58s per connection — ~1h of Fluid Active CPU per person-hour in a room,
// the single biggest CPU drain on the project. Ably is a managed WebSocket
// service: the browser connects directly to Ably (not Vercel), and Vercel only
// PUBLISHES events via a short REST call (~50ms). Realtime CPU on Vercel → ~0.
//
// Free tier (6M messages/mo, 200 concurrent connections) is far above this
// project's volume — w2g events (play/pause/seek/chat) are small and rare.
//
// Channel name mirrors the Redis pub/sub channel (`w2g:channel:<roomId>`) so the
// two transports can run side by side during the migration window. The server
// keeps publishing to Redis too (for the legacy SSE fallback) until stream.ts
// is removed.

import Ably from "ably";

let restClient: Ably.Rest | null = null;

/** Returns true when ABLY_API_KEY is configured (realtime transport active). */
export function ablyEnabled(): boolean {
  return !!process.env.ABLY_API_KEY;
}

/** Lazily-built singleton REST client. Used only to publish events and mint
 *  capability-scoped token requests — never to hold a realtime connection. */
export function getAblyRest(): Ably.Rest | null {
  if (restClient) return restClient;
  const key = process.env.ABLY_API_KEY;
  if (!key) return null;
  restClient = new Ably.Rest({ key });
  return restClient;
}

/** The Ably channel name for a room. Mirrors redisRoom.channelKey so a single
 *  publish reaches both transports during migration. */
export function ablyChannelName(roomId: string): string {
  return `w2g:channel:${roomId}`;
}
