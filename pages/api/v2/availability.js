import { redis } from "@/lib/redis";

/**
 * Per-episode player availability cache.
 *
 * The watch page lights its server-selector chips by fanning out ~15-20 probes
 * to /api/v2/source — every visitor, every episode. This endpoint remembers
 * WHICH servers resolved for an (aniId, episode, sub) so the next visitor sees
 * the green chips instantly, before any probe returns. It stores ONLY the list
 * of confirmed server ids — never the stream URLs (those carry IP/time-bound
 * CDN tokens that expire in 1-4h; re-serving a stale one would be a dead
 * player). The probes still run to refresh/extend the snapshot, but the user no
 * longer stares at a blank selector on a cold visit.
 *
 *   GET  ?aniId=&episode=&sub=sub|dub        → { servers: [...], cached: bool }
 *   POST { aniId, episode, sub, servers:[…] } → merges the confirmed set
 *
 * Quota discipline (Upstash command budget):
 *   - GET is a single Redis GET.
 *   - POST writes at most ONCE per (episode, sub) per QUOTA_WINDOW: the first
 *     writer sets the snapshot + a short "written" guard key; later writers in
 *     the window are no-ops. So a popular episode with 100 concurrent viewers
 *     costs ~1 write, not 100.
 *   - Internal/warmer traffic (x-warmer) never writes.
 */

const TTL_S = 6 * 60 * 60;        // 6h — host availability drifts slowly
const WRITE_GUARD_S = 10 * 60;    // collapse the write storm: 1 write / 10 min

function key(aniId, episode, sub) {
  const s = sub === "dub" ? "dub" : "sub";
  return `avail:v1:${aniId}:${episode}:${s}`;
}

export default async function handler(req, res) {
  if (!redis) {
    // No cache layer configured — behave as a permanent miss so the client
    // just falls back to its normal probe fan-out.
    if (req.method === "GET") return res.status(200).json({ servers: [], cached: false });
    return res.status(204).end();
  }

  if (req.method === "GET") {
    const aniId = Number(req.query.aniId);
    const episode = Number(req.query.episode);
    const sub = String(req.query.sub || "sub");
    if (!aniId || !Number.isFinite(episode)) {
      return res.status(400).json({ error: "aniId and episode required" });
    }
    try {
      const raw = await redis.get(key(aniId, episode, sub));
      const servers = raw ? JSON.parse(raw) : [];
      // Short browser/edge cache: identical for everyone, and the client also
      // keeps re-probing, so a few minutes of staleness is harmless.
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
      return res.status(200).json({ servers, cached: !!raw });
    } catch {
      return res.status(200).json({ servers: [], cached: false });
    }
  }

  if (req.method === "POST") {
    // Never let the warmer/crons write availability.
    if (req.headers["x-warmer"] === "1") return res.status(204).end();
    const { aniId, episode, sub = "sub", servers } = req.body || {};
    if (!aniId || episode == null || !Array.isArray(servers)) {
      return res.status(400).json({ error: "aniId, episode, servers[] required" });
    }
    // Sanitise: short, known-shaped server ids only (defensive — body is public).
    const clean = [
      ...new Set(
        servers
          .filter((s) => typeof s === "string" && /^[a-z0-9-]{1,40}$/i.test(s))
          .slice(0, 40),
      ),
    ];
    if (clean.length === 0) return res.status(204).end();

    const k = key(aniId, episode, sub);
    try {
      // Write-storm guard: first writer in the window claims the slot. NX = only
      // set if absent; if it already exists, a write happened recently → skip.
      const guardKey = `${k}:w`;
      const claimed = await redis.set(guardKey, "1", "EX", WRITE_GUARD_S, "NX");
      if (!claimed) return res.status(204).end(); // someone wrote recently
      // Merge with any existing snapshot so we accumulate confirmations across
      // visitors rather than clobbering (different visitors may confirm
      // different hosts depending on transient anti-bot luck).
      let merged = clean;
      try {
        const prev = await redis.get(k);
        if (prev) merged = [...new Set([...JSON.parse(prev), ...clean])].slice(0, 40);
      } catch {}
      await redis.set(k, JSON.stringify(merged), "EX", TTL_S);
      return res.status(200).json({ stored: merged.length });
    } catch {
      return res.status(204).end();
    }
  }

  return res.status(405).json({ error: "GET or POST only" });
}
