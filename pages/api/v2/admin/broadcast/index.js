import { getServerSession } from "next-auth";
import { authOptions } from "pages/api/auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import { redis } from "@/lib/redis";
import {
  getAdminTursoClient,
  ensureAdminSchema,
  logAuditEvent,
} from "@/lib/db/turso-admin";

// Cross-instance cache so every page load doesn't round-trip to Turso.
// _app.tsx fetches this on mount + every route change with `cache: "no-store"`;
// 200+ DB hits per 12 h on a tiny project was almost entirely this endpoint.
const BROADCAST_CACHE_KEY = "broadcast:current";
const BROADCAST_CACHE_TTL_S = 60;
let broadcastMemCache = null; // { value, expiresAt }

/**
 * Global broadcast endpoint backed by the admin Turso DB. The `broadcast`
 * table is a single-row table (PRIMARY KEY CHECK id = 1) so we never have
 * to disambiguate which message is active.
 *
 *   GET    → returns the current message (public read; no auth needed so
 *            _app.tsx can fetch on mount without 401-ing logged-out users).
 *   POST   → admin sets/updates the message.
 *   DELETE → admin clears the show flag (keeps the row so future POSTs
 *            re-use the same id without conflict).
 *
 * The legacy `X-Broadcast-Key: get-broadcast` header is kept as a soft
 * guard against random clients hitting this endpoint, but the real
 * authorization happens via NextAuth for mutations.
 */
export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  const isMutation = req.method === "POST" || req.method === "DELETE";

  if (isMutation && !isAdminSession(session)) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Soft guard so casual scrapers don't poll this endpoint.
  if (req.headers["x-broadcast-key"] !== "get-broadcast") {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const db = getAdminTursoClient();
  if (!db) {
    return res.status(200).json({ message: null, show: false });
  }
  await ensureAdminSchema();

  try {
    if (req.method === "GET") {
      // 1. In-process cache (per Vercel function instance — saves both
      //    Turso and Redis round-trips when one instance is warm).
      if (broadcastMemCache && broadcastMemCache.expiresAt > Date.now()) {
        res.setHeader(
          "Cache-Control",
          "public, s-maxage=60, stale-while-revalidate=300",
        );
        return res.status(200).json(broadcastMemCache.value);
      }
      // 2. Redis (cross-instance shared cache).
      if (redis) {
        try {
          const cached = await redis.get(BROADCAST_CACHE_KEY);
          if (cached) {
            const parsed = JSON.parse(cached);
            broadcastMemCache = {
              value: parsed,
              expiresAt: Date.now() + BROADCAST_CACHE_TTL_S * 1000,
            };
            res.setHeader(
              "Cache-Control",
              "public, s-maxage=60, stale-while-revalidate=300",
            );
            return res.status(200).json(parsed);
          }
        } catch {
          /* fall through to DB */
        }
      }

      // 3. Live DB read.
      const r = await db.execute(
        "SELECT title, message, show_flag, start_at, end_at FROM broadcast WHERE id = 1"
      );
      const row = r.rows?.[0];
      const payload = !row
        ? { title: null, message: null, show: false }
        : (() => {
            const now = Math.floor(Date.now() / 1000);
            const inWindow =
              (row.start_at == null || now >= Number(row.start_at)) &&
              (row.end_at == null || now <= Number(row.end_at));
            return {
              title: row.title,
              message: row.message,
              startAt: row.start_at,
              endAt: row.end_at,
              show: Boolean(row.show_flag) && inWindow,
            };
          })();

      // Write through to both caches. Don't await Redis — failure shouldn't
      // delay the response.
      broadcastMemCache = {
        value: payload,
        expiresAt: Date.now() + BROADCAST_CACHE_TTL_S * 1000,
      };
      if (redis) {
        redis
          .set(BROADCAST_CACHE_KEY, JSON.stringify(payload), "EX", BROADCAST_CACHE_TTL_S)
          .catch(() => {});
      }
      res.setHeader(
        "Cache-Control",
        "public, s-maxage=60, stale-while-revalidate=300",
      );
      return res.status(200).json(payload);
    }

    if (req.method === "POST") {
      const { title, message, startAt, endAt, show = true } = req.body || {};
      if (!message) {
        return res.status(400).json({ message: "Message is required" });
      }
      await db.execute({
        sql: `INSERT INTO broadcast
                (id, title, message, show_flag, start_at, end_at, updated_at)
              VALUES (1, ?, ?, ?, ?, ?, strftime('%s','now'))
              ON CONFLICT(id) DO UPDATE SET
                title      = excluded.title,
                message    = excluded.message,
                show_flag  = excluded.show_flag,
                start_at   = excluded.start_at,
                end_at     = excluded.end_at,
                updated_at = excluded.updated_at`,
        args: [
          title || null,
          message,
          show ? 1 : 0,
          startAt ?? null,
          endAt ?? null,
        ],
      });
      await logAuditEvent(
        session?.user?.name || "unknown",
        "broadcast_update",
        null,
        message
      );
      // Bust caches so the new message shows up immediately for everyone.
      broadcastMemCache = null;
      if (redis) redis.del(BROADCAST_CACHE_KEY).catch(() => {});
      return res.status(200).json({ message: "Broadcast updated" });
    }

    if (req.method === "DELETE") {
      await db.execute(
        "UPDATE broadcast SET show_flag = 0, updated_at = strftime('%s','now') WHERE id = 1"
      );
      await logAuditEvent(
        session?.user?.name || "unknown",
        "broadcast_clear",
      );
      broadcastMemCache = null;
      if (redis) redis.del(BROADCAST_CACHE_KEY).catch(() => {});
      return res.status(200).json({ message: "Broadcast cleared" });
    }

    return res.status(405).json({ message: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
