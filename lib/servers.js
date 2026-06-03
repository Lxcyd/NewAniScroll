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
 *   - speed         : typical delivery-speed rank (1 = fastest). Drives the
 *                     order servers appear in the selector — fastest first.
 *                     Based on the delivery architecture: direct-CDN /
 *                     browser-extracted hosts are quick; hosts routed through
 *                     the Fly proxy (sibnet) are the slowest.
 */

const SERVERS = [
  // ── Iframe embeds ──────────────────────────────────────────
  {
    id: "megaplay",
    name: "Megaplay",
    // API: backend fetches the embed page, extracts the file_id, then calls
    // /stream/getSources to get a clean m3u8 + multi-language subtitle tracks.
    type: "api",
    lang: "multi",
    source: "megaplay",
    speed: 1,
  },
  // 4Animo removed — only ships hardcoded English subs and confused users
  // since Megaplay covers the same MegaCloud source with multi-language
  // separate tracks.

  // Miruro (`miruro-jet`) was here — relied on a third-party `miruro-api`
  // service that's been returning 500s. Their direct API uses ECDH-encrypted
  // JWE envelopes (very intrusive to reverse). Megaplay already covers the
  // same multi-sub use case, so this is removed for now.

  // CoorenLabs providers were here (AnimePahe, Animekai). They require a
  // COOREN_API_URL env var which isn't set in this deployment — and Megaplay
  // already covers MegaCloud/AnimeKai with multi-language separate subtitle
  // tracks, so removing them avoids permanently-empty entries in the UI.

  // ── AnimeSaturn (Italian — M3U8 via consumet) ──
  {
    id: "animesaturn",
    name: "AnimeSaturn",
    type: "api",
    lang: "multi",
    source: "consumet",
    provider: "animesaturn",
    speed: 3,
  },

  // ── Anime-Sama (VF — French dubs) ──
  {
    id: "animesama-sibnet",
    name: "Anime-Sama Sibnet",
    type: "api",
    lang: "vf",
    source: "animesama",
    // Empirically fast to seek (user-reported), despite the Fly proxy hop.
    speed: 3,
  },
  // Anime-Sama Sendvid removed — very slow to seek/buffer in practice; the other
  // VF hosts (Sibnet, Vidmoly) cover the same content faster.
  // Voir-Anime's vidmoly uploads stay fresh much longer than anime-sama's
  // (different uploader pool, slower rotation), so we list it BEFORE
  // anime-sama's vidmoly to put the working chip first. Both feed the same
  // browser-side extraction — no proxy in either path.
  {
    id: "voiranime-vidmoly",
    name: "Voir-Anime Vidmoly",
    type: "api",
    lang: "vf",
    source: "voiranime",
    speed: 2,
  },
  {
    id: "animesama-vidmoly",
    name: "Anime-Sama Vidmoly",
    type: "api",
    lang: "vf",
    source: "animesama",
    speed: 2,
  },
  // Embed4Me removed — it frequently failed extraction and fell back to a
  // degraded iframe embed, which is a poor experience. The other anime-sama
  // hosts (Sibnet, Sendvid, Vidmoly) cover the same VF/VOSTFR content.
  // Smoothpre / Movearnpre removed: their playback CDN (acek-cdn) blocks
  // Cloudflare Worker IPs AND we don't want the traffic on Vercel Fast
  // Origin Transfer. We'd need to route via the Fly.io proxy for it, which
  // works but eats the proxy's bandwidth budget for content that's already
  // available on the other working hosts (Vidmoly, Sendvid, Sibnet).
  {
    id: "animesama-callistanise",
    name: "Anime-Sama Player",
    type: "api",
    lang: "vf",
    source: "animesama",
    speed: 7,
  },

  // ── Anime-Sama (VOSTFR — Japanese with French subs) ──
  {
    id: "animesama-sibnet-vo",
    name: "Anime-Sama Sibnet",
    type: "api",
    lang: "vo",
    source: "animesama",
    speed: 3,
  },
  // Anime-Sama Sendvid (VO) removed — see the VF block above.
  // Voir-Anime first — fresher vidmoly uploads, see VF block above.
  {
    id: "voiranime-vidmoly-vo",
    name: "Voir-Anime Vidmoly",
    type: "api",
    lang: "vo",
    source: "voiranime",
    speed: 2,
  },
  {
    id: "animesama-vidmoly-vo",
    name: "Anime-Sama Vidmoly",
    type: "api",
    lang: "vo",
    source: "animesama",
    speed: 2,
  },
  // Embed4Me removed — see the VF block above.
  // Smoothpre / Movearnpre removed — see comment above the VF block.
  {
    id: "animesama-callistanise-vo",
    name: "Anime-Sama Player",
    type: "api",
    lang: "vo",
    source: "animesama",
    speed: 7,
  },

  // ── voir-anime.to (VF + VOSTFR) ──
  // Backend supports both languages; the slug resolver picks the -vf variant
  // for VF requests and the un-suffixed slug for VOSTFR.
  // Voir-anime's vidmoly entries are listed up in the anime-sama VF/VO blocks
  // so the two providers' vidmoly chips sit next to each other (voiranime
  // first since its uploads are fresher).
  { id: "voiranime-voe",    name: "Voir-Anime VOE", type: "api", lang: "vf", source: "voiranime", speed: 5 },
  { id: "voiranime-voe-vo", name: "Voir-Anime VOE", type: "api", lang: "vo", source: "voiranime", speed: 5 },
];

export default SERVERS;

/** Return a server definition by id, fallback to first */
export function getServer(id) {
  return SERVERS.find((s) => s.id === id) || SERVERS[0];
}

/** Group servers by language, each group ordered fastest-first (by `speed`). */
export function getServersByLang() {
  const byLang = (lang) =>
    SERVERS.filter((s) => s.lang === lang).sort(
      (a, b) => (a.speed ?? 99) - (b.speed ?? 99),
    );
  return {
    multi: byLang("multi"),
    vo: byLang("vo"),
    vf: byLang("vf"),
  };
}
