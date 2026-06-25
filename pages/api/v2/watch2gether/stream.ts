import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import {
  channelKey,
  getSnapshot,
  isBanned,
  isMember,
  isValidRoomId,
  listMembers,
  roomExists,
} from "@/lib/watch2gether/redisRoom";
import { createSubscriber } from "@/lib/watch2gether/subscriber";

// Long-lived SSE response. Vercel caps function duration (60s on the current
// Hobby plan), so we self-close a little before the limit and the client's
// EventSource auto-reconnects.
//
// Active-CPU note: we keep maxDuration at 60 (Hobby's hard cap — going higher
// gets the function KILLED mid-stream, which is worse). The win comes from
// burning less CPU *within* each connection: the self-close moves as close to
// the cap as is safe (58s) so we reconnect as rarely as the platform allows,
// and the heartbeat is relaxed (15s → 25s) since it only needs to keep proxies
// from dropping an idle connection, not to carry data — fewer timer wakeups per
// connection.
export const config = {
  api: { bodyParser: false, responseLimit: false },
  maxDuration: 60,
};

const SELF_CLOSE_MS = 58_000; // close just before Vercel's 60s hard cap
const HEARTBEAT_MS = 25_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).end();

  const roomId = String(req.query.roomId || "");
  if (!isValidRoomId(roomId)) return res.status(400).end();

  if (!(await roomExists(roomId))) return res.status(404).end();

  // Banned users never get a stream (otherwise the initial snapshot would flash
  // the room before join() rejects). Locked rooms only stream to existing
  // members; new arrivals are turned away here too.
  if (await isBanned(roomId, user.userId)) return res.status(403).end();
  const snap0 = await getSnapshot(roomId);
  if (snap0?.locked && !(await isMember(roomId, user.userId))) return res.status(403).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering
  });

  const send = (data: string) => {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      /* connection already gone */
    }
  };

  // Initial snapshot so a (re)connecting client syncs immediately.
  try {
    const [snapshot, members] = await Promise.all([getSnapshot(roomId), listMembers(roomId)]);
    send(JSON.stringify({ type: "snapshot", senderId: "server", ts: Date.now(), payload: { snapshot, members } }));
  } catch {
    /* non-fatal */
  }

  const subscriber = createSubscriber();
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(selfClose);
    subscriber.removeAllListeners("message");
    subscriber.quit().catch(() => subscriber.disconnect());
    try {
      res.end();
    } catch {
      /* noop */
    }
  };

  subscriber.on("message", (_channel, message) => {
    send(message);
  });
  try {
    await subscriber.subscribe(channelKey(roomId));
  } catch (e: any) {
    console.error("[w2g/stream] subscribe failed:", e?.message || e);
    cleanup();
    return;
  }

  // SSE comment heartbeat keeps intermediaries from dropping the connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);

  // Self-close before the platform kills us; client reconnects cleanly.
  const selfClose = setTimeout(cleanup, SELF_CLOSE_MS);

  req.on("close", cleanup);
  res.on("close", cleanup);
}
