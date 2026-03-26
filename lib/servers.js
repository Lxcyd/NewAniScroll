/**
 * Streaming server definitions.
 *
 * Each server has:
 *   - name          : display label
 *   - id            : unique key (used in localStorage + URL)
 *   - type          : "iframe" | "hls"
 *   - buildSrc(opts): returns the iframe URL  or null (for HLS, source is fetched separately)
 *
 * For "hls" servers the stream URL is fetched from /api/v2/source at runtime.
 */

const SERVERS = [
  // ── Iframe embeds ──────────────────────────────────────────
  {
    id: "megaplay",
    name: "Megaplay",
    type: "iframe",
    buildSrc: ({ aniId, episode, dub }) =>
      `https://megaplay.buzz/stream/ani/${aniId}/${episode}/${dub ? "dub" : "sub"}`,
  },
  {
    id: "2anime",
    name: "2anime",
    type: "iframe",
    buildSrc: ({ aniId, episode, dub }) =>
      `https://2anime.xyz/embed/${aniId}-episode-${episode}${dub ? "-dub" : ""}`,
  },
  {
    id: "anime-api",
    name: "Anime API",
    type: "iframe",
    buildSrc: ({ aniId, episode, dub }) =>
      `https://api.anime-api.eu/anime/episode/${aniId}/${episode}/${dub ? "dub" : "sub"}`,
  },

  // ── HLS via Miruro API ─────────────────────────────────────
  {
    id: "miruro-kiwi",
    name: "Kiwi (HLS)",
    type: "hls",
    provider: "kiwi",
  },
  {
    id: "miruro-arc",
    name: "Arc (HLS)",
    type: "hls",
    provider: "arc",
  },
  {
    id: "miruro-zoro",
    name: "Zoro (HLS)",
    type: "hls",
    provider: "zoro",
  },
  {
    id: "miruro-jet",
    name: "Jet (HLS)",
    type: "hls",
    provider: "jet",
  },
];

export default SERVERS;

/** Return a server definition by id, fallback to first */
export function getServer(id) {
  return SERVERS.find((s) => s.id === id) || SERVERS[0];
}
