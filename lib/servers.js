/**
 * Streaming server definitions.
 *
 * Each server has:
 *   - name          : display label
 *   - id            : unique key (used in localStorage + URL)
 *   - type          : "iframe" | "hls" | "api"
 *   - lang          : "multi" | "vo" | "vf"  (for display icon)
 *   - buildSrc(opts): returns the iframe URL (iframe type only)
 *   - source        : backend source key (api/hls types)
 */

const SERVERS = [
  // ── Iframe embeds ──────────────────────────────────────────
  {
    id: "megaplay",
    name: "Megaplay",
    type: "iframe",
    lang: "multi",
    buildSrc: ({ aniId, episode, dub }) =>
      `https://megaplay.buzz/stream/ani/${aniId}/${episode}/${dub ? "dub" : "sub"}`,
  },
  {
    id: "4animo",
    name: "4Animo",
    type: "iframe",
    lang: "multi",
    buildSrc: ({ aniId, episode, dub }) =>
      `https://cdn.4animo.xyz/api/embed/ani/${aniId}/${episode}/${dub ? "dub" : "sub"}?k=1`,
  },

  // ── HLS via Miruro API ─────────────────────────────────────
  {
    id: "miruro-jet",
    name: "Jet",
    type: "hls",
    lang: "vo",
    source: "miruro",
    provider: "jet",
  },

  // ── HiAnime — iframe embeds via AJAX scraping ──
  {
    id: "hianime-vidsrc",
    name: "HiAnime VidSrc",
    type: "api",
    lang: "multi",
    source: "hianime",
  },
  {
    id: "hianime-megacloud",
    name: "HiAnime MegaCloud",
    type: "api",
    lang: "multi",
    source: "hianime",
  },
  {
    id: "hianime-tcloud",
    name: "HiAnime T-Cloud",
    type: "api",
    lang: "multi",
    source: "hianime",
  },

  // ── CoorenLabs providers (requires COOREN_API_URL env var) ──
  {
    id: "cooren-animepahe",
    name: "AnimePahe",
    type: "api",
    lang: "vo",
    source: "cooren",
    provider: "animepahe",
  },
  {
    id: "cooren-animekai",
    name: "Animekai",
    type: "api",
    lang: "multi",
    source: "cooren",
    provider: "animekai",
  },

  // ── AnimeSaturn (Italian — M3U8 via consumet) ──
  {
    id: "animesaturn",
    name: "AnimeSaturn",
    type: "api",
    lang: "multi",
    source: "consumet",
    provider: "animesaturn",
  },

  // ── Anime-Sama (VF — French dubs) ──
  {
    id: "animesama-sibnet",
    name: "Anime-Sama Sibnet",
    type: "api",
    lang: "vf",
    source: "animesama",
  },
  {
    id: "animesama-sendvid",
    name: "Anime-Sama Sendvid",
    type: "api",
    lang: "vf",
    source: "animesama",
  },
  {
    id: "animesama-vidmoly",
    name: "Anime-Sama Vidmoly",
    type: "api",
    lang: "vf",
    source: "animesama",
  },
  {
    id: "animesama-embed4me",
    name: "Anime-Sama Embed4Me",
    type: "api",
    lang: "vf",
    source: "animesama",
  },
  {
    id: "animesama-smoothpre",
    name: "Anime-Sama Smoothpre",
    type: "api",
    lang: "vf",
    source: "animesama",
  },
  {
    id: "animesama-callistanise",
    name: "Anime-Sama Player",
    type: "api",
    lang: "vf",
    source: "animesama",
  },

  // ── Anime-Sama (VOSTFR — Japanese with French subs) ──
  {
    id: "animesama-sibnet-vo",
    name: "Anime-Sama Sibnet",
    type: "api",
    lang: "vo",
    source: "animesama",
  },
  {
    id: "animesama-sendvid-vo",
    name: "Anime-Sama Sendvid",
    type: "api",
    lang: "vo",
    source: "animesama",
  },
  {
    id: "animesama-vidmoly-vo",
    name: "Anime-Sama Vidmoly",
    type: "api",
    lang: "vo",
    source: "animesama",
  },
  {
    id: "animesama-embed4me-vo",
    name: "Anime-Sama Embed4Me",
    type: "api",
    lang: "vo",
    source: "animesama",
  },
  {
    id: "animesama-smoothpre-vo",
    name: "Anime-Sama Smoothpre",
    type: "api",
    lang: "vo",
    source: "animesama",
  },
  {
    id: "animesama-callistanise-vo",
    name: "Anime-Sama Player",
    type: "api",
    lang: "vo",
    source: "animesama",
  },

  // ── voir-anime.to (VF) ──
  { id: "voiranime-voe", name: "Voir-Anime VOE", type: "api", lang: "vf", source: "voiranime" },

  // ── voir-anime.to (VOSTFR) ──
  { id: "voiranime-voe-vo", name: "Voir-Anime VOE", type: "api", lang: "vo", source: "voiranime" },
];

export default SERVERS;

/** Return a server definition by id, fallback to first */
export function getServer(id) {
  return SERVERS.find((s) => s.id === id) || SERVERS[0];
}

/** Group servers by language */
export function getServersByLang() {
  return {
    multi: SERVERS.filter((s) => s.lang === "multi"),
    vo: SERVERS.filter((s) => s.lang === "vo"),
    vf: SERVERS.filter((s) => s.lang === "vf"),
  };
}
