import { rateLimiterRedis, redis } from "@/lib/redis";

/**
 * POST /api/v2/source
 *
 * Body: { server, aniId, episode, sub }
 *   - server   : server id from lib/servers.js  (e.g. "miruro-kiwi")
 *   - aniId    : AniList anime id
 *   - episode  : episode number
 *   - sub      : "sub" | "dub"
 *
 * Returns: { streams: [{ url, quality }], subtitles: [...], intro, outro }
 */

const MIRURO_BASE =
  process.env.MIRURO_API_URL || "https://miruro-api.vercel.app";

// ── Miruro provider mapping ──────────────────────────────────
const MIRURO_PROVIDERS = {
  "miruro-kiwi": "kiwi",
  "miruro-arc": "arc",
  "miruro-zoro": "zoro",
  "miruro-jet": "jet",
};

async function fetchMiruroEpisodes(aniId) {
  try {
    const res = await fetch(`${MIRURO_BASE}/episodes/${aniId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchMiruroSource(episodeId) {
  try {
    const res = await fetch(`${MIRURO_BASE}/${episodeId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getMiruroStream(provider, aniId, episode, sub) {
  // Step 1: get episode list to find the episode id for this provider
  const epData = await fetchMiruroEpisodes(aniId);
  if (!epData?.providers) return null;

  const providerData = epData.providers[provider];
  if (!providerData?.episodes) return null;

  const category = sub === "dub" ? "dub" : "sub";
  const episodes = providerData.episodes[category] || providerData.episodes.sub;
  if (!episodes || episodes.length === 0) return null;

  const ep = episodes.find((e) => e.number === Number(episode));
  if (!ep?.id) return null;

  // Step 2: get stream sources using the episode id
  const sources = await fetchMiruroSource(ep.id);
  return sources || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  if (redis) {
    try {
      const ipAddress = req.socket.remoteAddress;
      await rateLimiterRedis.consume(ipAddress);
    } catch (error) {
      return res.status(429).json({
        error: `Too Many Requests, retry after ${error.msBeforeNext / 1000}`,
      });
    }
  }

  const { server, aniId, episode, sub = "sub" } = req.body;

  // ── Miruro HLS providers ──
  const miruroProvider = MIRURO_PROVIDERS[server];
  if (miruroProvider) {
    const data = await getMiruroStream(miruroProvider, aniId, episode, sub);
    if (!data) {
      return res.status(404).json({ error: "Source not found" });
    }
    return res.status(200).json(data);
  }

  return res.status(400).json({ error: "Unknown server" });
}
