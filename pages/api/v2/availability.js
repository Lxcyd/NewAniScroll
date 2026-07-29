import { redis } from "@/lib/redis";

/**
 * Per-episode player availability cache.
 *
 * The watch page lights its server-selector chips by fanning out probes to
 * /api/v2/source — every visitor, every episode. This endpoint remembers the
 * resolution VERDICT of each server for an (aniId, episode, sub) so the next
 * visitor reuses it instead of re-scraping. It stores ONLY server ids + their
 * verdict — never the stream URLs (those carry IP/time-bound CDN tokens that
 * expire in 1-4h; re-serving a stale one would be a dead player).
 *
 * Two verdict sets are kept:
 *   - ok[]     : servers that resolved → chip painted green, probe SKIPPED.
 *   - absent[] : servers that have NO source for this episode (the ~half that
 *                404 by design). Previously these were NOT remembered, so every
 *                visitor re-probed them → a /api/v2/source scrape each time the
 *                negative cache had expired (e.g. a freshly-released episode).
 *                Remembering them lets a returning visitor skip those probes
 *                entirely — this is the bulk of the steady-state CPU saving.
 *
 *   GET  ?aniId=&episode=&sub=sub|dub        → { servers:[…], absent:[…], cached }
 *   POST { aniId, episode, sub, servers:[…], absent:[…] } → merges both sets
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

// Parse a stored snapshot into { ok, absent }. Two on-disk shapes coexist:
//   - legacy: a bare array of confirmed ids  → { ok: [...], absent: [] }
//   - current: { ok:[…], absent:[…] }
// Legacy entries age out within TTL_S (6h) and get rewritten in the new shape
// on the next POST, so this compat path is self-retiring.
function parseSnapshot(raw) {
  if (!raw) return { ok: [], absent: [] };
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return { ok: v, absent: [] };
    return {
      ok: Array.isArray(v?.ok) ? v.ok : [],
      absent: Array.isArray(v?.absent) ? v.absent : [],
    };
  } catch {
    return { ok: [], absent: [] };
  }
}

const SERVER_ID_RE = /^[a-z0-9-]{1,40}$/i;
const cleanIds = (arr) =>
  Array.isArray(arr)
    ? [
        ...new Set(
          arr.filter((s) => typeof s === "string" && SERVER_ID_RE.test(s)),
        ),
      ].slice(0, 40)
    : [];

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
      const { ok, absent } = parseSnapshot(raw);
      // Edge cache: this verdict is identical for everyone and drifts slowly
      // (6h TTL), and the client also keeps re-probing live + POSTs corrections,
      // so ~10 min of edge staleness is harmless. A HIT never reaches the
      // function and never spends the Redis GET below. Browser stays at 60s.
      res.setHeader("Cache-Control", "public, max-age=60");
      res.setHeader(
        "CDN-Cache-Control",
        "public, s-maxage=600, stale-while-revalidate=3600",
      );
      // `servers` keeps the original field name (= confirmed/ok) for any older
      // client; `absent` is additive so a stale client just ignores it.
      return res.status(200).json({ servers: ok, absent, cached: !!raw });
    } catch {
      return res.status(200).json({ servers: [], absent: [], cached: false });
    }
  }

  if (req.method === "POST") {
    // Never let the warmer/crons write availability.
    if (req.headers["x-warmer"] === "1") return res.status(204).end();
    const { aniId, episode, sub = "sub", servers, absent } = req.body || {};
    if (!aniId || episode == null || (!Array.isArray(servers) && !Array.isArray(absent))) {
      return res.status(400).json({ error: "aniId, episode, and servers[] or absent[] required" });
    }
    // Sanitise: short, known-shaped server ids only (defensive — body is public).
    const cleanOk = cleanIds(servers);
    const cleanAbsent = cleanIds(absent);
    if (cleanOk.length === 0 && cleanAbsent.length === 0) return res.status(204).end();

    const k = key(aniId, episode, sub);
    try {
      // Read the existing snapshot FIRST so we can tell whether this POST
      // actually adds anything new.
      const prev = parseSnapshot(await redis.get(k).catch(() => null));
      const prevOk = new Set(prev.ok);
      const prevAbsent = new Set(prev.absent);

      // Does this POST carry a verdict the snapshot doesn't already reflect?
      //  - a NEW ok id (not already ok), OR one flipping absent→ok
      //  - a NEW absent id (not already absent), OR one flipping ok→absent
      // A "new information" write must bypass the storm guard: otherwise the
      // first writer in the 10-min window (who may have missed a slow server
      // like megaplay) permanently locks that server out of the snapshot until
      // the whole entry's 6h TTL expires — the "megaplay chip never appears" bug.
      const addsInfo =
        cleanOk.some((id) => !prevOk.has(id)) ||
        cleanAbsent.some((id) => !prevAbsent.has(id));

      // Write-storm guard only gates REDUNDANT writes (nothing new to add). NX =
      // only claim if free; if a write happened recently AND we add nothing, skip.
      if (!addsInfo) {
        const guardKey = `${k}:w`;
        const claimed = await redis.set(guardKey, "1", "EX", WRITE_GUARD_S, "NX");
        if (!claimed) return res.status(204).end(); // recent write, no new info
      }

      // Merge: newest verdict per id wins (confirm leaves absent, absent leaves
      // ok), so a host coming back online or going dead self-corrects.
      const okSet = new Set([...prev.ok, ...cleanOk]);
      const absentSet = new Set([...prev.absent, ...cleanAbsent]);
      for (const id of cleanOk) absentSet.delete(id);
      for (const id of cleanAbsent) okSet.delete(id);
      const merged = {
        ok: [...okSet].slice(0, 40),
        absent: [...absentSet].slice(0, 40),
      };
      await redis.set(k, JSON.stringify(merged), "EX", TTL_S);
      return res.status(200).json({ stored: merged.ok.length + merged.absent.length });
    } catch {
      return res.status(204).end();
    }
  }

  return res.status(405).json({ error: "GET or POST only" });
}
