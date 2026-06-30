import type { NextApiRequest, NextApiResponse } from "next";
import { getPartyUser } from "@/lib/watch2gether/auth";
import { isValidRoomId, isBanned } from "@/lib/watch2gether/redisRoom";
import { allowByIp } from "@/lib/watch2gether/rateLimit";
import { getAblyRest, ablyChannelName } from "@/lib/watch2gether/ably";

// Mints a short-lived Ably TokenRequest the browser uses to connect directly to
// Ably (replacing the old SSE stream). The token is SCOPED to a single room's
// channel with SUBSCRIBE-only capability, so a client can listen to its own
// room but cannot publish (the server is the only publisher, via publishEvent)
// or read any other room. The raw ABLY_API_KEY never leaves the server.
//
// Auth mirrors stream.ts: signed-in user OR guest identity (passed in the
// request). Banned users are refused a token outright.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).end();
  }

  const rest = getAblyRest();
  if (!rest) {
    // ABLY_API_KEY unset — realtime transport unavailable. The client treats a
    // non-200 here as "fall back to SSE" during migration.
    return res.status(503).json({ error: "Ably not configured" });
  }

  const user = await getPartyUser(req, res);
  if (!user) return res.status(401).end();

  const src = req.method === "GET" ? req.query : req.body || {};
  const roomId = String(src.roomId || "");
  if (!isValidRoomId(roomId)) return res.status(400).end();

  // Per-IP throttle: minting tokens is cheap, but a token request precedes every
  // (re)connect, so gate it the same way the SSE stream was gated.
  if (!(await allowByIp(req, "ably-token", "strict"))) return res.status(429).end();

  // Banned users never get a token (otherwise they could still subscribe and see
  // room activity). Membership itself is enforced by join(); the channel only
  // carries already-broadcast events, so subscribe-only is safe for members.
  if (await isBanned(roomId, user.userId)) return res.status(403).end();

  try {
    const channel = ablyChannelName(roomId);
    const tokenRequest = await rest.auth.createTokenRequest({
      // Bind the token to the user's public id for traceability; this is the same
      // id used as senderId everywhere downstream.
      clientId: user.userId,
      // Subscribe-only on THIS room's channel. No publish, no presence, no other
      // channel. The server is the sole publisher. Ably expects the capability
      // as a JSON string.
      capability: JSON.stringify({ [channel]: ["subscribe"] }),
    });
    return res.status(200).json(tokenRequest);
  } catch (e: any) {
    console.error("[w2g/ably-token] createTokenRequest failed:", e?.message || e);
    return res.status(500).json({ error: "Token mint failed" });
  }
}
