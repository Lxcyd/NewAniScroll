import { rateLimiterRedis, redis } from "@/lib/redis";
import * as cheerio from "cheerio";
import { getExtractor, extractMegaplay, VIDMOLY_HOST_RE } from "@/lib/extractors";
import { getMediaMeta } from "@/lib/anilist/getMediaMeta";
import { getPlayerMapEntry, upsertPlayerMap, flagPlayerMap } from "@/lib/db/playerMap";
import { getFribbEntry } from "@/lib/fribb/fribbMap";
import { resolveSeasonNumber } from "@/lib/anilist/resolveSeason";
import { resolveSeasonChain } from "@/lib/anilist/seasonChain";
import { isRecapTitle } from "@/lib/anilist/seasonDetection";
import { getEpisodeParts } from "@/lib/multipartEpisodes";

/* Per-provider trace logger. Off by default â€” set DEBUG_SOURCE=1 in
   .env.local to see the chatty `[anime-sama]` / `[voiranime]` /
   `[animekai]` lines that used to spam the dev terminal every time the
   watch page resolved a stream. console.error stays unconditional. */
const DEBUG_SOURCE = process.env.DEBUG_SOURCE === "1";
const dlog = DEBUG_SOURCE ? console.log.bind(console) : () => {};

/* Thrown by a provider resolver when it fails for a TRANSIENT reason — an
   upstream (worker proxy / catalogue page / embed host) that timed out, 5xx'd,
   or was momentarily unreachable — as opposed to a genuine "this episode has no
   source here". The handler maps this to a 503 (sendRetryable) instead of a 204
   (sendNotFound), so the watch page treats the chip as `retry`, NOT as a stable
   6h `absent`. Without this distinction a single flaky worker fetch hid working
   anime-sama chips (sibnet/sendvid/vidmoly) from every visitor for 6h — the
   resolver returned null (indistinguishable from a real miss), which the client
   published into the availability snapshot as an absence. Genuine misses still
   return null; only upstream failures throw this. */
class TransientSourceError extends Error {
  /* `hostDown` distingue « cet episode a echoue » de « cet hote nous refuse ».
     Le premier laisse le chip peint (regle du 17/08) ; le second doit pouvoir
     l'eteindre, sans quoi on propose un choix qui ne peut pas aboutir. */
  constructor(message, { hostDown = false } = {}) {
    super(message);
    this.name = "TransientSourceError";
    this.transient = true;
    this.hostDown = hostDown;
  }
}

/* The opposite end of the same contract: an absence we PROVED, deterministically
   — the host itself answered 404 for this upload (vidmoly's dead-slug probe,
   verified HEAD 404 == GET 404). A plain `null` absence is only *probably* real:
   it can be an anti-bot decoy, which is why the click path retries it three
   times over 5.6 s and then refuses to publish it. Neither is worth doing to a
   proven 404 — the retries are pure spinner time and the refusal to publish is
   what made a dead chip come back on every reload (Clevatess S2 ep2 VF).
   Carried to the client as `{ absent: true, hard: true }`. */
class HardAbsenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "HardAbsenceError";
    this.hardAbsent = true;
  }
}

// Full Chrome desktop UA — anime-sama / voiranime reject the minimal "Mozilla/5.0"
// string on some endpoints (returns 403 or empty body) and we have no signal
// in the failure case. Using the same UA the m3u8 proxy already sends avoids
// that whole class of failure.
const SCRAPER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Bounded fetch: the Vercel function has a 10 s wall clock budget. A single
// hung upstream (anime-sama's catalogue page, a frozen episodes.js, voiranime's
// admin-ajax) would otherwise burn the entire budget and crash the whole probe
// chain. 5 s per request lets the slowest reasonable upstream finish while
// still leaving time for the extractor to run.
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || ctrl.signal,
      headers: {
        "User-Agent": SCRAPER_UA,
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

// anime-sama.to sits behind Cloudflare "I'm Under Attack" — every direct
// fetch from a Vercel AWS IP returns 403, so server-side scraping is dead
// in the water. The Cloudflare Worker that already proxies HLS segments
// runs on Cloudflare's own network, where anime-sama allows the request
// through. We route every anime-sama HTML fetch through the Worker so the
// scrape still works in production.
//
// PROXY_BASE defaults to the Cloudflare Worker (env var still overrides).
// anime-sama.to 403s direct Vercel fetches, so routing the scrape through the
// Worker's Cloudflare IPs is what makes server-side scraping work in prod.
// Hardcoded default (not "") because the env var proved unreliable — see
// UniversalPlayer for the full story.
const PROXY_BASE =
  process.env.NEXT_PUBLIC_PROXY_BASE ||
  "https://proxy.aniscroll.com";

async function fetchViaWorker(targetUrl, options = {}, timeoutMs = 5000) {
  // No worker configured → fall back to a direct fetch. Useful for local
  // dev where the developer's IP isn't on Cloudflare's blocklist.
  if (!PROXY_BASE) return fetchWithTimeout(targetUrl, options, timeoutMs);
  const proxied = `${PROXY_BASE}?url=${encodeURIComponent(targetUrl)}`;
  return fetchWithTimeout(proxied, options, timeoutMs);
}

// Vidmoly-specific aliveness check. Anime-sama / voir-anime scrapes often
// return slugs vidmoly has since removed (file deleted, dmca, expired). Both
// my browser-side extractor AND the iframe fallback then show vidmoly's own
// "This video not found" page — useless for the user. A HEAD on vidmoly.biz
// distinguishes a dead slug (404) from a live one (200): vidmoly returns
// 404 to every requester for missing slugs, verified against curl from
// multiple network perspectives and the browser fetch in the failing case.
// Returns true when the slug is reachable, false when it's gone.
async function isVidmolyEmbedAlive(embedUrl) {
  // ansembed.net slugs are NOT mirrored on vidmoly.biz — they're the same
  // backend but a distinct slug namespace, so rewriting the domain would probe
  // a slug that never existed and 404, hiding a perfectly live chip. Probe
  // ansembed on its own host; only the vidmoly.* variants are interchangeable.
  // voembed.net (voir-anime's myTV panel) gets the same treatment: probe where
  // the embed came from rather than betting on the mirror carrying the slug.
  const url = /(ansembed|voembed)\.net/i.test(embedUrl)
    ? embedUrl
    : embedUrl.replace(/vidmoly\.(to|biz|net)/i, "vidmoly.biz");
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "HEAD",
        headers: { "User-Agent": SCRAPER_UA },
        redirect: "follow",
      },
      3000,
    );
    return res.status !== 404;
  } catch {
    // Network error → don't punish the chip; let the client try.
    return true;
  }
}

// Quick reachability probe for iframe-fallback URLs. Returns true if the URL
// (after following redirects) responds with 2xx/3xx that the browser would
// actually render — false if the embed slug 404s or the host is otherwise
// dead. We use this so a "degraded" chip never points at a black 404 page.
// For Vidmoly specifically we also try .biz/.net/.to in turn since anime-sama
// sometimes lists a slug under whichever variant they scraped from.
async function isIframeReachable(iframeUrl) {
  const candidates = /vidmoly\.(to|net|biz)/i.test(iframeUrl)
    ? ["vidmoly.biz", "vidmoly.net", "vidmoly.to"].map((d) =>
        iframeUrl.replace(/vidmoly\.(to|net|biz)/i, d),
      )
    : [iframeUrl];
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            "User-Agent": SCRAPER_UA,
            Accept: "text/html,application/xhtml+xml",
          },
          redirect: "follow",
        },
        4000,
      );
      // 4xx (excl 405) means the embed slug is gone from this host. 5xx is
      // transient — accept it. Off-host HTTP redirect (vidmoly.to → scam) is
      // also a reject.
      const finalUrl = new URL(res.url);
      if (finalUrl.protocol !== "https:") continue;
      if (res.status >= 400 && res.status < 500 && res.status !== 405) continue;
      return true;
    } catch {
      // network error — try next candidate
    }
  }
  return false;
}

// Hosts where server-side extraction returns a REAL playable stream â€” we pull
// the m3u8 / mp4 directly so the universal Vidstack player can play it (with
// our subtitle / cast / download chrome) instead of dropping back to an iframe.
//
// History note: smoothpre / movearnpre used to also serve a relative
// `/stream/.../master.m3u8` path which was a TIKTOK IMAGE TRAP (anti-bot
// detection â€” segments were JPEG URLs from tiktokcdn). The current extractor
// (extractMovearnpre) prefers the absolute hls2 source from their CDN
// (dramiyos-cdn / acek-cdn / mindbodywellness.space) which serves real .ts
// segments in 1080p/720p. Tokens last ~1.5h.
//
// Dingtezuni / callistanise share the same packed-JS embed format. They're
// included optimistically â€” extractor will return { error: ... } if they're
// not actually playable, and the caller falls back to the raw iframe.
const EXTRACTABLE_HOSTS = [
  "sibnet.ru",
  "sendvid.com",
  // vidmoly: extraction + playback both route through the CF Worker. As
  // long as the extracted-from IP and the segment-fetched-from IP match
  // (both = Worker), the IP-bound master token stays valid end-to-end and
  // the user plays in the Universal Player without an iframe.
  "vidmoly",
  // ansembed.net — same white-label vidmoly backend, so it is listed for the
  // same reason "vidmoly" is: as a last-resort net. In practice neither is
  // reached from the anime-sama / voir-anime routes, because the VIDMOLY_HOST_RE
  // branch above returns a `clientExtract` first. That is deliberate — this
  // family's master token binds to whoever fetched the embed, so extracting it
  // HERE yields a stream only our own IP can play.
  "ansembed",
  // voembed.net — voir-anime's white-label of the same backend; same reason.
  "voembed",
  "embed4me",
  "lpayer",        // lpayer.embed4me.com
  "smoothpre",     // hls2 CDN bypass (was TikTok-trapped via /stream/ path)
  "movearnpre",
  "dingtezuni",
  "callistanise",
  // VOE serves voe.sx → JS-redirect → mirror domain → obfuscated JSON payload.
  // The extractor follows the redirect chain and decodes the payload to a
  // signed master.m3u8. See lib/extractors.js → extractVoe.
  "voe.sx",
  "voe.",          // catches voe-network.net, voe-unblock.com, etc.
  // uqload gates the embed on the EMBEDDING site's Referer (anime-sama), so a
  // raw iframe fallback would just render its "embed restricted" page — treat
  // it like sibnet/sendvid below and hide the chip on extraction failure
  // rather than degrade to a dead iframe. See lib/extractors.js → extractUqload.
  "uqload.",
];

// ── Frembed (VF + VOSTFR in ONE stream) ──────────────────────────────────
//
// Two asymmetric gates, both measured 2026-08-30 — get them backwards and
// everything 403s:
//   • the JSON api REQUIRES a frembed.casa Referer;
//   • its CDN REFUSES that same Referer, and serves anyone else.
// So the api call below sends it, and playback strips it — the streams are
// flagged `directUrl`, which makes UniversalPlayer set referrerPolicy
// "no-referrer" on the <video> and skip the proxy entirely. That skip is the
// whole point of this source: the CDN answers `Access-Control-Allow-Origin: *`,
// so segments never touch the Worker or the Fluid budget.
//
// One master.m3u8 carries both audio renditions and the French subtitle
// tracks, so the two chips resolve the SAME url and differ only by the
// `audioLang` the player pins.
//
// Deux index, pas un : les series vivent sous `type=serie` (id TMDB *tv* +
// saison + episode), les FILMS sous `type=movie` (id TMDB *movie*, sans
// coordonnees). Un film n'a donc ni saison a detecter ni concatenation a
// parcourir — et son master n'est pas toujours bilingue, cf. frembedCarriesAudio.
const FREMBED_BASE = "https://frembed.casa";
// The master ships TWO French subtitle tracks — "FR Forced" (on-screen signs
// only, and flagged DEFAULT) and "FR Full". Which one a chip wants follows its
// audio: a French dub needs signs only, the Japanese original needs the full
// dialogue. Without this the VO chip inherited the DEFAULT forced track and
// looked like it had no subtitles at all.
// Le chip VF est en `none` : un doublage francais se regarde SANS sous-titres.
// Les deux pistes restent servies — on peut les activer dans le menu, et un
// choix explicite du spectateur continue de primer — elles ne sont simplement
// pas allumees d'office.
const FREMBED_SERVERS = {
  frembed: { audioLang: "fr", subtitlePref: "none" },
  "frembed-vo": { audioLang: "ja", subtitlePref: "full" },
};

/* Frembed indexes on TMDB's season numbering, which splits a long-running show
   into arc-"seasons" (One Piece: 22, Naruto Shippuden: 20) while AniList keeps
   it as ONE absolutely-numbered entry. Below this many seasons we never walk
   the concatenation for a season that EXISTS — a 12-episode show frembed only
   half-hosts would otherwise be "rescued" straight into the next season's
   episode 1. No ordinary anime is cut into six TMDB seasons; every long-runner
   is. */
const FREMBED_LONG_RUNNER_SEASONS = 6;

/** `sa`/`ep` null = a FILM: frembed indexes those on the TMDB *movie* id, with
 *  no season/episode coordinates at all (`?tmdb=<movieId>&type=movie`). */
async function fetchFrembedPayload(tmdbId, sa, ep) {
  const query =
    sa == null
      ? `?tmdb=${tmdbId}&type=movie`
      : `?tmdb=${tmdbId}&type=serie&sa=${sa}&ep=${ep}`;
  const res = await fetchWithTimeout(
    `${FREMBED_BASE}/api/streaming/player${query}`,
    {
      headers: {
        Referer: `${FREMBED_BASE}/streaming/player`,
        Accept: "application/json",
      },
    },
  );
  // 404 = frembed has never heard of this tmdb id. A real, deterministic
  // absence — not worth a retry.
  if (res.status === 404) return null;
  if (!res.ok) throw new TransientSourceError(`frembed api ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new TransientSourceError("frembed api returned non-JSON");
  }
}

/** The playable source in a frembed payload, or null when it holds none.
 *  An episode frembed doesn't host answers 200 with `sources: []`.
 *  The `label` matters on films — see frembedCarriesAudio. */
function frembedSource(payload) {
  const src = payload?.sources?.[0];
  const url = src?.url;
  if (typeof url !== "string" || !/\.m3u8/i.test(url)) return null;
  return { url, label: typeof src.label === "string" ? src.label : "" };
}

/**
 * Does this master actually carry the audio the chip stands for?
 *
 * Series are uniform — every one of the 12 sampled on 2026-08-31 answers with a
 * single `Premium` source whose master declares both `fr` and `ja` renditions,
 * which is why both chips could be painted unconditionally. FILMS are not: they
 * come as `Premium` (same dual-audio shape) OR as `Free VF`, a single muxed
 * French track with no rendition list and no subtitles at all (Your Name,
 * measured). Painting the VO chip on one of those hands a viewer who asked for
 * the Japanese original a French dub, silently — the player pins the `ja`
 * rendition, finds none, and plays what's there.
 *
 * So: trust the rendition list when the master publishes one, and fall back to
 * the source label when it doesn't (that label is then the ONLY language signal
 * in the payload). An unreadable label reads as French — frembed is a French
 * host and its single-track uploads are dubs.
 */
function frembedCarriesAudio(manifest, label, audioLang) {
  const langs = [];
  for (const line of manifest.split(/\r?\n/)) {
    if (!/^#EXT-X-MEDIA:/.test(line) || !/TYPE=AUDIO/.test(line)) continue;
    const m = line.match(/LANGUAGE="([^"]*)"/);
    if (m) langs.push(m[1].slice(0, 2).toLowerCase());
  }
  if (langs.length) return langs.includes(audioLang);
  return (/vostfr|\bvo\b|sub/i.test(label) ? "ja" : "fr") === audioLang;
}

/**
 * The master's subtitle renditions, resolved to plain .vtt urls.
 *
 * WHY SIDECAR AND NOT IN-MANIFEST. hls.js renders text tracks natively by
 * default, so it never emits the non-native-tracks event Vidstack listens for:
 * the tracks played but `player.textTracks` stayed EMPTY, which meant no track
 * menu, no style editor, no CC button. Handing the same cues over as ordinary
 * sidecar tracks puts them through the path megaplay already uses, where all of
 * that works — and costs nothing extra at playback since the player then tells
 * hls.js nothing about them.
 *
 * Each rendition is a one-line playlist pointing at a single `subtitle.vtt`
 * (measured 2026-08-30), so resolving one is a single cheap fetch; they run in
 * parallel and the whole payload is cached for 5 min like any other resolve.
 *
 * Fail-soft: a rendition we can't resolve is dropped, never thrown — losing a
 * subtitle track must not cost the viewer the video.
 */
async function frembedSubtitles(manifest, masterUrl, subtitlePref) {
  const renditions = [];
  for (const line of manifest.split(/\r?\n/)) {
    if (!/^#EXT-X-MEDIA:/.test(line) || !/TYPE=SUBTITLES/.test(line)) continue;
    const attr = (name) =>
      (line.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || "";
    const uri = attr("URI");
    if (!uri) continue;
    renditions.push({
      uri,
      language: attr("LANGUAGE"),
      name: attr("NAME"),
      forced: /FORCED=YES/.test(line),
    });
  }
  if (renditions.length === 0) return [];

  const wantForcedDefault = subtitlePref === "forced";
  const resolved = await Promise.all(
    renditions.map(async (r) => {
      try {
        const playlistUrl = new URL(r.uri, masterUrl).toString();
        const res = await fetchWithTimeout(playlistUrl, {}, 4000);
        if (!res.ok) return null;
        const segment = (await res.text())
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("#"));
        if (!segment) return null;
        return {
          file: new URL(segment, playlistUrl).toString(),
          // The host names them "FR Forced : SRT" / "FR Full : SRT"; the format
          // suffix means nothing to a viewer.
          label: (r.name || r.language || "Subtitle").replace(/\s*:\s*SRT$/i, ""),
          // Two-letter code: what the player stores as the viewer's remembered
          // subtitle language. The host writes ISO 639-2 ("fra").
          language: FREMBED_LANG_ALIASES[r.language.toLowerCase()] || r.language,
          kind: "subtitles",
          // A dub wants signs only; a subtitled original wants the dialogue.
          // `none` (le chip VF) n'en marque aucune.
          default: subtitlePref !== "none" && r.forced === wantForcedDefault,
          // Lu par le tri juste apres, puis inutile au client.
          forced: r.forced,
        };
      } catch {
        return null;
      }
    }),
  );
  const tracks = resolved.filter(Boolean);

  /* L'ORDRE EST LE CONTRAT. Le selecteur du lecteur prend « la PREMIERE piste
     qui correspond a la langue », et nos deux pistes portent la meme (`fr`) :
     c'est donc l'ordre qui decide laquelle est retenue, et rien d'autre.
     On met en tete celle que le chip veut, et tout s'aligne — y compris la
     coche du menu, qui numerote les memes pistes dans le meme ordre. Le
     30/08/2026, en laissant l'ordre du manifeste (forcee d'abord), la piste
     JOUEE et la piste COCHEE n'etaient pas la meme : des sous-titres
     s'affichaient sans qu'aucune ligne du menu ne soit surlignee.
     `subtitlePref: "none"` (le doublage VF) ne change pas l'ordre — il n'y a
     rien a preferer quand on n'allume rien ; c'est `defaultOff` plus bas qui
     porte ce cas. */
  if (subtitlePref === "forced" || subtitlePref === "full") {
    const wantForced = subtitlePref === "forced";
    tracks.sort((a, b) => (b.forced === wantForced) - (a.forced === wantForced));
  }
  return tracks;
}

/** ISO 639-2 → 639-1 for the codes frembed actually emits. */
const FREMBED_LANG_ALIASES = { fra: "fr", fre: "fr", eng: "en", jpn: "ja" };

/**
 * LIVENESS PROBE — does the CDN actually serve this master?
 *
 * Every other host in this file proves its candidate before we paint a chip
 * (isVidmolyEmbedAlive, isIframeReachable); frembed was handing over whatever
 * url its JSON api announced, unverified. Those are two different claims: the
 * api says "this episode is in my catalogue", the CDN says "and here are the
 * bytes". When only the first held, the chip lit up and then died at playback —
 * the player errored, markFailed pulled it, and it came back on the next load
 * from the availability snapshot. That is the "frembed appears then disappears"
 * loop.
 *
 * Fetching the master is also the ONLY thing we needed it for anyway (the
 * subtitle renditions are parsed out of it), so proving the source costs no
 * extra round trip.
 *
 * The verdict is three-way on purpose, because collapsing it is what poisons
 * the 6h availability snapshot:
 *   alive              → serve it;
 *   absent (404/410)   → a real, deterministic miss, safe to negative-cache;
 *   transient (429, 5xx, a Cloudflare 403 for rate, timeout, network) → 503, so
 *                        the chip is left alone instead of being buried. The
 *                        CDN DOES rate-limit a busy client — measured while
 *                        probing it — and one of those must never read as "this
 *                        episode does not exist".
 */
async function frembedProbeMaster(masterUrl) {
  let res;
  try {
    // No Referer, deliberately: this is the CDN, which 403s frembed's own.
    res = await fetchWithTimeout(masterUrl, {}, 5000);
  } catch (e) {
    return { transient: true, reason: `frembed cdn unreachable: ${e.message}` };
  }
  if (res.status === 404 || res.status === 410) {
    return { absent: true, reason: `frembed cdn ${res.status}` };
  }
  if (!res.ok) {
    return { transient: true, reason: `frembed cdn ${res.status}` };
  }
  const manifest = await res.text();
  // A master that isn't a playlist is an error page wearing a 200 — the CDN's
  // Cloudflare block page is exactly that. Never hand it to the player.
  if (!/^\s*#EXTM3U/.test(manifest)) {
    return { transient: true, reason: "frembed cdn returned a non-playlist body" };
  }
  return { manifest };
}

/**
 * Second-chance coordinates when (detected season, episode) came back empty.
 *
 * Every payload — even one for a season that doesn't exist — carries the full
 * `seasonData.seasons` layout, which is why one api call is enough to both
 * attempt and learn. Two shapes need remapping, and they are the same two the
 * anime-sama resolver already fights, so they reuse its offset primitive:
 *
 *   • FUSION. TMDB folds several AniList seasons into one (Jujutsu Kaisen:
 *     no season 2 at all, its 41 hosted episodes are S1's). The season we
 *     asked for is ABSENT, so we index into the concatenation instead.
 *   • ARC-SPLIT. A long-runner's AniList episode number is absolute and runs
 *     past TMDB season 1 (One Piece ep 500). The season EXISTS but is short,
 *     which is why this branch is gated on FREMBED_LONG_RUNNER_SEASONS.
 *
 * Returns null rather than a guess whenever the offset can't be anchored — see
 * the season-≥2-at-offset-0 refusal, which is the difference between "no
 * source" and silently playing season 1's episode 1.
 */
async function remapFrembedTarget(aniId, episode, seasonNum, payload) {
  const seasons = payload?.seasonData?.seasons || {};
  const keys = (payload?.seasonData?.sortedSeasonKeys || Object.keys(seasons))
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (keys.length === 0) return null;

  const seasonExists = Array.isArray(seasons[String(seasonNum)]);
  if (seasonExists && keys.length < FREMBED_LONG_RUNNER_SEASONS) return null;

  // Index by the episode LABEL, never by position. On the shows this branch
  // exists for, the two disagree: frembed's arrays carry the real episode
  // numbers and its catalogue has holes, so One Piece's 1021 hosted slots span
  // labels 1-1155 (134 missing, measured 2026-08-30). Counting to the 500th
  // slot lands on episode 577 — the wrong arc, silently. Looking the label up
  // is exact, and a label frembed doesn't host is simply absent.
  const seasonOfLabel = new Map();
  for (const k of keys) {
    for (const ep of seasons[String(k)] || []) {
      const n = Number(ep);
      if (Number.isFinite(n) && !seasonOfLabel.has(n)) seasonOfLabel.set(n, k);
    }
  }
  if (seasonOfLabel.size === 0) return null;

  const index = Number(episode) - 1;
  if (index < 0) return null;

  let offset = 0;
  if (seasonNum > 1) {
    const meta = await getMediaMeta(aniId);
    offset = await resolveMergedOffset(
      aniId,
      index,
      seasonOfLabel.size,
      Number(meta?.episodes) || 0,
    );
    // A season ≥2 that lands at offset 0 is season 1's episode by definition.
    // resolveMergedOffset returns 0 for every offset it can't anchor (unknown
    // prequel counts, a chain that doesn't fit), and frembed hosting FEWER
    // episodes than AniList counts is enough to make it decline — Jujutsu
    // Kaisen's 41 hosted against a 24+23 chain. Refusing here costs a chip;
    // trusting it would play the wrong episode with no way for the viewer to
    // tell.
    if (offset === 0) return null;
  }

  // The absolute episode number this request lands on once the prequel seasons
  // are accounted for — which IS frembed's label on both shapes this branch
  // handles (a fused season numbers straight through; a long-runner's arcs
  // continue each other: One Piece S1 = 1-61, S2 = 62-77, …).
  const label = Number(episode) + offset;
  const sa = seasonOfLabel.get(label);
  return sa != null ? { sa, ep: label } : null;
}

/**
 * Resolve one frembed chip to a direct, proxy-free stream.
 *
 * Returns null for a genuine miss (no TMDB mapping, episode not hosted) and
 * throws TransientSourceError for an upstream hiccup, per this file's contract.
 */
async function getFrembedStream(serverKey, aniId, episode) {
  const def = FREMBED_SERVERS[serverKey];
  if (!def) return null;

  // Fribb's `themoviedb_id` is a static cross-map we already ingest, so the
  // AniList → TMDB hop costs no network call and no TMDB api key. Its weak
  // field is `season` (it collides and fuses) — which is exactly the field we
  // don't read: the season comes from our own resolver below.
  //
  // `getFribbEntry` swallows its own errors and answers null for BOTH "this
  // anime has no mapping" (stable) and "the database didn't answer"
  // (transient). Collapsing the two let a Turso hiccup be negative-cached for
  // 10 min and published into the 6h availability snapshot — the chip vanishing
  // for everyone over a blip. A second look separates them: a missing mapping
  // is a static fact that answers null twice, a hiccup usually doesn't.
  let fribb = await getFribbEntry(Number(aniId));
  if (!fribb) fribb = await getFribbEntry(Number(aniId));

  // FILMS. Frembed catalogues them under the TMDB *movie* id, on a `type=movie`
  // route with no season/episode coordinates — a different index entirely, and
  // one Fribb already gives us (`tmdb_movie_id`, ingested since day one). Until
  // 2026-08-31 we only ever read `tmdbTvId`, so every anime film fell out at the
  // "no tmdb.tv mapping" line below and lost its chips while frembed hosted the
  // file. AniList's own format decides, not Fribb: a film that ALSO carries a tv
  // id (it belongs to a franchise TMDB files as a show) must still be looked up
  // as a movie. Sans tv id, le film est le seul choix possible.
  const movieId = fribb?.tmdbMovieId || null;
  const tvId = fribb?.tmdbTvId || null;
  // AniList n'est interroge que dans le cas ambigu (les deux ids existent) —
  // une serie ordinaire n'a pas d'id film et ne paie donc rien de plus.
  const asMovie =
    !!movieId &&
    (!tvId || (await getMediaMeta(aniId).catch(() => null))?.format === "MOVIE");
  const tmdbId = asMovie ? movieId : tvId;
  if (!tmdbId) {
    dlog(`[frembed] no tmdb mapping for AniList ${aniId}`);
    return null;
  }

  // A film has no coordinates to detect, to walk, or to remap: one id, one file.
  const seasonNum = asMovie ? null : await detectSeasonNumber(aniId);
  let payload = await fetchFrembedPayload(tmdbId, seasonNum, episode);
  if (!payload) return null;

  let source = frembedSource(payload);
  if (!source && !asMovie) {
    const target = await remapFrembedTarget(aniId, episode, seasonNum, payload);
    if (!target) return null;
    dlog(
      `[frembed] tmdb ${tmdbId}: S${seasonNum}E${episode} empty → remapped to S${target.sa}E${target.ep}`,
    );
    payload = await fetchFrembedPayload(tmdbId, target.sa, target.ep);
    if (!payload) return null;
    source = frembedSource(payload);
  }
  if (!source) return null;
  const master = source.url;

  // Prove the CDN before painting a chip — see frembedProbeMaster.
  const probe = await frembedProbeMaster(master);
  if (probe.transient) throw new TransientSourceError(probe.reason);
  if (probe.absent) {
    dlog(`[frembed] ${probe.reason} for ${master}`);
    return null;
  }

  // …and prove the LANGUAGE too: a `Free VF` film carries French audio only, so
  // the VO chip has nothing to pin and would play the dub. See frembedCarriesAudio.
  if (!frembedCarriesAudio(probe.manifest, source.label, def.audioLang)) {
    dlog(
      `[frembed] ${serverKey}: "${source.label}" ne porte pas d'audio ${def.audioLang} — chip absent`,
    );
    return null;
  }

  return {
    streams: [
      {
        url: master,
        // Uniform across every title sampled (10/10 on 2026-08-30); the master
        // advertises the real ladder anyway, this is only the chip's label.
        quality: "1080p",
        isM3U8: true,
        // No proxy: the CDN is CORS-open and 403s a frembed Referer.
        directUrl: true,
        // Which of the master's two audio renditions this chip is, and which
        // of its two French subtitle tracks goes with it.
        audioLang: def.audioLang,
        subtitlePref: def.subtitlePref,
      },
    ],
    // Lifted out of the master and handed over as ordinary sidecar tracks —
    // see frembedSubtitles for why in-manifest renditions were invisible to
    // the player's own subtitle UI.
    subtitles: await frembedSubtitles(probe.manifest, master, def.subtitlePref),
  };
}

/**
 * POST /api/v2/source
 *
 * Body: { server, aniId, episode, sub }
 *   - server   : server id from lib/servers.js
 *   - aniId    : AniList anime id
 *   - episode  : episode number
 *   - sub      : "sub" | "dub"
 *
 * Returns: { streams, subtitles } OR { iframe } for embed-based servers
 */

const COOREN_BASE = process.env.COOREN_API_URL || "";

// â”€â”€ HiAnime (direct AJAX) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const HIANIME_BASE = "https://aniwatchtv.to";
const HIANIME_SERVERS = {
  "hianime-vidsrc": { name: "VidSrc", serverId: 4 },
  "hianime-megacloud": { name: "MegaCloud", serverId: 1 },
  "hianime-tcloud": { name: "T-Cloud", serverId: 6 },
};

async function getHiAnimeIframe(serverKey, title, episode, sub) {
  try {
    const serverDef = HIANIME_SERVERS[serverKey];
    if (!serverDef) return null;
    const category = sub === "dub" ? "dub" : "sub";

    // 1. Search for the anime
    const searchRes = await fetch(
      `${HIANIME_BASE}/search?keyword=${encodeURIComponent(title)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!searchRes.ok) return null;
    const searchHtml = await searchRes.text();
    const $s = cheerio.load(searchHtml);

    let animeUrl = $s(".film_list-wrap .flw-item .film-detail .film-name a").first().attr("href");
    if (!animeUrl) return null;
    animeUrl = animeUrl.split("?")[0]; // strip ?ref=search

    // 2. Get anime page to find the data-id
    const pageRes = await fetch(`${HIANIME_BASE}${animeUrl}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!pageRes.ok) return null;
    const pageHtml = await pageRes.text();
    const $p = cheerio.load(pageHtml);
    const animeDataId = $p("[data-id]").first().attr("data-id");
    if (!animeDataId) return null;

    // 3. Get episode list via AJAX
    const epRes = await fetch(
      `${HIANIME_BASE}/ajax/v2/episode/list/${animeDataId}`,
      { headers: { "X-Requested-With": "XMLHttpRequest", "Referer": `${HIANIME_BASE}${animeUrl}` } }
    );
    if (!epRes.ok) return null;
    const epData = await epRes.json();
    const $e = cheerio.load(epData.html);

    // Find the episode link matching the episode number
    let episodeDataId = null;
    $e(".ep-item").each((_, el) => {
      const num = $e(el).attr("data-number");
      if (String(num) === String(episode)) {
        episodeDataId = $e(el).attr("data-id");
      }
    });
    if (!episodeDataId) return null;

    // 3. Get server list for this episode
    const srvRes = await fetch(
      `${HIANIME_BASE}/ajax/v2/episode/servers?episodeId=${episodeDataId}`,
      { headers: { "X-Requested-With": "XMLHttpRequest", "Referer": HIANIME_BASE } }
    );
    if (!srvRes.ok) return null;
    const srvData = await srvRes.json();
    const $srv = cheerio.load(srvData.html);

    // Find the matching server data-id
    let sourceDataId = null;
    $srv(".server-item").each((_, el) => {
      const sid = $srv(el).attr("data-server-id");
      const type = $srv(el).attr("data-type");
      if (String(sid) === String(serverDef.serverId) && type === category) {
        sourceDataId = $srv(el).attr("data-id");
      }
    });
    if (!sourceDataId) return null;

    // 4. Get the iframe source link
    const srcRes = await fetch(
      `${HIANIME_BASE}/ajax/v2/episode/sources?id=${sourceDataId}`,
      { headers: { "X-Requested-With": "XMLHttpRequest", "Referer": HIANIME_BASE } }
    );
    if (!srcRes.ok) return null;
    const srcData = await srcRes.json();

    if (!srcData?.link) return null;

    return { iframe: srcData.link };
  } catch (e) {
    console.error(`HiAnime ${serverKey} error:`, e.message);
    return null;
  }
}

// â”€â”€ CoorenLabs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const COOREN_PROVIDERS = {
  "cooren-animepahe":  "animepahe",
  "cooren-animekai":   "animekai",
  "cooren-toonstream": "toonstream",
  "cooren-animesalt":  "animesalt",
};

async function getCoorenStream(providerKey, title, episode, sub) {
  if (!COOREN_BASE) return null;

  try {
    const provider = COOREN_PROVIDERS[providerKey];
    if (!provider) return null;

    if (provider === "animepahe")  return await getCoorenAnimePahe(title, episode, sub);
    if (provider === "animekai")   return await getCoorenAnimekai(title, episode, sub);
    if (provider === "toonstream") return await getCoorenToonstream(title, episode);
    if (provider === "animesalt")  return await getCoorenAnimesalt(title, episode);

    return null;
  } catch (e) {
    console.error(`Cooren ${providerKey} error:`, e.message);
    return null;
  }
}

// â”€â”€ Toonstream â€” series + episode â†’ m3u8 sources â”€â”€
async function getCoorenToonstream(title, episode) {
  const searchRes = await fetch(
    `${COOREN_BASE}/anime/toonstream/search/${encodeURIComponent(title)}`
  );
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const series = searchData?.results?.[0] || searchData?.[0] || null;
  if (!series?.slug && !series?.id) return null;

  const slug = series.slug || series.id;
  const infoRes = await fetch(
    `${COOREN_BASE}/anime/toonstream/series/info/${encodeURIComponent(slug)}`
  );
  if (!infoRes.ok) return null;
  const infoData = await infoRes.json();
  const episodes = infoData?.episodes || infoData?.results || [];
  const ep = episodes.find(
    (e) => Number(e.number ?? e.episode) === Number(episode)
  ) || episodes[Number(episode) - 1];
  if (!ep?.slug && !ep?.id) return null;

  const epSlug = ep.slug || ep.id;
  const srcRes = await fetch(
    `${COOREN_BASE}/anime/toonstream/episode/sources/${encodeURIComponent(epSlug)}`
  );
  if (!srcRes.ok) return null;
  const srcData = await srcRes.json();
  const sources = srcData?.sources || srcData?.results || [];
  if (!sources.length) return null;

  return {
    streams: sources
      .filter((s) => s.url || s.file)
      .map((s) => ({
        url: s.url || s.file,
        quality: s.quality || s.label || "default",
        isM3U8: (s.url || s.file || "").includes(".m3u8"),
      })),
    subtitles: (srcData?.subtitles || []).map((s) => ({
      file: s.url || s.file,
      label: s.lang || s.label || "Subtitle",
      kind: s.kind || "captions",
    })),
    referer: srcData?.headers?.Referer || null,
  };
}

// â”€â”€ Animesalt â€” same shape as Toonstream â”€â”€
async function getCoorenAnimesalt(title, episode) {
  const searchRes = await fetch(
    `${COOREN_BASE}/anime/animesalt/search/${encodeURIComponent(title)}`
  );
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const series = searchData?.results?.[0] || searchData?.[0] || null;
  if (!series?.slug && !series?.id) return null;

  const slug = series.slug || series.id;
  const infoRes = await fetch(
    `${COOREN_BASE}/anime/animesalt/series/info/${encodeURIComponent(slug)}`
  );
  if (!infoRes.ok) return null;
  const infoData = await infoRes.json();
  const episodes = infoData?.episodes || infoData?.results || [];
  const ep = episodes.find(
    (e) => Number(e.number ?? e.episode) === Number(episode)
  ) || episodes[Number(episode) - 1];
  if (!ep?.slug && !ep?.id) return null;

  const epSlug = ep.slug || ep.id;
  const srcRes = await fetch(
    `${COOREN_BASE}/anime/animesalt/episode/sources/${encodeURIComponent(epSlug)}`
  );
  if (!srcRes.ok) return null;
  const srcData = await srcRes.json();
  const sources = srcData?.sources || srcData?.results || [];
  if (!sources.length) return null;

  return {
    streams: sources
      .filter((s) => s.url || s.file)
      .map((s) => ({
        url: s.url || s.file,
        quality: s.quality || s.label || "default",
        isM3U8: (s.url || s.file || "").includes(".m3u8"),
      })),
    subtitles: (srcData?.subtitles || []).map((s) => ({
      file: s.url || s.file,
      label: s.lang || s.label || "Subtitle",
      kind: s.kind || "captions",
    })),
    referer: srcData?.headers?.Referer || null,
  };
}

async function getCoorenAnimePahe(title, episode, sub) {
  const searchRes = await fetch(
    `${COOREN_BASE}/anime/animepahe/search/${encodeURIComponent(title)}`
  );
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();

  const anime =
    searchData?.results?.[0] || searchData?.data?.results?.[0] || null;
  if (!anime?.session && !anime?.id) return null;

  const animeId = anime.session || anime.id;

  // Get episodes
  const epRes = await fetch(
    `${COOREN_BASE}/anime/animepahe/episodes/${animeId}`
  );
  if (!epRes.ok) return null;
  const epData = await epRes.json();

  const episodes = epData?.data || epData?.results || epData || [];
  const ep = Array.isArray(episodes)
    ? episodes.find((e) => e.episode === Number(episode) || e.number === Number(episode))
    : null;
  if (!ep?.session) return null;

  // Get stream - returns NDJSON
  const streamRes = await fetch(
    `${COOREN_BASE}/anime/animepahe/episode/${animeId}/${ep.session}`
  );
  if (!streamRes.ok) return null;
  const text = await streamRes.text();

  // Parse NDJSON lines
  const sources = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);

  // Filter by sub/dub preference
  const filtered = sources.filter((s) =>
    sub === "dub" ? s.isDub === true : s.isDub !== true
  );
  const best = filtered.length > 0 ? filtered : sources;

  return {
    streams: best.map((s) => ({
      url: s.directUrl || s.url,
      quality: s.quality || s.resolution || "default",
    })),
    // Pass corsHeaders so the client proxy can use them
    referer: best[0]?.corsHeaders?.Referer || null,
  };
}

async function getCoorenAnimekai(title, episode, sub) {
  const searchRes = await fetch(
    `${COOREN_BASE}/anime/animekai/search/${encodeURIComponent(title)}`
  );
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();

  const anime = searchData?.results?.[0] || null;
  if (!anime?.id) return null;

  // Get info + episodes (path param, not query string)
  const infoRes = await fetch(
    `${COOREN_BASE}/anime/animekai/info/${encodeURIComponent(anime.id)}`
  );
  if (!infoRes.ok) return null;
  const infoData = await infoRes.json();

  const episodes = infoData?.episodes || [];
  const ep = episodes.find(
    (e) => e.number === Number(episode)
  );
  if (!ep?.id) return null;

  dlog(`[animekai] Episode ID: ${ep.id}`);

  // Get stream sources â€” returns { results: [{ sources, subtitles, name }] }
  const watchRes = await fetch(
    `${COOREN_BASE}/anime/animekai/watch/${encodeURIComponent(ep.id)}${
      sub === "dub" ? "?dub=true" : ""
    }`
  );
  if (!watchRes.ok) return null;
  const watchData = await watchRes.json();

  // Each result has its own sources/subtitles â€” merge all
  const results = watchData?.results || [];
  if (results.length === 0) return null;

  const allStreams = [];
  const allSubtitles = [];
  for (const r of results) {
    const sources = r.sources || [];
    const subs = r.subtitles || [];
    for (const s of sources) {
      allStreams.push({ url: s.url, quality: r.name || "default" });
    }
    for (const s of subs) {
      if (!allSubtitles.find((x) => x.label === (s.lang || s.label))) {
        allSubtitles.push({
          file: s.url || s.file,
          label: s.lang || s.label,
          kind: s.kind || "captions",
        });
      }
    }
  }

  return {
    streams: allStreams,
    subtitles: allSubtitles,
    referer: "https://megaup.cc/",
  };
}

// â”€â”€ Anime-Sama (VF + VOSTFR) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ANIMESAMA_BASE = "https://anime-sama.to";
// In-memory caches to avoid AniList rate limits from parallel pre-check probes
const seasonCache = new Map();
const slugCache = new Map();
const ANIMESAMA_SERVERS = {
  // VF (French dub)
  "animesama-sibnet":       { name: "Sibnet",      preferred: ["sibnet.ru"],                              lang: "vf" },
  "animesama-sendvid":      { name: "Sendvid",     preferred: ["sendvid.com"],                            lang: "vf" },
  // Ansembed REPLACES anime-sama's old Vidmoly entry: the site migrated its
  // vidmoly uploads to this white-label domain and no longer lists vidmoly.*
  // on ANY panel (measured over 17 panels, 0 hits — while ansembed appears on
  // 11 of 12, more often than sibnet). The old "animesama-vidmoly" server was
  // therefore dead: it could never match an array, so it only ever cost a
  // resolution attempt per episode. Voir-Anime's vidmoly is a DIFFERENT site
  // with its own uploads and stays.
  "animesama-ansembed":     { name: "Ansembed",    preferred: ["ansembed."],                              lang: "vf" },
  "animesama-embed4me":     { name: "Embed4Me",    preferred: ["embed4me.com", "lpayer"],                 lang: "vf" },
  "animesama-callistanise": { name: "Player",      preferred: ["callistanise.com", "dingtezuni.com", "movearnpre.com"], lang: "vf" },
  // Fallback only — uqload's stream token is IP/single-use-bound (a concurrent
  // pull 403s), so it's the least reliable host; kept last so it's offered only
  // when the more robust players above are unavailable.
  "animesama-uqload":       { name: "Uqload",      preferred: ["uqload."],                                lang: "vf" },
  // VOSTFR (Japanese + French subs)
  "animesama-sibnet-vo":       { name: "Sibnet",      preferred: ["sibnet.ru"],                              lang: "vostfr" },
  "animesama-sendvid-vo":      { name: "Sendvid",     preferred: ["sendvid.com"],                            lang: "vostfr" },
  "animesama-ansembed-vo":     { name: "Ansembed",    preferred: ["ansembed."],                              lang: "vostfr" },
  "animesama-embed4me-vo":     { name: "Embed4Me",    preferred: ["embed4me.com", "lpayer"],                 lang: "vostfr" },
  "animesama-callistanise-vo": { name: "Player",      preferred: ["callistanise.com", "dingtezuni.com", "movearnpre.com"], lang: "vostfr" },
  "animesama-uqload-vo":       { name: "Uqload",      preferred: ["uqload."],                                lang: "vostfr" },
};

/**
 * anime-sama stores some panels with MULTIPLE dub tracks under sibling language
 * dirs: a VF release can live at `vf`, `vf1` or `vf2` (e.g. One Piece keeps a
 * Netflix VF at `vf` and an older VF at `vf2`). A plain `vf` request must fall
 * back to those siblings instead of 404ing. Order: the requested dir first,
 * then its numbered variants. VOSTFR rarely splits, so we leave it as-is.
 */
function animeSamaLangDirs(langPath, exclude) {
  const all = langPath === "vf" ? ["vf", "vf1", "vf2", "vf3"] : [langPath];
  return exclude?.size ? all.filter((d) => !exclude.has(d)) : all;
}

/**
 * Choisit le repertoire de langue qui porte VRAIMENT l'episode chez l'hote
 * demande, au lieu du premier qui repond.
 *
 * Le piege, mesure le 17/08/2026 sur One Piece VF : `saison1/vf` ET
 * `saison1/vf2` portent tous deux ansembed, mais le slug de `vf`
 * (`embed-1j1tjy3qqbs7`) est MORT — 404 — tandis que celui de `vf2`
 * (`embed-na2vrsevfe89`) est vivant. En s'arretant au premier panneau qui
 * repondait, on ramassait le mort et on declarait l'hote absent, alors que le
 * lecteur marchait parfaitement sur le site. Les trois boucles de langue du
 * fichier avaient ce defaut.
 *
 * Deux niveaux, et les deux comptent :
 *   1. l'hote n'est pas du tout dans ce panneau  → on passe au suivant, gratuit
 *      (les panneaux sont de toute facon deja telecharges) ;
 *   2. l'hote y est mais son upload est mort     → seule la verification de
 *      vivacite, plus loin, peut le dire ; l'appelant relance alors la
 *      resolution en excluant le repertoire deja tente (cf. `excludeLangs`).
 *
 * `fallback` porte le premier panneau qui a repondu meme sans l'hote : sans lui
 * on ne saurait plus distinguer « panneau introuvable » (mapping casse) de
 * « panneau sain, hote absent » (absence honnete), ce que fetchPanelIframe doit
 * rendre a son appelant.
 */
async function pickLangDirForHost(slug, seasonDir, langDirs, serverDef, index) {
  let fallback = null;
  for (const lp of langDirs) {
    let res;
    try {
      res = await fetchViaWorker(
        `${ANIMESAMA_BASE}/catalogue/${slug}/${seasonDir}/${lp}/episodes.js`,
      );
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const episodeArrays = parseEpisodesJs(await res.text());
    if (episodeArrays.length === 0) continue;
    if (!fallback) fallback = { langDir: lp, episodeArrays };
    const url = pickPreferredEpisodeUrl(episodeArrays, serverDef.preferred, index);
    if (url) return { langDir: lp, episodeArrays, url };
  }
  return fallback ? { ...fallback, url: null } : null;
}

/**
 * Fetch an iframe URL straight from a KNOWN anime-sama panel — the player_map
 * fast-path. Skips slug search, season detection and the detail page entirely
 * (1 upstream fetch instead of 4–8).
 *
 * Returns { panelOk, iframeUrl }:
 *   panelOk=false           → the panel itself is unreachable/empty: the MAPPING
 *                             is broken (site restructured) — caller flags the
 *                             row and falls back to the full heuristics.
 *   panelOk=true, url=null  → the panel is fine but this host/episode isn't in
 *                             it (host not mirrored, or episode not aired yet).
 *                             That's an authoritative miss — the heuristics
 *                             would reach the same panel and conclude the same.
 */
async function fetchPanelIframe(slug, seasonDir, langPath, serverDef, index, excludeLangs) {
  const tryLangs = /^film/i.test(seasonDir)
    ? [langPath, langPath === "vf" ? "vostfr" : "vf"].filter(
        (d) => !excludeLangs?.has(d),
      ) // films are often single-language
    : animeSamaLangDirs(langPath, excludeLangs);
  // A la bonne position, chez le bon hote, ET dans le panneau qui le porte
  // vraiment — cf. pickLangDirForHost.
  const hit = await pickLangDirForHost(slug, seasonDir, tryLangs, serverDef, index);
  if (!hit) return { panelOk: false, iframeUrl: null };
  return { panelOk: true, iframeUrl: hit.url, langDir: hit.langDir };
}

async function getAnimeSamaIframe(serverKey, title, episode, aniId) {
  try {
    const serverDef = ANIMESAMA_SERVERS[serverKey];
    if (!serverDef) return null;

    const langPath = serverDef.lang === "vostfr" ? "vostfr" : "vf";
    const episodeIndex = Number(episode) - 1;

    // ── player_map: the persistent, verified resolution layer ──────────────
    // verified/heuristic rows let us skip every guessing step; absent/broken
    // rows let us skip the source entirely instead of re-probing (and possibly
    // re-guessing WRONG) on every cold start.
    const nowS = Math.floor(Date.now() / 1000);
    const mapRow = await getPlayerMapEntry(aniId, "animesama", langPath);
    if (
      mapRow &&
      (mapRow.status === "absent" || mapRow.status === "broken") &&
      mapRow.expiresAt > nowS
    ) {
      dlog(`[anime-sama] player_map says ${mapRow.status} for ${aniId}/${langPath} — skipping`);
      return null;
    }

    let iframeUrl = null;
    let resolvedViaMap = false;

    // COHERENCE GUARD — drop a mapped panel whose season contradicts the
    // resolver. anime-sama encodes the season in the panel dir (saison2 = S2,
    // saison1/null = S1). A season-1 entry mapped to seasonDir=saison2 (written
    // back while season resolution was on a poisoned Redis) would serve S2's
    // episode 1 forever, since this fast-path is taken before any re-resolution.
    // Cross-check against detectSeasonNumber and demote the row on mismatch so
    // the heuristic path re-derives the correct panel. Films/OAV dirs (non
    // "saisonN") are exempt — their "season" isn't a number.
    let mapPanelCoherent = true;
    // A hors-série / recap panel is never the answer to an episode request, and
    // the numeric check below CANNOT catch it: `/saison\s*(\d+)/` reads
    // "saison1hs" as season 1, exactly like "saison1", so the row looked
    // coherent and the fast path served an 11:40 recap for Bungou Stray Dogs
    // S1 ep1. The heuristic path has always excluded these panels
    // (`isSideStory`); this path simply never did.
    if (
      mapRow?.seasonDir &&
      isSideStoryDir(mapRow.seasonDir, null) &&
      !(mapRow.note || "").includes(HS_BY_YEAR)
    ) {
      dlog(`[anime-sama] player_map ${mapRow.seasonDir} is a side-story panel — ignoring poisoned row`);
      flagPlayerMap(aniId, "animesama", langPath, `side-story dir: ${mapRow.seasonDir}`).catch(() => {});
      mapPanelCoherent = false;
    } else if (mapRow?.seasonDir && /^saison/i.test(mapRow.seasonDir)) {
      const dirSeason = Number((mapRow.seasonDir.match(/saison\s*(\d+)/i) || [])[1] || 1);
      const expectedSeason = await detectSeasonNumber(aniId);
      if (dirSeason !== expectedSeason) {
        dlog(`[anime-sama] player_map ${mapRow.seasonDir} implies S${dirSeason} but resolver says S${expectedSeason} — ignoring poisoned row`);
        flagPlayerMap(aniId, "animesama", langPath, `season mismatch: ${mapRow.seasonDir} vs resolver S${expectedSeason}`).catch(() => {});
        mapPanelCoherent = false;
      }
    }

    /* Un upload mort dans un panneau ne veut pas dire que l'hote n'a pas
       l'episode : anime-sama garde plusieurs pistes de doublage (vf, vf1, vf2),
       et la piste vivante n'est pas forcement la premiere. Mesure du 17/08/2026,
       One Piece VF : `saison1/vf` porte un ansembed 404 et `saison1/vf2` le meme
       hote bien vivant.

       On ne paie donc RIEN dans le cas courant — le premier candidat est servi
       tel quel — et on ne relance la resolution que lorsqu'il s'avere mort, en
       excluant le repertoire deja tente. Borne par le nombre de pistes, donc au
       pire quatre tours. Les fetchs de catalogue/saison sont memoises, seuls les
       episodes.js des pistes suivantes sont vraiment redemandes. */
    const excludeLangs = new Set();
    const MAX_LANG_ATTEMPTS = 4;

    for (let attempt = 0; attempt < MAX_LANG_ATTEMPTS; attempt++) {
      let langDir = null;
      iframeUrl = null;

      if (
        mapPanelCoherent &&
        mapRow?.slug &&
        mapRow?.seasonDir &&
        (mapRow.status === "verified" || mapRow.status === "heuristic")
      ) {
        const fast = await fetchPanelIframe(
          mapRow.slug,
          mapRow.seasonDir,
          langPath,
          serverDef,
          episodeIndex + (mapRow.epOffset || 0),
          excludeLangs,
        );
        if (fast.panelOk) {
          resolvedViaMap = true;
          iframeUrl = fast.iframeUrl;
          langDir = fast.langDir;
          dlog(`[anime-sama] player_map hit: ${mapRow.slug}/${mapRow.seasonDir} (+${mapRow.epOffset || 0}) → ${iframeUrl ? "found" : "host/ep absent"}`);
          if (!iframeUrl) return null; // authoritative miss — heuristics would agree
        } else if (attempt === 0) {
          // The mapped panel is gone (source restructured). Record the failure —
          // three strikes demote verified→broken — and re-derive from scratch.
          flagPlayerMap(aniId, "animesama", langPath, "mapped panel unreachable");
          dlog(`[anime-sama] player_map row stale for ${aniId}/${langPath} — falling back to heuristics`);
        }
      }

      if (!iframeUrl) {
        const found = await resolveAnimeSamaHeuristically(
          serverKey, serverDef, title, episode, episodeIndex, aniId, langPath, mapRow,
          excludeLangs,
        );
        iframeUrl = found?.url || null;
        langDir = found?.langDir || null;
      }
      if (!iframeUrl) return null;

      const finalized = await finalizeAnimeSamaIframe(serverKey, serverDef, iframeUrl);
      if (finalized) return finalized;

      // Candidat mort. Sans repertoire identifie on ne saurait pas quoi
      // exclure et on rejouerait le meme a l'infini : on s'arrete.
      if (!langDir) return null;
      excludeLangs.add(langDir);
      dlog(`[anime-sama] ${serverKey}: ${langDir} mort — on tente la piste suivante`);
    }
    return null;
  } catch (error) {
    console.error(`[anime-sama] ${serverKey} failed:`, error.message);
    // A THROWN error is never a clean "no source" — genuine absence always
    // returns null above. A network/worker/parse throw is transient, so
    // propagate it as retryable rather than swallowing it into a 6h absence.
    throw error instanceof TransientSourceError
      ? error
      : new TransientSourceError(error.message);
  }
}

/**
 * The original guess-everything resolution pipeline (slug search → season
 * detection → panel scoring → merged-offset). Runs only on a player_map miss;
 * on success it WRITES BACK what it learned as a `heuristic` row so the next
 * request (and the verifier) start from this answer instead of re-deriving it.
 */
async function resolveAnimeSamaHeuristically(
  serverKey, serverDef, title, episode, episodeIndex, aniId, langPath, mapRow,
  excludeLangs,
) {
  {
    // Repertoire de langue d'ou vient l'URL retenue. Remonte a l'appelant pour
    // qu'un upload mort puisse le faire exclure a la tentative suivante.
    let usedLangDir = null;
    // Seed the slug when the map knows it but lacks a usable season dir —
    // still skips the expensive catalogue search.
    const knownSlug =
      mapRow?.slug && (mapRow.status === "verified" || mapRow.status === "heuristic")
        ? mapRow.slug
        : null;

    // 1. Detect which season this AniList ID represents
    const seasonNum = await detectSeasonNumber(aniId);
    dlog(`[anime-sama] AniList ${aniId} â†’ detected season ${seasonNum}`);

    // 2. Search anime-sama â€” use romaji title first, then try french
    const slug = knownSlug || (await findAnimeSamaSlug(title, aniId));
    if (!slug) {
      console.error(`[anime-sama] ${serverKey} aniId=${aniId} title="${title}" slug NOT FOUND`);
      return null;
    }
    dlog(`[anime-sama] Found slug: ${slug} (${langPath})`);

    // 3. Try to find the right season/episode
    // Fetch the anime detail page to get season list (routed via worker —
    // anime-sama.to 403s direct Vercel fetches).
    const detailRes = await fetchViaWorker(`${ANIMESAMA_BASE}/catalogue/${slug}/`);
    if (!detailRes.ok) {
      console.error(`[anime-sama] ${serverKey} detail page ${detailRes.status} for slug=${slug}`);
      // The slug resolved (the anime EXISTS on anime-sama) but its catalogue
      // page is momentarily unreachable via the worker — a TRANSIENT upstream
      // failure, not "this episode has no source". Signal retry so the chip
      // isn't frozen absent for 6h on a worker hiccup.
      throw new TransientSourceError(`anime-sama detail page ${detailRes.status} for ${slug}`);
    }
    const detailHtml = await detailRes.text();

    // Extract panneauAnime() calls to find available seasons
    const seasonMatches = [...detailHtml.matchAll(/panneauAnime\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)];
    dlog(`[anime-sama] Found ${seasonMatches.length} seasons`);

    // Build season list from panneauAnime calls â€” use sequential ordinals (1,2,3,4...)
    // NOT the season number from the path (since "saison3-2" is a separate entry from "saison3").
    // Also extract any 4-digit year from the label (e.g. "Version 2011" â†’ 2011) so we can
    // match against AniList's seasonYear/startDate when multiple versions exist.
    const seasons = seasonMatches
      .map((m) => {
        const path = m[2]; // e.g. "saison1/vostfr", "saison3-2/vostfr", "film/vostfr"
        // Accept saisonN dirs AND non-season content dirs (film/oav/special/
        // scan). Films are stored as panneauAnime("Film","film/vostfr") with
        // NO "saison" prefix — the old saison-only regex dropped them, so movie
        // entries never resolved a player. We keep them as season-like slots
        // (ordinal-numbered) so a MOVIE AniList id maps onto the film panel.
        const dirMatch = path.match(/^(saison[^/]+|film[^/]*|oav[^/]*|special[^/]*|scan[^/]*)\//i);
        if (!dirMatch) return null;
        const yearMatch = m[1].match(/\b(19|20)\d{2}\b/);
        return {
          label: m[1],
          dir: dirMatch[1],
          path: m[2],
          year: yearMatch ? parseInt(yearMatch[0], 10) : null,
          isFilm: /^film/i.test(dirMatch[1]),
        };
      })
      .filter(Boolean)
      .map((s, i) => ({ ...s, ordinal: i + 1 }));

    if (seasons.length === 0) {
      seasons.push({ label: "Saison 1", ordinal: 1, dir: "saison1", path: `saison1/${langPath}` });
    }

    // Shared AniList metadata (cached) — reused for movie detection, year and
    // title matching below.
    const meta = await getMediaMeta(aniId);

    // Movies: when AniList says this is a MOVIE and a film panel exists, target
    // it directly — season ordinals don't apply (a film isn't "season N").
    const isMovie = meta?.format === "MOVIE";
    const filmSeason = seasons.find((s) => s.isFilm);

    dlog(`[anime-sama] Seasons: ${seasons.map((s) => `${s.ordinal}=${s.dir}${s.year ? `(${s.year})` : ""}`).join(", ")}`);

    // 3.5. YEAR MATCHING â€” if multiple seasons have explicit years and AniList
    // gave us a year, prefer the season whose year matches. Solves the HxH
    // 1999-vs-2011 case where they share the same slug.
    const aniYear = meta?.seasonYear || meta?.startDate?.year || null;
    let yearMatchedSeason = null;
    if (aniYear) {
      yearMatchedSeason = seasons.find((s) => s.year === aniYear);
      if (yearMatchedSeason) {
        dlog(`[anime-sama] Year match: AniList ${aniYear} â†’ ${yearMatchedSeason.dir}`);
      }
    }

    // 3.6. SEASON SCORING — pick the panneau that best matches this AniList
    // entry. `detectSeasonNumber` is now reliable (title-anchored +
    // continuation-aware), so the panel whose "Saison N" label equals it is the
    // PRIMARY signal; title token-overlap breaks ties (Baki/HxH same-slug eras).
    const aniTitles = [
      meta?.title?.romaji,
      meta?.title?.english,
      ...(meta?.synonyms || []),
    ].filter(Boolean);
    const titleMatchedSeason = pickAnimeSamaSeason(seasons, aniTitles, seasonNum);

    // 4. If we detected a specific season from AniList, go directly to it
    let iframeUrl = null;

    // Priority: MOVIE → film panel > explicit year match (same-slug remakes like
    // HxH 1999/2011) > scored season match (label==seasonNum, then title overlap)
    // > raw ordinal. The scored match folds in the old "title match" + the
    // reliable seasonNum, so an unnumbered later season ("Final Season") lands on
    // its real panel instead of falling back to saison1.
    const directTarget = (isMovie && filmSeason) ||
      yearMatchedSeason ||
      titleMatchedSeason ||
      (seasonNum > 1 ? seasons.find((s) => s.ordinal === seasonNum) : null);

    if (directTarget) {
      const targetSeason = directTarget;
      // Films are often single-language (e.g. only "film/vostfr"). For a film
      // panel use the language baked into its own panneau path rather than the
      // requested langPath, so a VF request for a VOSTFR-only film still
      // resolves instead of 404ing on a non-existent "film/vf".
      // Language dirs to try, in order. Films often carry their own single
      // language in the panneau path; otherwise a VF request also tries the
      // numbered dub tracks (vf1/vf2) some series use.
      const targetLangs = (
        targetSeason.isFilm
          ? [targetSeason.path.split("/")[1] || langPath]
          : animeSamaLangDirs(langPath, excludeLangs)
      ).filter((d) => !excludeLangs?.has(d));
      // On choisit le repertoire qui porte l'hote, pas le premier qui repond :
      // un panneau `vf` peut exister avec un upload mort pendant que `vf2` a le
      // bon (cf. pickLangDirForHost).
      const hit = await pickLangDirForHost(
        slug, targetSeason.dir, targetLangs, serverDef, episodeIndex,
      );
      const usedLang = hit?.langDir || targetLangs[0];
      dlog(`[anime-sama] Direct season ${targetSeason.dir}/${usedLang} (${yearMatchedSeason ? `year ${aniYear}` : `ordinal ${seasonNum}`})`);

      if (hit) {
        const episodeArrays = hit.episodeArrays;
        if (episodeArrays.length > 0) {
          // MERGED-PANEL OFFSET: some franchises are stored as ONE saison1 panel
          // that concatenates every season's episodes (Gintama 365ep, Fairy Tail
          // 328ep, DBZ Kai 291ep…). For a season ≥2 that means episode 1 lives at
          // the merged index `offset+0`, not 0 — without this we'd serve S1 ep1
          // when the user asked for S2 ep1. We only offset when we're confident
          // the panel really is a merged concatenation:
          //   • this is season ≥2 (S1 needs no offset),
          //   • the panel holds clearly MORE episodes than this entry alone
          //     (canonical ≥ ownEps + a few), so it isn't a normal single season,
          //   • the computed offset lands the requested episode inside the panel.
          // The offset itself is the summed episode counts of the prequel chain
          // (computeSeasonStartOffset). If any of these don't hold we fall back
          // to the plain index — never worse than before.
          const canonicalLen = Math.max(...episodeArrays.map((a) => a.length));
          const ownEps = Number(meta?.episodes) || 0;
          let useIndex = episodeIndex;
          const looksMerged =
            seasonNum > 1 &&
            ownEps > 0 &&
            canonicalLen >= ownEps + episodeIndex + 1 &&
            canonicalLen > ownEps + 2;
          if (looksMerged) {
            const offset = await resolveMergedOffset(aniId, episodeIndex, canonicalLen, ownEps);
            if (offset > 0) {
              useIndex = episodeIndex + offset;
              dlog(`[anime-sama] Merged panel ${targetSeason.dir}: S${seasonNum} ep${episode} → merged index ${useIndex} (offset ${offset}, panel ${canonicalLen}ep)`);
            }
          }
          const pickedUrl = pickPreferredEpisodeUrl(
            episodeArrays,
            serverDef.preferred,
            useIndex,
          );
          if (pickedUrl) {
            iframeUrl = pickedUrl;
            dlog(`[anime-sama] Found ep ${episode} in ${targetSeason.dir}: ${iframeUrl}`);
            // WRITE-BACK: persist what we just derived (slug + panel + offset)
            // so the next request takes the fast-path and the verifier can
            // promote it. Guarded so an unchanged mapping isn't rewritten on
            // every episode click (Turso write budget).
            if (!mapRow || mapRow.slug !== slug || mapRow.seasonDir !== targetSeason.dir) {
              upsertPlayerMap({
                aniId,
                source: "animesama",
                lang: langPath,
                status: "heuristic",
                slug,
                seasonDir: targetSeason.dir,
                epOffset: useIndex - episodeIndex,
                episodeCount: canonicalLen,
                animeStatus: meta?.status ?? null,
                // Stamp the one case where a `saison*hs` panel is legitimate —
                // see HS_BY_YEAR. Without it the row we are writing here would
                // be rejected as poisoned on the very next request.
                note:
                  targetSeason === yearMatchedSeason && isSideStoryDir(targetSeason.dir, null)
                    ? `runtime resolution (${HS_BY_YEAR} ${aniYear})`
                    : "runtime resolution",
              }).catch(() => {});
            }
          }
        }
      } else {
        console.error(`[anime-sama] ${serverKey} no episodes.js for ${slug}/${targetSeason.dir} in ${targetLangs.join("/")}`);
      }
      // Le repertoire retenu est celui qui portait l'hote : il doit remonter a
      // l'appelant pour qu'un upload mort puisse le faire exclure au tour
      // suivant, sinon la relance retomberait indefiniment sur le meme panneau.
      if (iframeUrl) usedLangDir = usedLang;
    }

    // 5. Fallback: cumulative season iteration (only if year/PREQUEL didn't match)
    // KEY: episode count comes from the canonical (first) array, not the host-specific one.
    // Otherwise, when the requested host isn't in season N, we'd skip ahead and incorrectly
    // return episode 1 of a later season (e.g. One Piece OneUpload â†’ saison9 ep 1).
    //
    // SAFETY: if we already had an explicit year/title match for the season
    // but the requested host wasn't available there, do NOT fall through to
    // the cumulative search â€” iterating other seasons of the SAME slug can
    // accidentally jump into a different era's panneau (e.g. Hunter x Hunter:
    // the 2011 slug has its own saisons, and if Sibnet is missing on saison1
    // the old code would happily walk into a "Films" or "OAV" panneau of the
    // 1999 series under the same slug). Better to return null and let the UI
    // mark this server as unavailable than to serve the wrong content.
    if (!iframeUrl && !directTarget) {
      let cumulativeEps = 0;
      for (const season of seasons) {
        // Same VF track fallback (vf → vf1/vf2) as the direct path, et le meme
        // choix : le repertoire qui PORTE l'hote, pas le premier qui repond.
        const hit = await pickLangDirForHost(
          slug,
          season.dir,
          animeSamaLangDirs(langPath, excludeLangs),
          serverDef,
          episodeIndex - cumulativeEps,
        );
        if (!hit) {
          dlog(`[anime-sama] No ${langPath.toUpperCase()} for ${season.dir}`);
          continue;
        }

        const episodeArrays = hit.episodeArrays;
        if (episodeArrays.length === 0) continue;

        // Canonical episode count = max length across all host arrays in this season.
        // This keeps cumulative numbering correct regardless of host availability.
        const canonicalCount = Math.max(...episodeArrays.map((a) => a.length));
        const localIndex = episodeIndex - cumulativeEps;

        if (localIndex >= 0 && localIndex < canonicalCount) {
          // This is the right season for the requested episode.
          // Now check if the requested host is available in THIS season.
          const localUrl = pickPreferredEpisodeUrl(
            episodeArrays,
            serverDef.preferred,
            localIndex,
          );
          if (localUrl) {
            iframeUrl = localUrl;
            usedLangDir = hit.langDir;
            dlog(`[anime-sama] Found ep ${episode} in ${season.dir}/${hit.langDir}: ${iframeUrl}`);
            // SLUG-ONLY write-back: cumulative numbering spans multiple panels,
            // so a single season_dir+offset row can't represent it — but the
            // slug alone still spares the next request the catalogue search.
            if (!mapRow || mapRow.slug !== slug) {
              upsertPlayerMap({
                aniId,
                source: "animesama",
                lang: langPath,
                status: "heuristic",
                slug,
                seasonDir: null,
                epOffset: 0,
                episodeCount: null,
                animeStatus: meta?.status ?? null,
                note: "runtime resolution (cumulative panels)",
              }).catch(() => {});
            }
          } else {
            dlog(`[anime-sama] ${season.dir} has ep ${episode} but not on ${serverDef.preferred[0] || serverDef.preferred}`);
          }
          break; // Right season found; don't keep looking
        }
        cumulativeEps += canonicalCount;
      }
    }

    if (!iframeUrl) {
      console.error(`[anime-sama] ${serverKey} no iframe for ep=${episode} slug=${slug} (seasons=${seasons.length})`);
      return null;
    }
    return { url: iframeUrl, langDir: usedLangDir };
  }
}

/**
 * Shared post-resolution step: per-host rewrites + server-side extraction.
 * Runs on the iframe URL whether it came from the player_map fast-path or the
 * heuristic pipeline.
 */
async function finalizeAnimeSamaIframe(serverKey, serverDef, iframeUrl) {
  try {
    // Per-host iframe rewriting before extraction.
    // - vidmoly.to currently 302s to a HTTP survey scam. extractVidmoly
    //   iterates the .net/.to/.biz triple itself, so we just pick a safe
    //   variant here for the extraction entry point.
    if (/vidmoly\.to/i.test(iframeUrl)) {
      iframeUrl = iframeUrl.replace(/vidmoly\.to/i, "vidmoly.net");
    }

    // Server-side extraction. Preferred path → Universal Player (custom
    // chrome, subs, skip overlay, ambient lights). When the extractor fails
    // OR the host isn't extractable, hand back the raw iframe with
    // `degraded: true`. The chip stays visible (red in the selector) so
    // the user can still click to try the host's own player — better than
    // hiding it on a guess, even when the embed slug might be dead.
    // EXCEPTION: Sibnet AND Sendvid send X-Frame-Options DENY on the embed
    // page, so an iframe fallback for them just produces "refused to connect".
    // Keep hiding those (return null below instead of a degraded iframe).
    const lower = iframeUrl.toLowerCase();

    // Vidmoly bypasses server-side extraction entirely: the master.m3u8 token
    // is IP-bound, and routing it through any proxy (CF Worker, Fly, Vercel
    // FOT) costs bandwidth and a guaranteed IP-mismatch the moment one tier
    // 410s. Instead we hand the client the embed URL and let it fetch the
    // page itself — token then binds to the user's IP and segments stream
    // directly from the vidmoly CDN with no proxy. vidmoly.biz reflects any
    // Origin in Access-Control-Allow-Origin (verified), so the browser fetch
    // succeeds. If client extraction fails (CORS on the CDN, no source in
    // HTML, etc.), UniversalPlayer falls back to the iframe.
    // VIDMOLY_HOST_RE, not `includes("vidmoly")`: ansembed.net is the same
    // backend with the same IP-bound token, so it needs the same
    // browser-side extraction. Matching on the literal string sent it to the
    // server-side extractor instead, which either failed (→ raw JW iframe) or
    // "succeeded" with a token bound to our IP that 410s on every segment.
    if (VIDMOLY_HOST_RE.test(lower)) {
      // Aniwsama tends to keep dead vidmoly slugs in its catalogue for weeks
      // after the file is deleted. Probe before serving the chip so a dead
      // slug yields "server unavailable" instead of vidmoly's own 404 page.
      if (!(await isVidmolyEmbedAlive(iframeUrl))) {
        dlog(`[anime-sama] vidmoly slug 404 — hiding chip: ${iframeUrl}`);
        return null;
      }
      return {
        clientExtract: { type: "vidmoly", embedUrl: iframeUrl },
        iframe: iframeUrl,
      };
    }

    if (EXTRACTABLE_HOSTS.some((h) => lower.includes(h))) {
      if (lower.includes("sibnet")) {
        dlog(`[sibnet-trace] ${serverKey} iframeUrl=${iframeUrl}`);
      }
      const extractor = getExtractor(iframeUrl);
      const result = await extractor(iframeUrl);
      if (lower.includes("sibnet")) {
        const out = result.streams?.[0]?.url || `ERROR:${result.error}`;
        dlog(`[sibnet-trace] ${serverKey} resolved → ${out}`);
      }
      if (result.streams?.length) {
        dlog(`[anime-sama] Extracted stream for ${serverKey}: ${result.streams[0].url}`);
        return result;
      }
      dlog(`[anime-sama] Extraction failed for ${serverKey}: ${result.error}`);
      /* An extractor that never reached the embed knows NOTHING about this
         episode, so it must not be allowed to publish an absence. Returning
         null below is a claim ("no source here") that the client caches for 6h;
         a transport refusal is not evidence for that claim, it is the absence
         of evidence. Throwing hands the handler a 503 → the chip reads `retry`,
         and the next visitor asks again instead of inheriting our bad luck.
         This is the same contract the catalogue/detail-page fetches already
         follow — see TransientSourceError at the top of this file. */
      if (result.transient) {
        throw new TransientSourceError(
          `${serverKey}: ${result.error || "embed unreachable"}`,
          { hostDown: !!result.hostDown },
        );
      }
      // Sibnet + Sendvid X-Frame-Options DENY → an iframe fallback is a dead
      // "refused to connect" page, so hide the chip instead of degrading it.
      // uqload: same outcome for a different reason — its embed is Referer-gated
      // to anime-sama, so a raw iframe here renders "embed restricted", not the
      // player. Hide it too rather than serve a dead chip.
      if (lower.includes("sibnet") || lower.includes("sendvid") || lower.includes("uqload")) return null;
    }
    return { iframe: iframeUrl, degraded: true, reason: "extraction failed" };
  } catch (e) {
    // Rethrow, don't swallow: this catch turns any throw into "no source", which
    // would undo the transient classification a few lines up the moment it was
    // made. Only genuinely unknown errors become an absence.
    if (e instanceof TransientSourceError) throw e;
    console.error(`anime-sama ${serverKey} error:`, e.message);
    return null;
  }
}

/**
 * Detect which season number an AniList ID represents by walking the PREQUEL chain.
 * Uses the shared Media cache â€” a single AniList fetch covers title, synonyms,
 * AND relations, so we don't need separate calls for each scraper helper.
 *
 * We accept TV, ONA, OVA and TV_SHORT prequels because anime-sama / voir-anime
 * list those alongside main TV seasons (e.g. Baki Hanma is `format=ONA` on
 * AniList â€” filtering to TV-only would walk the chain wrong and return season=1
 * for a 4th-entry anime, dropping the user on the wrong show entirely).
 *
 * MOVIE / SPECIAL / MUSIC are still excluded â€” those don't increment the
 * "season" counter on either site (films get their own slug or `film/` path).
 */
const PREQUEL_FORMATS = new Set(["TV", "ONA", "OVA", "TV_SHORT"]);

/**
 * Does `prequel` look like an actual PREVIOUS SEASON of `current`, rather than
 * an unrelated spin-off AniList happens to tag as a prequel?
 *
 * AniList's PREQUEL edges aren't all "season N-1": One Piece (id 21) lists the
 * 1-episode ONA "MONSTERS: Ippaku Sanjou Hiryuu Jigoku" (an Oda one-shot) as a
 * prequel, so a blind walk returns season=2 and we'd serve every One Piece
 * episode from the wrong saga. A genuine previous season shares the franchise
 * title; a spin-off doesn't. We require a meaningful shared title token before
 * counting the edge.
 */
function looksLikePreviousSeason(currentTitles, prequelTitles) {
  for (const cur of currentTitles) {
    for (const prev of prequelTitles) {
      if (scoreSlugAgainstTitle(prev, cur) > 0) return true;
    }
  }
  return false;
}

// ── Robust season-number extraction from a title ─────────────────────────────
// Ported from components/anime/v2/helpers (extractSeasonFromTitle /
// isSeasonContinuation), which the score grid already uses to number split-cours
// franchises correctly. Counting PREQUEL hops alone is fragile: it BOTH
// over-counts (AoT "Final Season" walks S3Part2→S3→S2→S1 = 5, but it's S4) and
// under-counts (a title AniList didn't link, or whose only prequel edge is a
// spin-off, stops at 1). Reading the number straight out of the title is the
// reliable primary signal; the hop walk is the fallback.
const ROMAN_MAP = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const ORDINAL_WORDS_MAP = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
function parseRomanOrInt2(s) {
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  return ROMAN_MAP[String(s).toLowerCase()] || null;
}

/** Pull an explicit season number out of a title, or null. */
function seasonNumFromTitle(media) {
  const candidates = [media?.title?.english, media?.title?.romaji, media?.title?.native]
    .filter(Boolean)
    .map((s) => String(s).trim());
  for (const t of candidates) {
    let m = t.match(/\bSeason\s+(\d+|[IVX]+)\b/i);
    if (m) { const n = parseRomanOrInt2(m[1]); if (n) return n; }
    m = t.match(/\b(\d+)(?:st|nd|rd|th)\s+Season\b/i);
    if (m) return Number(m[1]);
    m = t.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+Season\b/i);
    if (m) { const n = ORDINAL_WORDS_MAP[m[1].toLowerCase()]; if (n) return n; }
    m = t.match(/(?:第)?\s*(\d+)\s*期/); // Japanese "2期"
    if (m) return Number(m[1]);
    m = t.match(/(?:^|\s)S(\d+)(?:\s|$)/); // trailing "S2"
    if (m) return Number(m[1]);
    m = t.match(/\s([IVX]+)\s+(?:Part\s+\d+|Part\s+[IVX]+|[A-Z][a-z])/); // "IV Part 2" / "IV: Sub"
    if (m) { const n = parseRomanOrInt2(m[1]); if (n && n > 1) return n; }
    m = t.match(/\s([IVX]+):/);
    if (m) { const n = parseRomanOrInt2(m[1]); if (n && n > 1) return n; }
    m = t.match(/\s([IVX]+)$/i); // trailing roman, not a "Part" cour
    if (m && !/\bPart\s+[IVX]+$/i.test(t)) { const n = parseRomanOrInt2(m[1]); if (n && n > 1) return n; }
  }
  return null;
}

/** Does a title read like a CONTINUATION (Part 2 / Cour 2 / Final Chapters) of
 *  the previous season rather than a brand-new season? Such a hop must NOT add
 *  to the season count. */
function isSeasonContinuationTitle(media) {
  const candidates = [media?.title?.english, media?.title?.romaji, media?.title?.native]
    .filter(Boolean)
    .map((s) => String(s).trim());
  for (const t of candidates) {
    if (/\bPart\s+(?:[2-9]\d*|I{2,}|IV|VI*|IX|X)\b/i.test(t)) return true;
    if (/\bCour\s+(?:[2-9]\d*)\b/i.test(t)) return true;
    if (/\b(?:[2-9]\d*)(?:nd|rd|th)\s+Cour\b/i.test(t)) return true;
    if (/\bFinal\s+Chapter/i.test(t)) return true;
  }
  return false;
}

async function detectSeasonNumber(aniId, mediaOpts = {}) {
  const cacheKey = String(aniId);
  if (seasonCache.has(cacheKey)) return seasonCache.get(cacheKey);

  // PRIMARY — the EXACT season number the UI displays. resolveSeasonChain
  // reads the shared Turso cache (seasonChain:v5) first and only computes+
  // caches on a miss, so the player and the page header are the same value BY
  // CONSTRUCTION. This is the coherence that matters: whatever the header
  // says, the video targets the same season. Calling resolveSeasonNumber
  // directly here (as before) recomputed LIVE on every source request, and any
  // transient metadata failure produced a different number than the UI —
  // which the coherence guards then trusted, killing correct player_map rows.
  try {
    const chain = await resolveSeasonChain(Number(aniId));
    if (chain && chain.number != null) {
      seasonCache.set(cacheKey, chain.number);
      return chain.number;
    }
  } catch {
    /* chain resolver unavailable → try the live resolver below */
  }

  // SECONDARY — the multi-signal resolver, live (no shared cache). Only trust
  // a confident answer; a `low`/`null` result falls through to the legacy
  // title+walk heuristics below, which are tuned for anime-sama's naming.
  try {
    const r = await resolveSeasonNumber(Number(aniId));
    if (r && r.number != null && r.confidence !== "low") {
      seasonCache.set(cacheKey, r.number);
      return r.number;
    }
  } catch {
    /* resolver unavailable → fall back to the local heuristics */
  }

  let currentId = Number(aniId);
  const visited = new Set();
  const titlesOf = (m) =>
    [m?.title?.romaji, m?.title?.english, m?.title?.native].filter(Boolean);

  // SIGNAL 1 — the start entry's own title. If it spells out a season number
  // ("… Season 2", "2nd Season", "2期", "S2"), trust it: it's exact and immune
  // to chain quirks. This alone fixes the under-count cases where the PREQUEL
  // edges are missing or only point at spin-offs.
  const startMedia = await getMediaMeta(currentId, mediaOpts);
  const titleSeason = startMedia ? seasonNumFromTitle(startMedia) : null;

  // SIGNAL 2 — walk the PREQUEL chain, counting CONTINUATION-AWARE: each hop to
  // a genuine previous season adds 1, but a "Part 2" / "Final Chapters" node
  // shares its Part-1 season, so crossing it adds 0. `distinct` is the number of
  // distinct seasons strictly BEFORE the start entry → start season = distinct+1.
  // This fixes the over-count (AoT Final Season no longer counts each Part hop).
  // If an ANCESTOR spells out its own season number, anchor on it: the start is
  // that number plus the distinct seasons we crossed after it.
  let distinct = 0;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const media = currentId === Number(aniId) ? startMedia : await getMediaMeta(currentId, mediaOpts);
    if (!media) break;
    // An explicit number on an ANCESTOR anchors the whole count and ends the walk.
    if (currentId !== Number(aniId)) {
      const explicit = seasonNumFromTitle(media);
      if (explicit != null) {
        // This ancestor IS `explicit`; the start sits `distinct` seasons later.
        distinct += explicit - 1;
        break;
      }
    }
    const edges = media.relations?.edges || [];
    const prequel = edges.find(
      (e) => e.relationType === "PREQUEL" && PREQUEL_FORMATS.has(e.node?.format)
    );
    // YEAR GUARD — a real previous season aired BEFORE the current node. AniList
    // frequently mis-tags a later side-OVA as a PREQUEL (SnK S1 (2013) has a
    // PREQUEL edge to "Kuinaki Sentaku" OVA (2014); Slime → Coleus OVA; …).
    // Without this the walk crosses that OVA and over-counts, turning S1 into S2
    // — which then poisons player_map with a season-2 slug/panel. resolveSeason's
    // hardened walk already applies edgeYearMonotonic; the legacy fallback here
    // did not, so a low-confidence/failing resolver dropped us into a wrong count.
    const yr = (x) => x?.seasonYear || x?.startDate?.year || null;
    const curYr = yr(media);
    const preYr = yr(prequel?.node);
    const yearOk = !(curYr && preYr && preYr > curYr); // reject a "prequel" that airs later
    if (
      prequel &&
      yearOk &&
      looksLikePreviousSeason(titlesOf(media), titlesOf(prequel.node))
    ) {
      // Crossing INTO the prequel: the CURRENT node being a "Part 2" means it
      // shares the prequel's season, so this hop adds no new distinct season.
      if (!isSeasonContinuationTitle(media)) distinct++;
      currentId = prequel.node.id;
    } else {
      break;
    }
  }
  const walkSeason = distinct + 1;

  // An EXPLICIT number in the start title is authoritative: "2nd Season" means
  // S2 no matter how many OVA/Part bridges the PREQUEL walk crosses. Taking the
  // max would let the walk's over-count win (Slime "2nd Season" walks through a
  // Coleus OVA + Part split → 3, dragging S2 to S3 and missing the -2- slug).
  // So trust the title number when it's there; fall back to the walk only when
  // the title carries no number at all.
  const season = titleSeason != null ? titleSeason : walkSeason;

  seasonCache.set(cacheKey, season);
  return season;
}

// Cache of computed prequel season-size lists (id → ordered episode counts).
const seasonSizesCache = new Map();

/**
 * Ordered episode counts of the seasons BEFORE this AniList entry in its
 * franchise, FARTHEST-first (i.e. [S1, S2, …, S(n-1)] for an entry that is
 * season n). Walks the SAME continuation-aware PREQUEL chain as
 * detectSeasonNumber; a "Part 2" continuation still contributes its own episodes
 * (they ARE earlier episodes in a merged list).
 *
 * Returns `{ sizes, complete }`:
 *   • sizes    — the ordered counts (may be empty for a first season),
 *   • complete — true only if EVERY prequel had a known episode count. When a
 *     count is missing we can't trust offset arithmetic, so callers must not
 *     offset (complete=false). We still return the partial list for diagnostics.
 *
 * Why a LIST and not a single sum: an anime-sama panel doesn't always start at
 * the franchise root. `tokyo-ghoul-re`'s saison1 holds only :re + :re 2 (24 ep),
 * not the original Tokyo Ghoul. The caller anchors this list against the real
 * panel length to find where the panel begins (see resolveMergedOffset), so the
 * offset is derived from the panel — not assumed to start at S1.
 */
async function computeSeasonSizes(aniId, mediaOpts = {}) {
  const cacheKey = String(aniId);
  if (seasonSizesCache.has(cacheKey)) return seasonSizesCache.get(cacheKey);

  const titlesOf = (m) =>
    [m?.title?.romaji, m?.title?.english, m?.title?.native].filter(Boolean);

  let currentId = Number(aniId);
  const visited = new Set();
  const sizesNearestFirst = [];
  let complete = true;

  // Walk strictly the prequels (we never count the start entry's own episodes).
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const media = await getMediaMeta(currentId, mediaOpts);
    if (!media) break;
    const edges = media.relations?.edges || [];
    const prequel = edges.find(
      (e) => e.relationType === "PREQUEL" && PREQUEL_FORMATS.has(e.node?.format),
    );
    if (!prequel || !looksLikePreviousSeason(titlesOf(media), titlesOf(prequel.node))) {
      break;
    }
    // Skip recap/digest prequels from the offset arithmetic: they inflate the
    // prequel episode sum without occupying slots in the merged panel, which
    // pushes the computed offset past the real S(n) start and serves the wrong
    // episode. We still walk THROUGH them (continue the chain) but don't count
    // their episodes.
    if (isRecapTitle(prequel.node)) {
      currentId = prequel.node.id;
      continue;
    }
    // Prefer the edge node's count (already fetched); fall back to a full meta
    // lookup if the edge omitted it.
    let prevEps = Number(prequel.node?.episodes);
    if (!Number.isFinite(prevEps) || prevEps <= 0) {
      const prevMeta = await getMediaMeta(prequel.node.id, mediaOpts);
      prevEps = Number(prevMeta?.episodes);
    }
    if (!Number.isFinite(prevEps) || prevEps <= 0) {
      complete = false; // unknown count → offset arithmetic can't be trusted
    }
    sizesNearestFirst.push(prevEps > 0 ? prevEps : 0);
    currentId = prequel.node.id;
  }

  const sizes = sizesNearestFirst.reverse(); // farthest-first: [S1, …, S(n-1)]
  const result = { sizes, complete };
  seasonSizesCache.set(cacheKey, result);
  return result;
}

/**
 * Resolve the merged-list offset for an entry against an ACTUAL panel of length
 * `panelLen`. Returns the offset to add to a 0-based episode index, or 0 to keep
 * the plain index.
 *
 * SAFE-FIRST: we only offset when it is mathematically CERTAIN that the panel is
 * the franchise concatenated from season 1. That is exactly when
 *
 *     sum(all prequel seasons)  +  this entry's own episodes  ==  panelLen
 *
 * (within ±1 for a single recap/ONA discrepancy). When that holds, the panel
 * provably starts at S1 and the offset is the full prequel sum — episode 1 of
 * this season lives at index `sum`.
 *
 * Why ONLY the full chain (not an arbitrary suffix): matching a *partial* suffix
 * by arithmetic coincidence is dangerous. tokyo-ghoul-re's panel is 24 ep (=:re
 * + :re 2), and a suffix match would think :re sits AFTER √A and serve √A's
 * episodes. Its full chain (MONSTERS + Tokyo Ghoul + √A = 25) + own 12 = 37 ≠ 24,
 * so the strict test rejects it and we keep the safe plain index. Likewise
 * Gintama's AniList chain (201) + own ≠ the 365-ep panel, so it isn't offset
 * either. We'd rather leave a franchise-merge case unfixed than ever serve the
 * wrong episode.
 *
 * Any failure → 0 (caller uses the plain index, exactly as before). Centralised
 * so the live resolver and the audit stay in lock-step.
 */
async function resolveMergedOffset(aniId, episodeIndex, panelLen, ownEps, mediaOpts = {}) {
  if (!(ownEps > 0) || !(panelLen > 0)) return 0;
  const { sizes, complete } = await computeSeasonSizes(aniId, mediaOpts);
  if (!complete || sizes.length === 0) return 0; // unknown counts → don't risk it

  const fullChain = sizes.reduce((a, b) => a + b, 0);
  if (!(fullChain > 0)) return 0;
  // ANCHOR TEST: `fullChain` (the summed prequel seasons) is where THIS season
  // starts *iff* the panel is the franchise concatenated from S1. We accept the
  // anchor when the panel provably starts at S1 and this season's full window
  // fits inside it — WITHOUT requiring the panel to END at this season.
  //
  // Two shapes both mean "franchise merged from S1", and both are safe:
  //   • panel ENDS at this season   → panelLen ≈ fullChain + ownEps (the old
  //     exact test; Fairy Tail-style where AniList sums to the panel).
  //   • panel CONTINUES past this season → panelLen > fullChain + ownEps, because
  //     later seasons are concatenated after (Gintama: S1=201 in a 365-ep panel
  //     that also holds S2'/S3/S4). The old code rejected this as "too long" and
  //     collapsed S2 onto ep 1 — the bug this fixes.
  //
  // Safety, unchanged in spirit — we still refuse any offset we can't anchor:
  //   1. fullChain > panelLen           → chain doesn't fit before this season
  //                                        (tokyo-ghoul-re: chain 37 > panel 24).
  //   2. fullChain + ownEps > panelLen+S → this season's window runs off the end
  //                                        → the panel isn't the full franchise.
  //   3. panel barely longer than ownEps → not actually a merged panel (the
  //                                        prequels aren't in it) → don't offset.
  const RECAP_SLACK = 3;
  if (fullChain > panelLen) return 0;                                   // (1)
  if (fullChain + ownEps > panelLen + RECAP_SLACK) return 0;            // (2)
  if (panelLen < fullChain + Math.min(ownEps, 2)) return 0;            // (3)
  if (episodeIndex + fullChain >= panelLen) return 0; // would fall off the end
  return fullChain;
}

// Normalize a title for similarity scoring: lowercase, strip diacritics +
// punctuation, collapse whitespace. Yields a comparable token bag.
function normalizeForMatch(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// How well does a candidate slug (e.g. "baki", "baccano") match a target
// title? Measured as token overlap weighted by token length.
//   "baki" vs target "baki hanma"  â†’ 1 token match (baki, len 4) â†’ score 4
//   "baccano" vs target "baki hanma" â†’ 0 token match â†’ score 0
function scoreSlugAgainstTitle(slug, target) {
  const a = new Set(normalizeForMatch(slug.replace(/-/g, " ")).split(" ").filter(Boolean));
  const b = normalizeForMatch(target).split(" ").filter(Boolean);
  let score = 0;
  for (const tok of b) {
    if (a.has(tok)) score += tok.length;
  }
  return score;
}

// Stopwords (EN + FR + romaji particles) that carry no identifying signal, so a
// slug sharing ONLY these with a title is not a real match. Without this filter
// the token scorer let "my-name" win for "My-HiME" (shared "my") and
// "les-minions" for "Moomin" (shared "les") — serving a completely wrong anime.
const SLUG_STOPWORDS = new Set([
  "the", "les", "des", "une", "der", "die", "das", "and", "for", "you", "her",
  "his", "day", "new", "of", "my", "no", "to", "wa", "ga", "ni", "de", "la",
  "le", "wo", "san", "kun", "chan", "season", "part", "tv", "ova", "ona", "aux",
  "sur",
]);

// Significant (non-stopword, ≥3-char) tokens of a string, de-duped.
function significantTokens(s) {
  return [
    ...new Set(
      normalizeForMatch(s.replace(/-/g, " "))
        .split(" ")
        .filter((t) => t.length >= 3 && !SLUG_STOPWORDS.has(t)),
    ),
  ];
}

/**
 * Confidence (0..1) that `slug` actually denotes one of `titles`, based on how
 * much of the slug's SIGNIFICANT tokens overlap a title's significant tokens.
 *
 * 1.0 when the slug is an exact slugified form of any title (covers romaji/FR
 * official slugs like "shingeki-no-kyojin" for "Attack on Titan", whose tokens
 * fully cover the romaji synonym). Near 0 when the only shared words are
 * stopwords ("my-name" vs "My-HiME", "les-minions" vs "Moomin") → a wrong-anime
 * false positive. A slug made purely of stopwords/numbers (e.g. "no-6") returns
 * 1 so the caller's exact-match/length logic still governs it.
 */
function slugTitleConfidence(slug, titles) {
  const slugSig = significantTokens(slug);
  if (slugSig.length === 0) return 1; // numeric/stopword-only slug — not our call
  const slugLen = slugSig.reduce((a, t) => a + t.length, 0);
  let best = 0;
  for (const t of (titles || []).filter(Boolean)) {
    const ts = titleToSlug(t);
    if (ts === slug || ts.replace(/-/g, "") === slug.replace(/-/g, "")) return 1;
    const titleSig = new Set(significantTokens(t));
    if (titleSig.size === 0) continue;
    const matched = slugSig.filter((tok) => titleSig.has(tok)).reduce((a, tok) => a + tok.length, 0);
    const titleLen = significantTokens(t).reduce((a, tok) => a + tok.length, 0);
    const cov = matched / Math.min(slugLen, titleLen);
    if (cov > best) best = cov;
  }
  return best;
}

async function findAnimeSamaSlug(title, aniId, mediaOpts = {}) {
  const cacheKey = `${aniId}-${title}`;
  if (slugCache.has(cacheKey)) return slugCache.get(cacheKey);

  // Strip season suffixes to find the base anime on anime-sama
  const stripSeason = (t) =>
    t?.replace(/\s*(Season\s*\d+|\d+(st|nd|rd|th)\s*Season|Part\s*\d+|\d+æœŸ)\s*/gi, "").trim();

  // Try searching with the title directly, plus a stripped version
  const queries = [title];
  const stripped = stripSeason(title);
  if (stripped && stripped !== title) queries.push(stripped);

  // Reuse the shared AniList cache (no extra request when SSR already populated it)
  const media = await getMediaMeta(aniId, mediaOpts);
  if (media) {
    if (media.synonyms) queries.push(...media.synonyms);
    if (media.title?.english && !queries.includes(media.title.english))
      queries.push(media.title.english);
    if (media.title?.romaji && !queries.includes(media.title.romaji))
      queries.push(media.title.romaji);
    for (const t of [media.title?.english, media.title?.romaji]) {
      const s = stripSeason(t);
      if (s && !queries.includes(s)) queries.push(s);
    }
  }

  /*
   * Also search the FRANCHISE name — everything before the colon.
   *
   * anime-sama's catalogue search does not cope with a full subtitled title.
   * Measured 2026-08-10 on AniList 177699:
   *
   *   "Koukaku Kidoutai: THE GHOST IN THE SHELL"  (romaji)  → no results
   *   "THE GHOST IN THE SHELL"                    (english) → no results
   *   "Koukaku Kidoutai"                                    → ghost-in-the-shell
   *
   * Every query we had was one of the first two, so the slug came back null and
   * the title had no anime-sama player at all — while the catalogue carried it,
   * with four hosts. `stripSeason` doesn't help: this is a subtitle, not a
   * season marker. The 4-character floor keeps a stray prefix ("Re:", "K:")
   * from turning into a search for nothing in particular.
   */
  for (const q of [...queries]) {
    const head = q?.split(/\s*[:：]/)[0]?.trim();
    if (head && head.length >= 4 && head !== q && !queries.includes(head)) {
      queries.push(head);
    }
  }

  // Build the set of titles we'll score candidates against. We don't strip
  // here â€” we want "Hanma Baki" to match "baki" via token overlap, not via
  // string equality.
  const targets = [
    title,
    media?.title?.english,
    media?.title?.romaji,
    stripped,
    ...((media?.synonyms) || []),
  ].filter(Boolean);

  // Year hint from AniList (e.g. 2011 for Hunter x Hunter remake). Used
  // below as a *strong* tie-break so the "hunter-x-hunter-2011" slug wins
  // over the canonical "hunter-x-hunter" slug (1999) when both come back
  // from the search. Without this, the shorter-slug tie-breaker silently
  // picks the wrong era and we end up serving 1999 episodes for an
  // AniList ID that represents the 2011 remake.
  const aniYear =
    media?.seasonYear || media?.startDate?.year || null;

  // Score every candidate seen across all queries; return the best.
  // Anime-Sama no longer reliably tags "VF" in search results, so we ignore
  // language and rely on token-overlap scoring against the AniList titles.
  // Reject scores of 0 â€” those are unrelated catalogue entries (Baccano vs
  // Baki Hanma) that the search returned because of a fuzzy match on letters.
  const candidates = new Map(); // slug â†’ best score
  let anySearchOk = false; // did at least one query reach anime-sama and parse?
  for (const q of queries) {
    let searchRes;
    try {
      searchRes = await fetchViaWorker(
        `${ANIMESAMA_BASE}/catalogue/?search=${encodeURIComponent(q)}`,
      );
    } catch (e) {
      console.error(`[anime-sama] search "${q}" failed:`, e.message);
      continue;
    }
    if (!searchRes.ok) {
      console.error(`[anime-sama] search "${q}" HTTP ${searchRes.status}`);
      continue;
    }
    anySearchOk = true;
    const html = await searchRes.text();
    const $ = cheerio.load(html);

    $("a[href*='/catalogue/']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/\/catalogue\/([a-z0-9-]+)\/?$/);
      if (!m) return;
      const slug = m[1];
      // Best score for this slug against any of the AniList titles.
      let best = 0;
      for (const t of targets) {
        const s = scoreSlugAgainstTitle(slug, t);
        if (s > best) best = s;
      }
      if (best > (candidates.get(slug) || 0)) candidates.set(slug, best);
    });
  }

  // Pick the highest-scoring slug.
  //
  // Tie-break order (most specific â†’ least specific):
  //   1. Slug contains the AniList year (handles remakes like
  //      hunter-x-hunter vs hunter-x-hunter-2011 where the year-suffixed
  //      slug is a SEPARATE catalogue entry, not a panneau of the base).
  //   2. Slug contains any other 4-digit year that does NOT match â€”
  //      penalise it so we don't pick "-2011" when AniList year is 1999.
  //   3. Shortest slug wins (canonical entry: "baki" over
  //      "baki-hanma-special-fan-edit").
  const yearStr = aniYear ? String(aniYear) : null;
  const slugYearMatch = (slug) => {
    const m = slug.match(/-(\d{4})(?:-|$)/);
    if (!m) return null;
    return parseInt(m[1], 10);
  };

  let chosen = null;
  let chosenScore = -Infinity;
  for (const [slug, score] of candidates) {
    if (score === 0) continue;
    // CONFIDENCE FLOOR: reject a slug whose only overlap with every known title
    // is stopwords (confidence ≈ 0). Those are wrong-anime false positives —
    // the token scorer otherwise let "my-name" win for "My-HiME" or
    // "les-minions" for "Moomin". A genuine romaji/FR slug
    // ("shingeki-no-kyojin", "ken-le-survivant") always shares ≥1 significant
    // token, so this never rejects a real match. Slugs at low-but-nonzero
    // confidence are kept here and disambiguated downstream by the episode-count
    // check in the resolver.
    if (slugTitleConfidence(slug, targets) <= 0) continue;
    const slugYear = slugYearMatch(slug);
    // Composite score: token-overlap is the base, year alignment is a
    // strong boost / penalty so it dominates the tie-breaker.
    let composite = score;
    if (yearStr && slugYear === aniYear) composite += 100;
    else if (yearStr && slugYear && slugYear !== aniYear) composite -= 100;
    // Tie-break on slug length when composites are equal.
    if (
      composite > chosenScore ||
      (composite === chosenScore && chosen && slug.length < chosen.length)
    ) {
      chosen = slug;
      chosenScore = composite;
    }
  }

  // No slug AND not one search even reached anime-sama → the catalogue was
  // unreachable (worker/upstream down), not "this anime isn't on anime-sama".
  // Signal retry so the caller doesn't freeze the chip absent for 6h; and don't
  // cache the null (a transient miss must not stick).
  if (!chosen && !anySearchOk) {
    throw new TransientSourceError("anime-sama catalogue search unreachable");
  }

  slugCache.set(cacheKey, chosen);
  return chosen;
}

/**
 * Pick the anime-sama panneau (season) that best matches an AniList entry.
 *
 * Single scorer shared by the player and the audit so they always agree.
 * anime-sama lays panels out three different ways, and a robust pick has to
 * handle all three:
 *
 *   A. CLEANLY NUMBERED — "Saison 1", "Saison 2", … (Haikyuu, AoT). The
 *      detected seasonNum maps to the matching "Saison N" label. If seasonNum
 *      overshoots the panels available (AniList counts a later entry the site
 *      folded in — e.g. Haikyuu "TO THE TOP" is AniList S5 but the site's S4),
 *      we CLAMP to the highest numbered season so we never fall back to S1.
 *   B. NAME-LABELLED — one slug holds a whole franchise as panels named by
 *      sub-series ("Zero", "Stay Night", "Heaven's Feel" under `fate`). Here
 *      seasonNum is meaningless; title token-overlap against the label is the
 *      only signal, so "Fate/Zero" → the "Zero" panel.
 *   C. SINGLE SEASON-LIKE PANEL (a franchise entry that has its OWN slug, e.g.
 *      tokyo-ghoul-re) → handled by the caller (it falls to seasons[0]); we
 *      return null.
 *
 * No "bias toward saison 1 when unnumbered" — that bias is what made unnumbered
 * later seasons ("Final Season") collapse onto saison1. Returns null when
 * nothing scores (caller falls back to ordinal/seasons[0]).
 */
/**
 * True for a "hors-série" / recap / log panel — anime-sama parks these under a
 * `saison*hs` dir (or gives them a Log/Recap/Résumé label). They are NEVER the
 * answer to a normal episode request.
 *
 * Module-level because BOTH resolution paths need it and only one had it. The
 * player_map fast path checked season coherence with `/saison\s*(\d+)/`, which
 * reads "saison1hs" as season 1 — identical to "saison1" — so a row pinned to
 * the hors-série panel passed the guard and was served forever. Symptom:
 * Bungou Stray Dogs S1 ep1 playing an 11:40 recap short instead of the 23:42
 * episode, on the main-season URL.
 */
/**
 * Marker written into a player_map note when a `saison*hs` panel was chosen
 * because its label carries the AniList year — the one case where such a panel
 * IS the answer.
 *
 * anime-sama parks two different things under `saison*hs`: recap/log shorts,
 * and standalone hors-série SERIES that have their own AniList entry. The
 * blanket refusal below is right for the first and wrong for the second, and
 * the fast path cannot tell them apart on its own: it holds a dir name, not the
 * catalogue page, so it has neither the label nor the year to judge by.
 *
 * The heuristic path does have both — `seasons[].year` is parsed from the label
 * and matched against AniList's seasonYear, and that year match already
 * outranks every other signal. So it decides, and records that it decided.
 * A year in the label is a strong discriminator by construction: a recap panel
 * is titled "One Piece Log…" or "… Recap", never "Ghost in the Shell (2026)".
 *
 * Found on AniList 177699 — anime-sama carries THE GHOST IN THE SHELL (2026)
 * under `ghost-in-the-shell/saison1hs`, with four hosts, and we offered none of
 * them. Without this marker the row the resolver writes back would be rejected
 * and flagged as poisoned on the next request, then rewritten, forever.
 */
const HS_BY_YEAR = "hs panel matched by year";

function isSideStoryDir(dir, label) {
  return /hs$/i.test(dir || "") ||
    /\b(log|recap|r[ée]sum[ée]|digest|special)\b/i.test(label || "");
}

function pickAnimeSamaSeason(seasons, aniTitles, seasonNum) {
  if (!Array.isArray(seasons) || seasons.length <= 1) return null;
  if (!aniTitles || aniTitles.length === 0) return null;

  // Season-like panels only (drop film/oav/scan) with their "Saison N" number.
  const seasonPanels = seasons
    .filter((s) => !s.isFilm && /^saison/i.test(s.dir || ""))
    .map((s) => {
      const m = s.label.match(/saison\s*(\d+)/i);
      return { s, labelNum: m ? parseInt(m[1], 10) : null };
    });
  const numbered = seasonPanels.filter((p) => p.labelNum != null);
  const maxLabelNum = numbered.reduce((mx, p) => Math.max(mx, p.labelNum), 0);

  // A "hors-série" / recap / log panel (dir like `saison1hs`, or a label that
  // reads "One Piece Log…", "Recap", "Résumé") is NEVER the main series for a
  // normal episode request. anime-sama parks these under a saison*hs dir whose
  // LABEL still contains the franchise name ("One Piece Log: Fish-Man Island
  // Saga"), so the plain title-overlap below would pick it over the real
  // "Saga 1 (East Blue)" panel (whose label shares no token with "One Piece").
  // Exclude them from selection entirely.
  const isSideStory = (s) => isSideStoryDir(s.dir, s.label);

  // Case A — cleanly numbered panels and a detected season > 1: target the
  // matching "Saison N", clamping to the max so an overshooting seasonNum lands
  // on the last real season instead of falling back to S1.
  if (seasonNum > 1 && numbered.length > 0) {
    const want = Math.min(seasonNum, maxLabelNum);
    const hit = numbered.find((p) => p.labelNum === want && !isSideStory(p.s));
    if (hit) return hit.s;
  }

  // S1 of a SAGA-SEGMENTED series — One Piece, Naruto…: `saison1`,`saison2`,…
  // are consecutive arcs of one long series, and AniList counts it all as
  // season 1. Episode 1 must enter the cumulative chain at the numbered
  // `saison1` panel, not a name-labelled side panel. When seasonNum is 1 and a
  // real (non-side-story) `saison1` exists, return it so the caller's cumulative
  // walk starts from the right place.
  if (seasonNum <= 1) {
    const s1 = seasonPanels.find((p) => p.labelNum === 1 && !isSideStory(p.s));
    if (s1) return s1.s;
  }

  // Case B (and S1 of a numbered set) — token-overlap between the panel label
  // and the AniList titles, with a +6 boost when a numbered panel equals the
  // detected season (reinforces A, harmless elsewhere). Best score wins.
  // Side-story/recap panels are excluded so they never out-score the main one.
  let best = { season: null, score: 0 };
  for (const s of seasons) {
    if (isSideStory(s)) continue;
    let score = 0;
    for (const t of aniTitles) {
      const sc = scoreSlugAgainstTitle(s.label, t);
      if (sc > score) score = sc;
    }
    const m = s.label.match(/saison\s*(\d+)/i);
    const labelNum = m ? parseInt(m[1], 10) : null;
    if (seasonNum > 1 && labelNum === Math.min(seasonNum, maxLabelNum)) score += 6;
    if (score > best.score) best = { season: s, score };
  }
  return best.season && best.score > 0 ? best.season : null;
}

/**
 * L'URL de l'episode `index` CHEZ L'HOTE demande, ou null s'il n'y est pas.
 *
 * Remplace `findPreferredArray`, qui choisissait un tableau sur son PREMIER
 * element, l'appelant indexant ensuite dedans en supposant tout le tableau du
 * meme hote. C'est faux, et pas qu'en theorie : mesure du 17/08/2026, le panel VF de
 * `ghost-in-the-shell/saison1hs` porte
 *
 *   eps3 = [sibnet, sibnet, sibnet, ANSEMBED, sibnet, ANSEMBED]
 *
 * — anime-sama bouche les trous d'un lecteur avec un autre hote. Demander
 * l'episode 4 sur `animesama-sibnet` rendait donc une URL ansembed : le chip
 * « Sibnet » servait le flux d'ansembed, qui a deja son propre chip. Deux chips
 * pour un seul flux, et un diagnostic impossible a lire quand l'un des deux
 * tombe.
 *
 * On balaie donc TOUS les tableaux a la bonne position et on ne garde qu'une URL
 * qui appartient vraiment a l'hote. Aucune correspondance = l'hote n'a pas cet
 * episode, ce qui est une absence honnete.
 */
function pickPreferredEpisodeUrl(episodeArrays, preferred, index) {
  if (!(index >= 0)) return null;
  const prefs = (Array.isArray(preferred) ? preferred : [preferred]).map((p) =>
    String(p).toLowerCase(),
  );
  for (const arr of episodeArrays) {
    const url = arr[index];
    if (url && prefs.some((p) => url.toLowerCase().includes(p))) return url;
  }
  return null;
}

function parseEpisodesJs(jsContent) {
  // Parse var eps1 = ['url1', 'url2', ...]; var eps2 = [...]; etc.
  const arrays = [];
  const regex = /var\s+eps\d+\s*=\s*\[([^\]]*)\]/g;
  let match;
  while ((match = regex.exec(jsContent)) !== null) {
    const urls = [];
    // Extract all quoted strings from the array content
    const urlRegex = /['"]([^'"]+)['"]/g;
    let urlMatch;
    while ((urlMatch = urlRegex.exec(match[1])) !== null) {
      urls.push(urlMatch[1]);
    }
    if (urls.length > 0) arrays.push(urls);
  }
  return arrays;
}

// â”€â”€ voir-anime.to (VF + VOSTFR via WordPress / Madara theme) â”€â”€
const VOIRANIME_BASE = "https://voir-anime.to";
const voirSlugCache = new Map();
const VOIRANIME_SERVERS = {
  // VF
  "voiranime-voe":    { name: "VOE", host: ["voe.sx", "voe."], lang: "vf" },
  "voiranime-voe-vo": { name: "VOE", host: ["voe.sx", "voe."], lang: "vostfr" },
  // Vidmoly — voir-anime tends to carry fresher slugs than anime-sama (their
  // scrape rotates more often), so adding it gives us a separate uploader to
  // try when anime-sama's vidmoly URL is dead.
  //
  // `voembed.net` is the SAME panel ("LECTEUR myTV"): since ~2026-08 voir-anime
  // serves newly published episodes on that white-label domain and keeps
  // vidmoly.biz only on the back catalogue (surveyed 2026-08-06: all 25 titles
  // linked from the homepage were on voembed, 24/25 random verified back-cat
  // slugs still on vidmoly.biz). Both must match or the migrated titles lose
  // the chip entirely. Same backend, same encode → same `vidmoly-va` OP/ED
  // fingerprint host, so lib/hostRegistry.js needs no new entry.
  // `ansembed.net` is the THIRD domain of that same white-label network, and it
  // was the only one of the three this list did not know: lib/extractors.js and
  // lib/clientVidmoly.js both match it, and anime-sama has ansembed servers of
  // its own. Added for consistency, not to fix an observed failure — surveyed
  // 2026-08-10, voir-anime links voembed.net on the new titles and vidmoly.biz
  // on the back catalogue, and none of the pages checked linked ansembed
  // directly. If that changes, the chip keeps working instead of quietly
  // resolving to nothing. Same backend, so no registry entry of its own.
  "voiranime-vidmoly":    { name: "Vidmoly", host: ["vidmoly.to", "vidmoly.biz", "vidmoly.net", "voembed.net", "ansembed.net"], lang: "vf" },
  "voiranime-vidmoly-vo": { name: "Vidmoly", host: ["vidmoly.to", "vidmoly.biz", "vidmoly.net", "voembed.net", "ansembed.net"], lang: "vostfr" },
};

/**
 * How many episodes of this entry's own chain aired BEFORE it, when the site
 * keeps them all on one page.
 *
 * voir-anime keeps one page per SEASON; AniList splits some seasons into parts
 * with their own entries. "Shingeki no Kyojin: The Final Season Part 2" is
 * entry #131681 with 12 episodes, but on voir-anime its first episode is number
 * 17 of the season-4 page, behind the 16 of Part 1.
 *
 * That mattered more than it looks. The slug for Part 2 now resolves — the
 * subtitle forms find the season-4 page — so the prequel FALLBACK never runs,
 * and without this the resolver served page episode 3 for Part 2 episode 3:
 * the wrong episode, silently, which is worse than the missing chip it
 * replaced. Hayase's resolveSeason carries the offset whatever route found the
 * media; ours has to do the same rather than treat it as a repair for failure.
 */
async function voiranimeChainOffset(aniId) {
  let media = await getMediaMeta(aniId).catch(() => null);
  let offset = 0;
  for (let hop = 0; hop < MAX_PREQUEL_HOPS && media; hop += 1) {
    const edge = (media.relations?.edges || []).find(
      (e) => e?.relationType === "PREQUEL" && PREQUEL_FORMATS.has(e?.node?.format),
    );
    if (!edge?.node?.id) break;
    const prev = await getMediaMeta(Number(edge.node.id)).catch(() => null);
    if (!prev) break;
    // Only entries the SITE would have merged onto one page count: a previous
    // SEASON has its own page, a previous PART does not. We cannot see the
    // site's grouping from here, so we stop at the first ancestor whose own
    // title is not a part of the same season name.
    if (!sharesSeasonName(media, prev)) break;
    offset += Number(prev.episodes) || 0;
    media = prev;
  }
  return offset;
}

/** True when two entries are parts of one season — same title up to "Part N". */
function sharesSeasonName(a, b) {
  const strip = (m) =>
    (m?.title?.romaji || m?.title?.english || "")
      .replace(/\s*(Part|Cour)\s*\d+\s*$/i, "")
      .trim()
      .toLowerCase();
  const sa = strip(a);
  const sb = strip(b);
  return Boolean(sa) && sa === sb;
}

/**
 * Walk the PREQUEL chain until a season that voir-anime actually has a page for,
 * and shift the episode number by everything that came before.
 *
 * This is Hayase's `resolveSeason` (hayase-app/interface,
 * src/lib/components/ui/player/resolver.ts) reduced to what voir-anime needs.
 * The idea is theirs and it is the right one: a season is a NODE IN A CHAIN,
 * not a number to be guessed out of a title. Their version walks PREQUEL edges
 * accumulating each ancestor's episode count until the requested episode falls
 * inside the current entry; ours stops as soon as a slug resolves, because the
 * page — not the entry — is what carries the episodes.
 *
 * What it fixes: "Shingeki no Kyojin: The Final Season Part 2" has NO page of
 * its own. Its episodes are the tail of the season-4 page, starting at 17,
 * because voir-anime kept one page for a season AniList splits into parts. No
 * slug pattern can find a page that does not exist — the only way through is to
 * ask the prequel and carry the offset (16 episodes) along.
 *
 * `findEdge`'s format filter is Hayase's too, and load-bearing: an unfiltered
 * PREQUEL walk wanders into recap films and OVAs, which have episode counts of
 * their own and would poison the offset.
 */
// Reuses PREQUEL_FORMATS (declared above for the season walk) rather than
// keeping a second, subtly different list — two definitions of "what counts as
// a previous season" is how the two paths drift apart.
const MAX_PREQUEL_HOPS = 4;

async function voiranimePrequelChain(aniId, isVF, episode, trace = null) {
  let media = await getMediaMeta(aniId).catch(() => null);
  let offset = 0;

  for (let hop = 0; hop < MAX_PREQUEL_HOPS; hop += 1) {
    const edge = (media?.relations?.edges || []).find(
      (e) => e?.relationType === "PREQUEL" && PREQUEL_FORMATS.has(e?.node?.format || ""),
    );
    if (!edge?.node?.id) return null;

    const prevId = Number(edge.node.id);
    media = await getMediaMeta(prevId).catch(() => null);
    if (!media) return null;
    // The offset is what the PREQUEL aired, not what we air. Adding our own
    // count instead put Final Season Part 2 episode 1 at 13 (1 + our 12) rather
    // than 17 (1 + the prequel's 16) — a number the page has, belonging to the
    // previous part, so the mistake would have played the wrong episode rather
    // than failing loudly. Hayase's resolveSeason accumulates the same way.
    offset += Number(media?.episodes) || 0;

    const prevSeason = await detectSeasonNumber(prevId);
    const prevTitle = media.title?.romaji || media.title?.english || "";
    const slug = await findVoiranimeSlug(prevTitle, prevId, isVF, prevSeason);
    if (!slug) continue;

    // The offset counts what came BEFORE us, so our episode 1 is the prequel's
    // last + 1. Guard against a chain that would place us before its own start.
    const shifted = episode + offset;
    if (!Number.isFinite(shifted) || shifted < 1) return null;
    if (trace) trace.prequelChain = { slug, offset, hop: hop + 1, viaId: prevId };
    dlog(
      `[voiranime] no page for ${aniId}; using prequel ${prevId} (${slug}) with ep ${episode} → ${shifted}`,
    );
    return { slug, episode: shifted };
  }
  return null;
}

async function getVoiranimeIframe(serverKey, title, episode, aniId, trace = null) {
  try {
    const serverDef = VOIRANIME_SERVERS[serverKey];
    if (!serverDef) return null;
    const isVF = serverDef.lang === "vf";
    const lang = isVF ? "vf" : "vostfr";

    // ── player_map read-through (same lifecycle as anime-sama) ──────────────
    // The slug IS the whole mapping on voir-anime (each season has its own
    // slug), so a verified row skips findVoiranimeSlug's ~10 worker probes.
    const nowS = Math.floor(Date.now() / 1000);
    const mapRow = await getPlayerMapEntry(aniId, "voiranime", lang);
    if (trace) trace.mapRow = mapRow ? { status: mapRow.status, slug: mapRow.slug, algoVersion: mapRow.algoVersion } : null;
    if (
      mapRow &&
      (mapRow.status === "absent" || mapRow.status === "broken") &&
      mapRow.expiresAt > nowS
    ) {
      dlog(`[voiranime] player_map says ${mapRow.status} for ${aniId}/${lang} — skipping`);
      return null;
    }
    let mappedSlug =
      mapRow?.slug && (mapRow.status === "verified" || mapRow.status === "heuristic")
        ? mapRow.slug
        : null;

    // COHERENCE GUARD — reject a mapped slug whose season number contradicts the
    // resolver. A voir-anime slug encodes its season as a suffix
    // (shingeki-no-kyojin-2 = S2, shingeki-no-kyojin = S1). During the season-
    // cache Redis-poisoning window a season-1 entry got a "-2" slug written back,
    // and because player_map is read FIRST, every later request served S2's
    // episode 1 forever — the poison was self-perpetuating (re-served, never
    // re-resolved). Here we cross-check the mapped slug's suffix-season against
    // detectSeasonNumber; on mismatch we drop the row and re-resolve, which
    // breaks the loop for SNK and any other anime poisoned the same way.
    if (mappedSlug) {
      const expectedSeason = await detectSeasonNumber(aniId);
      const base = mappedSlug.replace(/-vf$/i, "");
      const suffix = base.match(/-(?:s|saison-|season-)?(\d+)$/);
      const slugSeason = suffix ? Number(suffix[1]) : 1;
      if (trace) trace.guard = { slugSeason, expectedSeason, mismatch: slugSeason !== expectedSeason };
      if (slugSeason !== expectedSeason) {
        dlog(`[voiranime] player_map slug ${mappedSlug} implies S${slugSeason} but resolver says S${expectedSeason} — ignoring poisoned row`);
        flagPlayerMap(aniId, "voiranime", lang, `season mismatch: slug S${slugSeason} vs resolver S${expectedSeason}`).catch(() => {});
        mappedSlug = null;
      }
    }

    let slug = mappedSlug;
    let viaPrequelOffset = 0;
    if (!slug) {
      const seasonNum = await detectSeasonNumber(aniId);
      slug = await findVoiranimeSlug(title, aniId, isVF, seasonNum);
      if (trace) trace.resolvedSlug = { seasonNum, slug };
      if (!slug) {
        // No page of its own — try the season it continues. See
        // voiranimePrequelChain.
        const viaPrequel = await voiranimePrequelChain(aniId, isVF, episode, trace);
        if (viaPrequel) {
          slug = viaPrequel.slug;
          // It resolved the shift itself, so the offset below must not add a
          // second one.
          viaPrequelOffset = viaPrequel.episode - Number(episode);
        } else {
          dlog(`[voiranime] No slug found for ${title} (${lang}, S${seasonNum})`);
          return null;
        }
      }
    }
    if (trace) trace.finalSlug = slug;
    dlog(`[voiranime] Slug: ${slug} (${lang}${mappedSlug ? ", via player_map" : ""})`);

    // Fetch the anime detail page to get the full episode list.
    // Some Madara installs require the episode list via admin-ajax (chapters).
    let episodeUrl = null;
    /*
     * Shift into the page's numbering when this entry is a later PART of a
     * season the site keeps on one page. Zero for everything else, so the
     * ordinary case is untouched. See voiranimeChainOffset.
     */
    const chainOffset = viaPrequelOffset || (await voiranimeChainOffset(aniId));
    const wantedEpisode = Number(episode) + chainOffset;
    if (chainOffset > 0) {
      dlog(`[voiranime] ${aniId} is a later part: ep ${episode} → ${wantedEpisode}`);
      if (trace) trace.chainOffset = chainOffset;
    }
    let partUrls = null; // set only for a split episode — see partLetters below

    // Episode URLs may sit under the parent slug OR a short child-slug variant
    // (e.g. tokyo-ghoul-vf → tokyo-ghoul-vf-a) — see buildVoiranimeEpRegex.
    const slugEsc = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const baseEsc = VOIRANIME_BASE.replace(/\./g, "\\.");
    const epRegex = buildVoiranimeEpRegex(slug);
    // Film / movie pattern: a child URL with NO episode number, e.g.
    // /anime/howl-no-ugoku-shiro-vf/film-vf-howl-no-ugoku-shiro/. Madara stores
    // single-entry films as one "chapter" whose slug starts with "film"/"movie"
    // instead of carrying a digit, so the episode regex above never sees them —
    // that's why films had no playable server. We match any non-feed child of
    // the anime path that looks like a film/movie/ova/oav stub and treat it as
    // "episode 1". Same optional child-slug suffix as the episode regex.
    const filmRegex = new RegExp(
      `href=["'](${baseEsc}/anime/${slugEsc}(?:-[a-z0-9]{1,3})?/(?:film|movie|ova|oav|special)[^"']*/)["']`,
      "gi"
    );

    // Split-episode opt-in (lib/multipartEpisodes.js). Restricted to the
    // browser-extracted Vidmoly hosts: the two parts are stitched back together
    // by merging their HLS playlists in the user's browser (lib/hlsMerge.js),
    // which only works for a host we hand to the client as an embed URL. On any
    // other host the lookup below stays the ordinary single-file one and simply
    // finds nothing — a hidden chip, not a half episode.
    const partLetters = serverDef.host.some((h) => h.startsWith("vidmoly"))
      ? getEpisodeParts(aniId, "voiranime", lang, episode)
      : null;
    const partRegex = partLetters ? buildVoiranimeEpPartRegex(slug) : null;

    /** The part URLs for `episode`, in playback order — or null if any is missing. */
    const collectParts = (html) => {
      const found = new Map();
      let m;
      partRegex.lastIndex = 0;
      while ((m = partRegex.exec(html)) !== null) {
        if (parseInt(m[2], 10) !== Number(episode)) continue;
        const letter = m[3].toLowerCase();
        if (!found.has(letter)) found.set(letter, m[1]);
      }
      const urls = partLetters.map((p) => found.get(p));
      // All or nothing. Serving part A alone as "episode 1" would put every
      // later timestamp — watch progress, OP/ED skips — half an hour out.
      if (urls.some((u) => !u)) {
        dlog(
          `[voiranime] ep ${episode} parts incomplete: found ${[...found.keys()].join(",") || "none"}, need ${partLetters.join(",")}`,
        );
        return null;
      }
      return urls;
    };

    const collectEpisodes = (html) => {
      const map = new Map();
      let m;
      epRegex.lastIndex = 0;
      while ((m = epRegex.exec(html)) !== null) {
        const epNum = parseInt(m[2], 10);
        if (!map.has(epNum)) map.set(epNum, m[1]);
      }
      // If the page exposes no numbered episodes but does carry a film/movie
      // entry, register it as episode 1 so single-entry films resolve. We only
      // do this when there are no numbered episodes to avoid mis-mapping a
      // "film" bonus that sits alongside a real numbered season.
      if (map.size === 0) {
        filmRegex.lastIndex = 0;
        const fm = filmRegex.exec(html);
        if (fm) map.set(1, fm[1]);
      }
      return map;
    };

    // Try detail page scrape first. Routed via the CF Worker — voir-anime.to
    // 403s direct Vercel fetches (Cloudflare), same as anime-sama.
    let detailDead = false; // 4xx on a mapped slug = the mapping itself is gone
    // …and the opposite: the detail page never gave a verdict (5xx/429/timeout).
    // Tracked so a "no episode found" that's really "we never saw the list" is
    // reported as retryable instead of a 6h absence.
    let detailInconclusive = false;
    try {
      const detailRes = await fetchViaWorker(`${VOIRANIME_BASE}/anime/${slug}/`);
      if (detailRes.ok) {
        const html = await detailRes.text();
        if (partLetters) partUrls = collectParts(html);
        const epMap = collectEpisodes(html);
        if (epMap.has(wantedEpisode)) {
          episodeUrl = epMap.get(wantedEpisode);
        }
      } else if (detailRes.status >= 400 && detailRes.status < 500 && detailRes.status !== 429) {
        detailDead = true;
      } else {
        detailInconclusive = true;
      }
    } catch (e) {
      console.error(`[voiranime] detail fetch failed for ${slug}:`, e.message);
      detailInconclusive = true;
    }

    // Fallback: try Madara AJAX chapters endpoint. This stays a DIRECT fetch:
    // the CF Worker only proxies GETs (it drops the method/body), so routing a
    // POST through it would silently become a GET and fail. Best-effort only —
    // the detail-page scrape above (via Worker) is the primary path.
    if (!episodeUrl || (partLetters && !partUrls)) {
      try {
        const ajaxRes = await fetchWithTimeout(
          `${VOIRANIME_BASE}/wp-admin/admin-ajax.php`,
          {
            method: "POST",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `action=manga_get_chapters&manga=${slug}`,
          },
        );
        if (ajaxRes.ok) {
          const html = await ajaxRes.text();
          if (partLetters && !partUrls) partUrls = collectParts(html);
          const epMap = collectEpisodes(html);
          if (epMap.has(wantedEpisode)) {
            episodeUrl = epMap.get(wantedEpisode);
          }
        }
      } catch {}
    }

    // A split episode has no un-lettered URL of its own: the parts ARE the
    // episode. Anchor the rest of the function (player_map write-back, the
    // "not found" strike) on the first part so both shapes share one path.
    if (partUrls) episodeUrl = partUrls[0];

    if (!episodeUrl) {
      // A mapped slug whose page 4xxes is a dead mapping (slug renamed /
      // removed): record the strike so three failures demote verified→broken
      // and the verifier re-derives it. An episode merely missing from a live
      // page is NOT flagged — that's just "not aired / not carried yet".
      if (mappedSlug && detailDead) {
        flagPlayerMap(aniId, "voiranime", lang, "mapped slug page 4xx");
      }
      dlog(`[voiranime] Episode ${episode} not found in ${slug}`);
      // "Not in the list" is only a verdict if we actually READ the list. When
      // the detail page pushed back and the AJAX fallback didn't fill in either,
      // we know nothing — retry rather than hide the chip for 6h.
      if (detailInconclusive) {
        throw new TransientSourceError(`voir-anime episode list unreachable for ${slug}`);
      }
      return null;
    }

    // WRITE-BACK: the slug resolved this episode — persist it so the next
    // request (and the verifier) skip the probe storm. Guarded against
    // rewriting an unchanged mapping on every click.
    if (!mapRow || mapRow.slug !== slug) {
      upsertPlayerMap({
        aniId,
        source: "voiranime",
        lang,
        status: "heuristic",
        slug,
        seasonDir: null,
        epOffset: 0,
        episodeCount: null,
        note: "runtime resolution",
      }).catch(() => {});
    }

    // ── Split episode: hand the browser BOTH embeds ───────────────────────
    // The player extracts each one (binding each token to the user's IP, as
    // usual) and merges the two HLS playlists into a single continuous stream,
    // so nothing downstream of this point ever sees two files. Strictly all or
    // nothing: one dead part means no chip, because a truncated episode would
    // desynchronise the scrubber, the resume position and the OP/ED skips.
    if (partUrls) {
      const embeds = [];
      for (const url of partUrls) {
        const embed = await voiranimeEpisodeIframe(url, serverDef, serverKey);
        if (!embed) {
          dlog(`[voiranime] ep ${episode} part page has no ${serverDef.name} embed: ${url}`);
          return null;
        }
        if (!(await isVidmolyEmbedAlive(embed))) {
          dlog(`[voiranime] ep ${episode} part embed is dead — hiding chip: ${embed}`);
          return null;
        }
        embeds.push(embed);
      }
      dlog(`[voiranime] ep ${episode} resolved as ${embeds.length} parts on ${serverDef.name}`);
      return {
        clientExtract: { type: "vidmoly-multipart", embedUrls: embeds },
        // Fallback only — an iframe can show one part, never the merged whole.
        iframe: embeds[0],
      };
    }

    const iframeUrl = await voiranimeEpisodeIframe(episodeUrl, serverDef, serverKey);
    if (!iframeUrl) return null;

    dlog(`[voiranime] Found ep ${episode} on ${serverDef.name}: ${iframeUrl}`);

    // Content validation BEFORE attempting extraction â€” saves ~1-2s of
    // pointless work when the video is already gone, and prevents the player
    // from getting stuck in a 403 retry loop on segments that will never come.
    const lower = iframeUrl.toLowerCase();
    if (lower.includes("voe.sx") || lower.includes("voe.")) {
      try {
        const probe = await fetchWithTimeout(iframeUrl, { redirect: "follow" });
        if (!probe.ok) {
          dlog(`[voiranime] VOE probe HTTP ${probe.status} â€” hiding server`);
          return null;
        }
        const html = await probe.text();
        // Follow the JS redirect to the actual mirror (maryspecialwatch.com,
        // weneverbeenfree.com, etc) and validate THAT response. Without this
        // every removed VOE video returns 200 here and only fails later
        // during stream extraction, leaving the player stuck in a load loop.
        const mirrorMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (mirrorMatch) {
          const mirror = await fetchWithTimeout(mirrorMatch[1], { redirect: "follow" });
          if (!mirror.ok) {
            dlog(`[voiranime] VOE mirror HTTP ${mirror.status} â€” video removed, hiding server`);
            return null;
          }
          const mirrorHtml = await mirror.text();
          if (
            mirrorHtml.includes("404 - Not found") ||
            mirrorHtml.includes("404 Not Found") ||
            /The server can ?not find the requested resource/i.test(mirrorHtml) ||
            // No JSON payload â†’ no video data on the page
            !/<script[^>]*type=["']application\/json["']/i.test(mirrorHtml)
          ) {
            dlog(`[voiranime] VOE mirror returned error/empty page â€” hiding server`);
            return null;
          }
        } else if (
          html.includes("404 - Not found") ||
          html.includes("404 Not Found") ||
          /The server can ?not find the requested resource/i.test(html)
        ) {
          dlog(`[voiranime] VOE returned 404 page â€” hiding server`);
          return null;
        }
      } catch (e) {
        // Network error â€” fall through and let the client try
      }
    }

    // Vidmoly: same bypass as anime-sama — hand the embed URL to the browser
    // so the m3u8 token IP-binds to the user instead of any proxy. See the
    // commentary in getAnimeSamaIframe for the full rationale.
    if (VIDMOLY_HOST_RE.test(lower)) {
      if (!(await isVidmolyEmbedAlive(iframeUrl))) {
        dlog(`[voiranime] vidmoly slug 404 — hiding chip: ${iframeUrl}`);
        // PROVEN gone: the probe only answers false on an explicit 404 (a network
        // error returns true so we never punish a chip for our own hiccup). Say
        // so, instead of returning the ambiguous null — the client then stops
        // re-offering a chip that can only ever spin.
        throw new HardAbsenceError(`vidmoly upload deleted: ${iframeUrl}`);
      }
      return {
        clientExtract: { type: "vidmoly", embedUrl: iframeUrl },
        iframe: iframeUrl,
      };
    }

    // Server-side extraction preferred; falls back to a degraded iframe
    // chip when the extractor can't unpack the host.
    if (EXTRACTABLE_HOSTS.some((h) => lower.includes(h))) {
      const extractor = getExtractor(iframeUrl);
      const result = await extractor(iframeUrl);
      if (result.streams?.length) return result;
      console.error(
        `[voiranime] ${serverKey} extractor failed for ep=${episode} slug=${slug}: ${result.error}`,
      );
      // VOE iframes are X-Frame-blocked on every non-VOE origin → "refused
      // to connect". Sibnet does the same. Both: hide rather than serve a
      // chip that can never load.
      if (lower.includes("voe.sx") || lower.includes("voe.") || lower.includes("sibnet")) {
        return null;
      }
    }
    return { iframe: iframeUrl, degraded: true, reason: "extraction failed" };
  } catch (error) {
    console.error(`voiranime ${serverKey} error:`, error.message);
    // Was `return null` — which told the caller "this host genuinely has no
    // source", so ONE worker hiccup / CF challenge / timeout got negative-cached
    // (10 min) AND published into the 6h availability snapshot: the chip showed
    // on the first load and was gone after a reload, for every visitor, until
    // the TTL expired. Exactly the megaplay "disappeared after a reload" bug
    // (see its retry-before-declaring-absent comment) — anime-sama already
    // guards this way; voir-anime never did. A genuine absence always returns
    // null from the paths above, so a THROW here is by definition transient —
    // except the one absence we can PROVE, which travels as its own type.
    if (error instanceof HardAbsenceError) throw error;
    throw error instanceof TransientSourceError
      ? error
      : new TransientSourceError(error.message);
  }
}

/**
 * The host's iframe URL on one voir-anime episode page, or null.
 *
 * Split out of getVoiranimeIframe because a multi-part episode has to run it
 * once PER PART (see lib/multipartEpisodes.js) — inlined, the two paths would
 * have drifted apart the first time voir-anime changed its markup.
 *
 * null means ONE thing: the page loaded and this host is genuinely not on it.
 * Everything else throws TransientSourceError — see the contract in
 * getVoiranimeIframe's catch.
 */
async function voiranimeEpisodeIframe(episodeUrl, serverDef, serverKey) {
  // Via the Worker — voir-anime.to 403s direct Vercel fetches (Cloudflare).
  const epRes = await fetchViaWorker(episodeUrl);
  if (!epRes.ok) {
    console.error(`[voiranime] ${serverKey} episode page ${epRes.status} for ${episodeUrl}`);
    // 5xx/429/403 = the Worker or Cloudflare pushed back — that is NOT a verdict
    // on whether this host carries the episode. Same reasoning as
    // voiranimeSlugExists's "unknown". A real 404/410 IS a verdict (the page is
    // gone), so it stays a clean absence.
    if (epRes.status >= 500 || epRes.status === 429 || epRes.status === 403) {
      throw new TransientSourceError(
        `voir-anime episode page ${epRes.status} for ${episodeUrl}`,
      );
    }
    return null;
  }
  const epHtml = await epRes.text();

  const sourcesMatch = epHtml.match(/thisChapterSources\s*=\s*({[\s\S]*?});/);
  if (!sourcesMatch) {
    dlog(`[voiranime] No thisChapterSources in ${episodeUrl}`);
    // A real episode page ALWAYS carries this block. Its absence on a 200 means
    // we got something else — an anti-bot interstitial, a truncated body, a
    // theme change. Never broadcast that as "this host has no source".
    throw new TransientSourceError(`voir-anime episode page has no player data: ${episodeUrl}`);
  }

  let sources;
  try {
    sources = JSON.parse(sourcesMatch[1]);
  } catch {
    dlog(`[voiranime] Failed to parse thisChapterSources JSON`);
    throw new TransientSourceError(`voir-anime player data unparseable: ${episodeUrl}`);
  }

  // Find the player whose iframe URL matches one of the host patterns
  for (const [_, iframeHtml] of Object.entries(sources)) {
    const srcMatch = iframeHtml.match(/<iframe\s+src=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const url = srcMatch[1];
    if (serverDef.host.some((h) => url.toLowerCase().includes(h.toLowerCase()))) {
      return url;
    }
  }

  dlog(`[voiranime] Host ${serverDef.host[0]} not available for ${episodeUrl}`);
  return null;
}

/**
 * Build the regex that finds episode URLs for a voir-anime slug.
 *
 * voir-anime frequently stores a series' episodes under a CHILD slug that's the
 * parent slug plus a short disambiguator: the parent page `/anime/tokyo-ghoul-vf/`
 * lists episodes at `/anime/tokyo-ghoul-vf-a/tokyo-ghoul-12-vf/`. A strict
 * `/anime/{slug}/…` match misses those entirely → the whole series reads as
 * "missing player" even though it's right there. So we allow an OPTIONAL short
 * suffix segment (`-a`, `-2`, …) after the parent slug — short enough (≤3 chars)
 * that it's a disambiguator, not a different anime (`naruto` won't swallow
 * `naruto-shippuden`). The episode number is the last `-N` before the trailing
 * slash, optionally followed by `-vf`/`-vostfr`.
 */
function buildVoiranimeEpRegex(slug) {
  const slugEsc = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const baseEsc = VOIRANIME_BASE.replace(/\./g, "\\.");
  return new RegExp(
    `href=["'](${baseEsc}/anime/${slugEsc}(?:-[a-z0-9]{1,3})?/[^"']+?-(\\d+)(?:-(?:vf|vostfr))?/)["']`,
    "gi",
  );
}

/**
 * Same as buildVoiranimeEpRegex, but for the LETTERED episode URLs a split
 * episode produces: `…/re-zero-…-01a-vf/` and `…-01b-vf/`.
 *
 * These are deliberately invisible to the ordinary episode regex — it anchors
 * on `-<digits>` immediately before the trailing slash (or `-vf`), so `01a`
 * never matches and a lettered URL can't be mistaken for episode 1. That's the
 * property we want: only the callers that consulted lib/multipartEpisodes.js
 * and got an opt-in ever look for these, so no other title can accidentally
 * pick up a `-a`/`-b` page as a regular episode.
 *
 * Captures: [1] the URL, [2] the episode number, [3] the part letter.
 */
function buildVoiranimeEpPartRegex(slug) {
  const slugEsc = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const baseEsc = VOIRANIME_BASE.replace(/\./g, "\\.");
  return new RegExp(
    `href=["'](${baseEsc}/anime/${slugEsc}(?:-[a-z0-9]{1,3})?/[^"']+?-(\\d+)([a-z])(?:-(?:vf|vostfr))?/)["']`,
    "gi",
  );
}

// Convert a title to a URL slug (lowercase, hyphens, no diacritics).
function titleToSlug(title) {
  return (title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * All plausible base slugs for a title. The default titleToSlug turns every
 * run of non-alphanumerics into a hyphen, but the scrapers don't agree on how
 * to treat punctuation between two letters:
 *   "Re:Zero …"  → voir-anime uses "rezero-…" (colon COLLAPSED, no hyphen)
 *                  while titleToSlug gives "re-zero-…".
 * So whenever a title has punctuation glued between two word-chars (`Re:Zero`,
 * `Fate/stay`, `K-On`→ already fine), we also emit a variant where that
 * punctuation is DROPPED (letters joined). Returns a de-duped array, primary
 * (hyphenated) form first. Cheap — used only to widen direct slug guessing.
 */
/**
 * The part of a title BEFORE its colon, slugified — "Shingeki no Kyojin: The
 * Final Season" → "shingeki-no-kyojin". Null when there is no colon or the head
 * is too short to identify a franchise.
 */
function headSlugOf(title) {
  const idx = (title || "").search(/[:：]/);
  if (idx < 0) return null;
  const head = titleToSlug(title.slice(0, idx));
  return head && head.length >= 3 ? head : null;
}

/**
 * The part of a title that follows its colon, slugified — "Shingeki no Kyojin:
 * The Final Season" → "the-final-season".
 *
 * Returns null when there is no subtitle, or when what follows the colon is too
 * short to identify anything ("Re:Zero" must not yield "zero").
 */
function subtitleSlugOf(title) {
  const idx = (title || "").search(/[:：]/);
  if (idx < 0) return null;
  const sub = titleToSlug(title.slice(idx + 1));
  return sub && sub.length >= 4 ? sub : null;
}

function titleToSlugVariants(title) {
  const out = new Set();
  const add = (s) => { if (isUsableSlugBase(s)) out.add(s); };
  const primary = titleToSlug(title);
  add(primary);
  // Collapse punctuation that sits BETWEEN two alphanumerics (drop it entirely)
  // before slugifying, so "Re:Zero" → "rezero", "Fate/Zero" → "fatezero".
  add(titleToSlug((title || "").replace(/([a-z0-9])[^a-z0-9\s]+([a-z0-9])/gi, "$1$2")));
  // The multiplication sign "×" (and "&") joining two words is rendered as the
  // LETTER "x" with NO separator on voir-anime: "SPY×FAMILY" → spyxfamily (not
  // spy-family / spyfamily). Only when the title actually has such a join do we
  // emit the fully-joined "…x…" form — guarded so ordinary multi-word titles
  // (which must keep their hyphens) are untouched.
  if (/[×✕✗⨯]/.test(title || "") || /[a-z0-9]\s*&\s*[a-z0-9]/i.test(title || "")) {
    const xJoined = (title || "")
      .replace(/\s*[×✕✗⨯]\s*/g, " x ")
      .replace(/([a-z0-9])\s*&\s*([a-z0-9])/gi, "$1 x $2");
    // Fully joined (spy x family → spyxfamily) and hyphen-x (spy-x-family).
    add(titleToSlug(xJoined).replace(/-/g, ""));
    add(titleToSlug(xJoined));
  }
  return [...out];
}

/**
 * A slug base is only usable if it carries real alphabetic content. A title in
 * a non-Latin script (Thai/Chinese/Japanese synonym like "เกิดชาตินี้พี่ต้องเทพ ซีซั่น 2"
 * or "第2季") gets stripped to nothing but its digits by titleToSlug → "2",
 * which is a catastrophic candidate (matches /anime/2/, or passes the numeric
 * confidence floor). Require ≥3 letters so only meaningful Latin slugs survive.
 */
function isUsableSlugBase(slug) {
  if (!slug) return false;
  const letters = slug.replace(/[^a-z]/gi, "");
  if (letters.length < 3) return false;
  // …and the ≥3-letter floor is not enough on its own. A non-Latin synonym that
  // happens to embed a Latin fragment survives it as pure boilerplate: AniList
  // lists "ผ่าพิภพไททัน Final Season" for Attack on Titan, and titleToSlug
  // reduces it to the bare word `final-season`. That passes the letter count
  // and would be probed as a real anime slug, matching whatever unrelated page
  // voir-anime happens to have there. Reject a base that is nothing BUT season
  // boilerplate — it never identifies a title.
  return !/^(?:the-)?(?:final-|\d+(?:st|nd|rd|th)-)?(?:season|saison|part|cour|act)(?:-\d+|-[ivx]+)?$/i.test(
    slug,
  );
}

// Quickly check if /anime/{slug}/ exists. Routed through the CF Worker because
// voir-anime.to (Cloudflare) 403s direct fetches from Vercel's AWS IPs — the
// same reason anime-sama scraping goes via the Worker. The Worker returns 200
// for a live anime page and 410/4xx for a dead slug, so a 200 is a reliable
// "exists" signal. We follow redirects (a missing-language slug 301s to the
// catalogue, which would NOT be a 200) so a redirect doesn't count as a hit.
async function voiranimeSlugExists(slug) {
  try {
    const r = await fetchViaWorker(
      `${VOIRANIME_BASE}/anime/${slug}/`,
      { method: "GET", redirect: "follow" },
      3500, // tight budget — we probe up to ~10 slug candidates sequentially
    );
    if (r.status === 200) return "yes";
    // 5xx / 429 = the Worker or voir-anime is rate-limited / challenged, NOT a
    // verdict on whether the slug exists. Report it as inconclusive so the caller
    // doesn't cache a permanent "missing" for a slug that may be perfectly valid.
    if (r.status >= 500 || r.status === 429) return "unknown";
    return "no"; // a real 4xx (404/410) → this slug genuinely doesn't exist
  } catch {
    return "unknown"; // network/timeout — also inconclusive
  }
}

// Words that indicate a movie / special / film entry â€” never the main TV series.
const MOVIE_WORDS = ["film", "movie", "stampede", "special", "ova", "fan-letter", "kai", "log-", "log:", "episode-of", "adventure-of", "heart-of-gold", "glorious-island"];

// Hard wall-clock budget for a single slug resolution. The whole /api/v2/source
// request must finish inside Vercel's 10s function limit, and the resolver also
// fetches the detail page + extracts after this returns — so slug-finding gets
// a slice. Past the deadline we stop probing and let the caller fall back /
// fail fast rather than letting a slow upstream blow the whole request.
const VOIR_SLUG_BUDGET_MS = 6000;

async function findVoiranimeSlug(title, aniId, isVF, seasonNum, mediaOpts = {}) {
  const cacheKey = `${aniId}-${isVF ? "vf" : "vostfr"}-${seasonNum}`;
  if (voirSlugCache.has(cacheKey)) return voirSlugCache.get(cacheKey);
  const deadline = Date.now() + VOIR_SLUG_BUDGET_MS;

  // Strip season suffixes for base title
  const stripSeason = (t) =>
    t?.replace(/\s*(Season\s*\d+|\d+(st|nd|rd|th)\s*Season|Part\s*\d+|\d+æœŸ|2nd|3rd)\s*/gi, "").trim();

  // Collect title candidates from the shared Media cache (zero AniList hits if primed)
  const titleSet = new Set([title]);
  const stripped = stripSeason(title);
  if (stripped) titleSet.add(stripped);

  const m = await getMediaMeta(aniId, mediaOpts);
  if (m) {
    for (const t of [m.title?.english, m.title?.romaji, ...(m.synonyms || [])]) {
      if (t) {
        titleSet.add(t);
        const s = stripSeason(t);
        if (s) titleSet.add(s);
      }
    }
  }

  const titles = [...titleSet];

  // â”€â”€ Strategy 1: direct slug guessing (much faster than search) â”€â”€
  // For S2+ try several season-suffix conventions voir-anime actually uses:
  //   {base}-s{N}-vf  (e.g. kaiju-no-8-s2-vf  â† the real one)
  //   {base}-{N}-vf   (e.g. kaiju-no-8-2-vf)
  //   {base}-saison-{N}-vf
  // S1 just tries {base}. Always honour the -vf vs un-suffixed (VOSTFR) split.
  //
  // ORDER IS CRITICAL: the probe loop accepts the FIRST slug that exists. For a
  // season ≥2 the un-suffixed base often ALSO exists (it's the season-1 page) —
  // accepting it would serve S1. So we add every season-suffixed form FIRST
  // (across all titles + slug variants), and only then the bare bases. The bare
  // base is the right answer only for season 1.
  const slugCandidates = new Set();
  const bareBases = [];
  // titleToSlugVariants tries BOTH the hyphenated and the punctuation-collapsed
  // base (voir-anime writes "Re:Zero" as "rezero", not "re-zero"), hyphenated
  // first so the common case is tried before the collapsed one.
  if (seasonNum > 1) {
    for (const t of titles) {
      for (const base of titleToSlugVariants(t)) {
        if (!base) continue;
        // Most-common voir-anime convention first.
        for (const form of [
          `${base}-s${seasonNum}`,
          `${base}-${seasonNum}`,
          `${base}-saison-${seasonNum}`,
          `${base}-season-${seasonNum}`,
        ]) {
          slugCandidates.add(isVF ? `${form}-vf` : form);
        }
        /*
         * The number goes BETWEEN the base and the subtitle, not after it.
         *
         * Measured on voir-anime 2026-08-10, Attack on Titan season 4:
         *   shingeki-no-kyojin-4-the-final-season-vf  200   ← the real page
         *   shingeki-no-kyojin-4-vf                   404
         *   shingeki-no-kyojin-s4-vf                  404
         *   shingeki-no-kyojin-the-final-season-vf    404
         * Not one of the forms above can reach it, and neither can the bare
         * base: the site numbers the season AND keeps the subtitle. The four
         * numbered forms only ever work for a title that has no subtitle
         * (shingeki-no-kyojin-2, -3 are both 200), which is why this went
         * unnoticed until a season whose name is its subtitle.
         */
        const sub = subtitleSlugOf(t);
        // `base` is the slug of the WHOLE title, subtitle included, so it must
        // not be reused here — pairing it with the subtitle again produced
        // `shingeki-no-kyojin-the-final-season-4-the-final-season`. The head is
        // what goes before the colon, and it is the only part the number
        // attaches to.
        const head = headSlugOf(t);
        if (sub && head) {
          for (const form of [`${head}-${seasonNum}-${sub}`, `${head}-${sub}`]) {
            slugCandidates.add(isVF ? `${form}-vf` : form);
          }
        }
      }
    }
  }
  for (const t of titles) {
    for (const base of titleToSlugVariants(t)) {
      if (!base) continue;
      bareBases.push(isVF ? `${base}-vf` : base);
      // NOTE: do NOT fall back to the un-suffixed slug for VF requests â€” that
      // slug is the VOSTFR variant and would silently serve the wrong language.
    }
  }
  // For season 1 the bare base IS the target, so it must be probed. For S2+ the
  // bare base is only a last resort AFTER all -sN forms failed (some franchises
  // really do use a plain slug for a later season).
  for (const b of bareBases) slugCandidates.add(b);

  // Probe candidates in PRIORITY-ORDERED BATCHES instead of one-by-one. The old
  // sequential loop awaited a ~1-3s worker round-trip per candidate; with a
  // dozen candidates (every title × every slug variant × every season form)
  // that ran 25s+ and blew the Vercel 10s budget → the player timed out and
  // showed as broken on a cold (uncached) visit. We keep the order intact (so
  // the most-likely slug still wins ties) by probing in small concurrent
  // batches and taking the earliest-listed hit within each batch. A hard cap
  // bounds the total work.
  const ordered = Array.from(slugCandidates).slice(0, 16);
  // BATCH was 4, which meant only the first EIGHT candidates were ever probed:
  // each probe allows 3.5 s, batches run back-to-back, and the deadline check
  // sits between them — so batch 1 ends at ~3.5 s, batch 2 at ~7 s, and batch 3
  // is refused against the 6 s budget. Everything past position 8 was dead
  // weight, including the bare base, which is deliberately ordered LAST.
  //
  // That is what made voir-anime look missing for anime it carries perfectly
  // well. Measured on Ace of the Diamond act II (AniList 105749): the title
  // already encodes its season, so the real page is the bare
  // `diamond-no-ace-act-ii` (HTTP 200) sitting at position 10 — never reached,
  // while the season-suffixed forms we did probe (…-s3, -3, -saison-3,
  // -season-3) are all 404. Same shape for Attack on Titan S2, whose
  // `shingeki-no-kyojin-2` sits at 13.
  //
  // These are I/O-bound Worker fetches, so 8 in flight costs the same
  // wall-clock as 4. Doubling the batch covers all 16 candidates in two rounds
  // (~7 s worst case, and the second round is admitted because it starts at
  // ~3.5 s) WITHOUT touching the priority order — which matters, because that
  // order is what stops a season ≥2 from falling back onto the season-1 page.
  const BATCH = 8;
  let sawInconclusive = false;
  for (let i = 0; i < ordered.length; i += BATCH) {
    if (Date.now() > deadline) { sawInconclusive = true; break; } // out of budget
    const batch = ordered.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (cand) => ({ cand, exists: await voiranimeSlugExists(cand) })),
    );
    // Earliest candidate in the batch that exists wins (preserves priority).
    const hit = results.find((r) => r.exists === "yes");
    if (hit) {
      voirSlugCache.set(cacheKey, hit.cand);
      return hit.cand;
    }
    if (results.some((r) => r.exists === "unknown")) sawInconclusive = true;
  }

  // â”€â”€ Strategy 2: search fallback with stricter scoring â”€â”€
  // Cap to the first few title variants — searching every synonym is what
  // pushed a cold resolve past the function budget. The english + romaji +
  // stripped forms (first in the set) carry almost all the matching power.
  for (const q of titles.slice(0, 3)) {
    if (Date.now() > deadline) { sawInconclusive = true; break; }
    try {
      const res = await fetchWithTimeout(
        `${VOIRANIME_BASE}/wp-admin/admin-ajax.php`,
        {
          method: "POST",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `action=wp-manga-search-manga&title=${encodeURIComponent(q)}`,
        },
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (!data?.success || !data?.data?.length) continue;

      // Build candidates and score them. STRICT: language mismatch is rejected outright.
      const baseSlug = titleToSlug(stripped || title);
      const candidates = data.data
        .filter((r) => r.url && r.url.includes("/anime/"))
        .map((r) => {
          const slug = r.url.replace(/^.*\/anime\//, "").replace(/\/$/, "");
          const isVfSlug = /-vf$/i.test(slug);
          const cleanSlug = slug.replace(/-vf$/i, "");
          // Season suffix conventions voir-anime mixes: "-s2", "-2",
          // "-saison-2", "-season-2". Parse any of them so the right season
          // entry scores highest instead of defaulting to S1.
          const seasonMatch = cleanSlug.match(/-(?:s|saison-|season-)?(\d+)$/);
          const slugSeason = seasonMatch ? Number(seasonMatch[1]) : 1;
          const seasonStripped = cleanSlug.replace(/-(?:s|saison-|season-)?\d+$/, "");

          let score = 0;
          // HARD reject if language mismatches â€” VF request must yield -vf slug, etc.
          if (isVfSlug !== isVF) return { slug, score: -1 };
          // Reject movies/specials hard â€” never used for TV episode lookup
          if (MOVIE_WORDS.some((w) => slug.toLowerCase().includes(w))) score -= 100;
          // Exact base slug match (best signal)
          if (seasonStripped === baseSlug) score += 50;
          else if (seasonStripped.startsWith(baseSlug)) score += 20;
          // Season number matches
          if (slugSeason === seasonNum) score += 30;
          else if (seasonNum === 1 && slugSeason === 1) score += 15;
          else score -= Math.abs(slugSeason - seasonNum) * 5;
          // Penalize very long slugs (specials with descriptive names)
          if (slug.length > baseSlug.length + 15) score -= 10;

          return { slug, title: r.title, isVfSlug, slugSeason, score };
        })
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

      if (candidates.length > 0 && candidates[0].score >= 20) {
        const chosen = candidates[0];
        voirSlugCache.set(cacheKey, chosen.slug);
        return chosen.slug;
      }
    } catch {}
  }

  // Cache the failure too — avoid hammering search on every probe. EXCEPT when a
  // probe was inconclusive (Worker/voir-anime 5xx/429/timeout): the slug might
  // be valid, so don't pin a permanent "missing" — let the next request retry.
  if (!sawInconclusive) voirSlugCache.set(cacheKey, null);
  // The in-memory cache was already careful here, but the VERDICT still left as
  // a bare null — so the caller reported a clean absence and the chip got buried
  // in the 6h availability snapshot anyway. An inconclusive search is retryable,
  // and saying so is the whole point of having tracked it.
  if (sawInconclusive) {
    throw new TransientSourceError(
      `voir-anime slug search inconclusive for ${title} (S${seasonNum}, ${isVF ? "vf" : "vostfr"})`,
    );
  }
  return null;
}

// ── Audit / inspection helpers ───────────────────────────────────────────
// These reuse the SAME resolution path the player uses (detectSeasonNumber +
// findSlug + the season/episode listing), but stop BEFORE stream extraction
// and return the matching metadata instead. The audit script
// (scripts/audit-players.mjs) calls these (via /api/v2/source/inspect) to
// compare what each source resolves to against the AniList episode count, so
// we can find anime that map to the wrong season / slug (e.g. a Season 2 that
// falls back to the Season 1 panel) or that are missing entirely.
//
// They are READ-ONLY and never throw: on any failure they return
// { found: false, ... } so a batch audit can't be derailed by one bad anime.

/** Inspect what anime-sama resolves to for an AniList id + language. */
export async function inspectAnimeSama(aniId, lang = "vostfr") {
  const langPath = lang === "vf" ? "vf" : "vostfr";
  const out = {
    source: "animesama",
    lang: langPath,
    found: false,
    slug: null,
    seasonNum: null,
    chosenSeasonDir: null,
    chosenSeasonLabel: null,
    episodeCount: 0,
    firstEpUrl: null,
    lastEpUrl: null,
    seasonsAvailable: [],
    merged: false,
    mergedOffset: 0,
    effectiveEpisodes: null,
  };
  // Audit is read-only and must not spend Redis (Upstash quota): skip the
  // response cache + Redis limiter on every AniList lookup this triggers.
  const RO = { skipCache: true };
  try {
    const meta = await getMediaMeta(aniId, RO);
    const title = meta?.title?.english || meta?.title?.romaji || null;
    if (!title) return out;

    out.seasonNum = await detectSeasonNumber(aniId, RO);
    const slug = await findAnimeSamaSlug(title, aniId, RO);
    if (!slug) return out;
    out.slug = slug;

    const detailRes = await fetchViaWorker(`${ANIMESAMA_BASE}/catalogue/${slug}/`);
    if (!detailRes.ok) return out;
    const detailHtml = await detailRes.text();

    const seasonMatches = [
      ...detailHtml.matchAll(/panneauAnime\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g),
    ];
    const seasons = seasonMatches
      .map((m) => {
        const path = m[2];
        const dirMatch = path.match(
          /^(saison[^/]+|film[^/]*|oav[^/]*|special[^/]*|scan[^/]*)\//i,
        );
        if (!dirMatch) return null;
        const yearMatch = m[1].match(/\b(19|20)\d{2}\b/);
        return {
          label: m[1],
          dir: dirMatch[1],
          path: m[2],
          year: yearMatch ? parseInt(yearMatch[0], 10) : null,
          isFilm: /^film/i.test(dirMatch[1]),
        };
      })
      .filter(Boolean)
      .map((s, i) => ({ ...s, ordinal: i + 1 }));
    if (seasons.length === 0) {
      seasons.push({ label: "Saison 1", ordinal: 1, dir: "saison1", path: `saison1/${langPath}`, year: null, isFilm: false });
    }
    out.seasonsAvailable = seasons.map((s) => ({ dir: s.dir, label: s.label, ordinal: s.ordinal, year: s.year }));

    // Mirror the player's season-selection logic so the audit sees the SAME
    // target the player would pick (year match → title match → ordinal).
    const isMovie = meta?.format === "MOVIE";
    const filmSeason = seasons.find((s) => s.isFilm);
    const aniYear = meta?.seasonYear || meta?.startDate?.year || null;
    let yearMatchedSeason = aniYear ? seasons.find((s) => s.year === aniYear) : null;

    // Same scorer the player uses, so the audit reflects exactly what the player
    // would pick (label==seasonNum primary, title overlap tie-break).
    const aniTitles = [meta?.title?.romaji, meta?.title?.english, ...(meta?.synonyms || [])].filter(Boolean);
    const titleMatchedSeason = pickAnimeSamaSeason(seasons, aniTitles, out.seasonNum);

    const directTarget =
      (isMovie && filmSeason) ||
      yearMatchedSeason ||
      titleMatchedSeason ||
      (out.seasonNum > 1 ? seasons.find((s) => s.ordinal === out.seasonNum) : null) ||
      seasons[0];

    if (!directTarget) return out;
    out.chosenSeasonDir = directTarget.dir;
    out.chosenSeasonLabel = directTarget.label;

    // Mirror the resolver's language handling: film panels carry their own
    // language; a VF request also tries vf1/vf2 dub tracks.
    const targetLangs = directTarget.isFilm
      ? [directTarget.path.split("/")[1] || langPath]
      : animeSamaLangDirs(langPath);
    let epRes = null;
    for (const lp of targetLangs) {
      const r = await fetchViaWorker(`${ANIMESAMA_BASE}/catalogue/${slug}/${directTarget.dir}/${lp}/episodes.js`);
      if (r.ok) { epRes = r; break; }
    }
    if (!epRes) {
      // The chosen season has no episodes.js in this language — still report
      // the resolution; episodeCount stays 0 so the audit flags it.
      return out;
    }
    const jsContent = await epRes.text();
    const episodeArrays = parseEpisodesJs(jsContent);
    if (episodeArrays.length === 0) return out;
    // Canonical count = the longest host array (host availability varies).
    const canonical = episodeArrays.reduce((a, b) => (b.length > a.length ? b : a), []);
    out.found = true;
    out.episodeCount = canonical.length;
    out.firstEpUrl = canonical[0] || null;
    out.lastEpUrl = canonical[canonical.length - 1] || null;

    // MERGED-PANEL detection (mirrors the live resolver). When a season ≥2 lands
    // on a single panel that concatenates the whole franchise, the player offsets
    // into the merged list — so this is RESOLVED, not a wrong-season miss. Report
    // the offset + the effective per-season window so the audit can tell the
    // difference between "merged panel, handled" and a genuine mismatch.
    const ownEps = Number(meta?.episodes) || 0;
    const looksMerged =
      out.seasonNum > 1 &&
      ownEps > 0 &&
      canonical.length >= ownEps + 1 &&
      canonical.length > ownEps + 2;
    if (looksMerged) {
      const offset = await resolveMergedOffset(aniId, 0, canonical.length, ownEps, RO);
      if (offset > 0) {
        out.merged = true;
        out.mergedOffset = offset;
        // Episodes actually addressable for THIS season within the merged panel.
        out.effectiveEpisodes = Math.min(ownEps || canonical.length - offset, canonical.length - offset);
        out.firstEpUrl = canonical[offset] || out.firstEpUrl;
        const lastIdx = Math.min(canonical.length - 1, offset + (ownEps ? ownEps - 1 : canonical.length - 1 - offset));
        out.lastEpUrl = canonical[lastIdx] || out.lastEpUrl;
      }
    }
    return out;
  } catch (e) {
    return { ...out, error: e?.message || String(e) };
  }
}

/** Inspect what voir-anime resolves to for an AniList id + language. */
export async function inspectVoiranime(aniId, lang = "vostfr") {
  const isVF = lang === "vf";
  const out = {
    source: "voiranime",
    lang: isVF ? "vf" : "vostfr",
    found: false,
    slug: null,
    seasonNum: null,
    episodeCount: 0,
    episodeNumbers: [],
    firstEpUrl: null,
    lastEpUrl: null,
  };
  // Audit is read-only and must not spend Redis (Upstash quota): skip the
  // response cache + Redis limiter on every AniList lookup this triggers.
  const RO = { skipCache: true };
  try {
    const meta = await getMediaMeta(aniId, RO);
    const title = meta?.title?.english || meta?.title?.romaji || null;
    if (!title) return out;

    out.seasonNum = await detectSeasonNumber(aniId, RO);
    let slug = await findVoiranimeSlug(title, aniId, isVF, out.seasonNum, RO);
    if (!slug) {
      // Mirror the player's prequel-chain fallback, or the audit reports
      // "missing" for every entry the player can actually serve through its
      // previous season — an instrument that disagrees with the thing it
      // measures is worse than none.
      const viaPrequel = await voiranimePrequelChain(aniId, isVF, 1);
      if (viaPrequel) {
        slug = viaPrequel.slug;
        out.viaPrequel = { slug, episodeOffset: viaPrequel.episode - 1 };
      }
    }
    if (!slug) return out;
    out.slug = slug;

    // Reproduce getVoiranimeIframe's episode collection (detail page → AJAX).
    const epRegex = buildVoiranimeEpRegex(slug);
    const collect = (html) => {
      const map = new Map();
      let m;
      epRegex.lastIndex = 0;
      while ((m = epRegex.exec(html)) !== null) {
        const n = parseInt(m[2], 10);
        if (!map.has(n)) map.set(n, m[1]);
      }
      return map;
    };

    let epMap = new Map();
    try {
      const detailRes = await fetchViaWorker(`${VOIRANIME_BASE}/anime/${slug}/`);
      if (detailRes.ok) epMap = collect(await detailRes.text());
    } catch { /* ignore */ }
    if (epMap.size === 0) {
      try {
        const ajaxRes = await fetchWithTimeout(`${VOIRANIME_BASE}/wp-admin/admin-ajax.php`, {
          method: "POST",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `action=manga_get_chapters&manga=${slug}`,
        });
        if (ajaxRes.ok) epMap = collect(await ajaxRes.text());
      } catch { /* ignore */ }
    }

    if (epMap.size === 0) return out;
    const nums = [...epMap.keys()].sort((a, b) => a - b);
    out.found = true;
    out.episodeCount = nums.length;
    out.episodeNumbers = nums;
    out.firstEpUrl = epMap.get(nums[0]) || null;
    out.lastEpUrl = epMap.get(nums[nums.length - 1]) || null;
    return out;
  } catch (e) {
    return { ...out, error: e?.message || String(e) };
  }
}

// â”€â”€ Consumet providers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AnimeSaturn was removed at user request; no consumet-backed servers remain.
// The dispatch below is kept (guarded on an empty map) so re-adding a provider
// is a one-line change.
const CONSUMET_PROVIDERS = {};

async function getConsumetStream(providerKey, title, episode, sub) {
  try {
    const def = CONSUMET_PROVIDERS[providerKey];
    if (!def) return null;

    const provider = new def.cls();

    // 1. Search
    const searchRes = await provider.search(title);
    if (!searchRes?.results?.length) return null;

    // Prefer sub/dub variant if available
    const isDub = sub === "dub";
    const anime =
      searchRes.results.find(
        (r) =>
          isDub
            ? r.subOrDub === "dub" || r.title?.toLowerCase().includes("ita")
            : r.subOrDub === "sub" || !r.title?.toLowerCase().includes("ita")
      ) || searchRes.results[0];

    // 2. Get episodes
    const info = await provider.fetchAnimeInfo(anime.id);
    if (!info?.episodes?.length) return null;

    const ep = info.episodes.find((e) => e.number === Number(episode));
    if (!ep?.id) return null;

    // 3. Get sources
    const sources = await provider.fetchEpisodeSources(ep.id);
    if (!sources?.sources?.length) return null;

    return {
      streams: sources.sources
        .filter((s) => s.url)
        .map((s) => ({
          url: s.url,
          quality: s.quality || "default",
          isM3U8: s.isM3U8 !== false,
        })),
      subtitles: sources.subtitles?.map((s) => ({
        file: s.url,
        label: s.lang || "Default",
        kind: "captions",
      })),
      referer: sources.headers?.Referer || null,
    };
  } catch (e) {
    console.error(`Consumet ${providerKey} error:`, e.message);
    return null;
  }
}

// ── Cross-visitor source cache ─────────────────────────────────────────
// Source extraction is by far the most CPU-expensive endpoint in the API.
// Every watch-page mount fan-outs 15-20 probes; in practice ~half of those
// 404 (server doesn't have this anime / episode). Without negative caching,
// every visitor of a popular episode repeats the same expensive scrape for
// the same dead servers.
//
// Two TTLs:
//   - OK_TTL  (5 min): tokens we proxy last 60-240 min, so 5 min is safe.
//   - 404_TTL (2 min): shorter, because some 404s are transient (upstream
//     rate-limit, brief CDN outage). 2 min collapses the probe burst from
//     concurrent viewers without locking in a transient failure for long.
//
// Negative entries store a sentinel ({__nf: true}) under the same key as
// positive entries — a hit is either parsed JSON we serve as 200, or the
// sentinel we turn into 404.
const SOURCE_CACHE_TTL_S = 300;
// Negative cache: keep dead probes out of the scrape rotation for 10 min.
// A server that has no source for an episode now (anti-bot reject, slug not
// listed, episode not posted yet) almost never flips to available within a few
// minutes, so a longer negative TTL collapses the cold-visit re-scrape storm —
// the dominant CPU cost on a freshly-released popular episode where dozens of
// visitors each fan out probes that all 404 the same dead servers. The client
// no longer persists failed probes to sessionStorage, so the only thing
// shielding the upstream from that storm is THIS cache; 2 min was too short to
// cover the initial viewing wave. A genuinely transient miss self-heals after
// the TTL with no user-visible difference (the chip just stays grey until then).
const SOURCE_NOTFOUND_TTL_S = 600;
const NOT_FOUND_SENTINEL = '{"__nf":1}';
// Same sentinel, plus "and we proved it" — so a cache hit (or a follower waiting
// on the leader) answers with the same `hard` flag the scrape would have. Without
// this the flag would survive exactly one request out of every ten minutes'
// worth, which is the same as not having it.
const HARD_NOT_FOUND_SENTINEL = '{"__nf":1,"hard":1}';
const isNotFoundSentinel = (v) =>
  v === NOT_FOUND_SENTINEL || v === HARD_NOT_FOUND_SENTINEL;

// ── Single-flight lock ──────────────────────────────────────────────────
// On a freshly-released popular episode the cache is cold and dozens of
// visitors fan out probes for the SAME (server, episode) at the same instant.
// The Redis cache is only populated AFTER the first scrape returns, so without
// coordination every concurrent request runs its OWN cheerio scrape — N
// identical scrapes burning N× the Fluid CPU for one result. This is the exact
// shape of the CPU spikes (one bad day = a viewing wave on a hot episode).
//
// Fix: the first request to miss the cache acquires a short Redis lock and
// becomes the LEADER that actually scrapes. Concurrent requests (followers)
// poll the cache for the leader's result instead of scraping. If the leader
// hasn't published within the wait budget (slow upstream, or it crashed and
// the lock expired) the follower falls through and scrapes itself — so a dead
// leader never deadlocks the rest.
const LOCK_TTL_S = 20; // > maxDuration won't happen; covers a slow-but-alive scrape
const LOCK_WAIT_MS = 6000; // follower waits at most this long for the leader
// Follower poll cadence. Each tick is a Redis GET, so on a cold popular episode
// with dozens of concurrent followers this is a command AMPLIFIER (150ms over a
// 6s budget = up to 40 GETs per follower). 350ms caps it at ~17 while adding at
// most ~200ms to a follower that is already waiting on the leader anyway — a
// worthwhile trade against the Upstash command budget during viewing waves.
const LOCK_POLL_MS = 350;
const lockKey = (cacheKey) => `lock:${cacheKey}`;

// Try to become the leader. Returns true if WE hold the lock (must scrape),
// false if someone else holds it (we're a follower → poll the cache).
async function acquireScrapeLock(cacheKey) {
  try {
    const ok = await redis.set(lockKey(cacheKey), "1", "EX", LOCK_TTL_S, "NX");
    return ok === "OK";
  } catch {
    // Redis hiccup → don't block the user; behave as leader (scrape).
    return true;
  }
}

async function releaseScrapeLock(cacheKey) {
  try {
    await redis.del(lockKey(cacheKey));
  } catch {
    /* lock self-expires via TTL — non-fatal */
  }
}

// Follower path: poll the cache until the leader publishes a result (positive
// payload or the NOT_FOUND sentinel) or we exhaust LOCK_WAIT_MS. Returns the
// raw cached string, or null on timeout (caller then scrapes as a fallback).
async function waitForLeaderResult(cacheKey) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached;
    } catch {
      /* transient — keep polling until the deadline */
    }
  }
  return null;
}

function sourceCacheKey({ server, aniId, episode, sub }) {
  // v10: Vidmoly now has a Fly-proxy tier 2 fallback. Worker-blocked
  // embeds (vidmoly.biz 410 from CF IPs) get extracted via Fly and the
  // m3u8 wrapped through Fly too, so playback lands in the Universal
  // Player instead of the iframe fallback. Bump so the v9 degraded
  // iframe entries flush and the next probe re-runs the tier chain.
  // v11: EVICT wrong-season stream URLs cached during the season-cache
  // Redis-poisoning window. A poisoned player_map served season 2's embed
  // for a season-1 episode, and that wrong URL got cached here under the
  // player's `sub` key — surviving the player_map purge because THIS cache
  // is keyed independently and kept hot (rewritten within its 300s TTL on
  // every hit). Bumping the version orphans every v10 entry so the next
  // probe re-resolves from the (now-correct) resolver. See the season-cache
  // Redis->Turso migration + player_map purge for the upstream fix.
  // v12: EVICT the absences recorded before the anime-sama slug fix. A title
  // indexed under its franchise name (see the pre-colon query in
  // findAnimeSamaSlug) resolved to nothing, and "nothing" is cached for 6 h
  // like any other answer — so every host stayed missing on a build that could
  // serve them, and the negative entry was rewritten on each probe. Bumping
  // orphans the v11 absences so the next probe asks the fixed resolver.
  // v13: same again for the voir-anime slug forms ({base}-{N}-{subtitle}).
  // A resolver that reaches pages it could not reach before must not be read
  // through absences recorded by the one that could not.
  return `src:v13:${server}:${aniId}:${episode}:${sub || "sub"}`;
}

// ── Handler ─────────────────────────────────────────────────────────────
/**
 * GET  /api/v2/source?server=&aniId=&episode=&sub=&title=&malId=
 * POST /api/v2/source   { server, aniId, episode, sub, title, mediaMeta, soft404 }
 *
 * GET is what the browser uses, and the reason this endpoint stopped being the
 * site's top Active-CPU line. The route always set `s-maxage` / stale-while-
 * revalidate on its answers, but they were dead letters: **no CDN caches a
 * POST**, so every visitor re-invoked the function for a resolution the edge
 * already had — and the watch page fires one per server it probes, per page
 * load. Same handler, same cache keys; only the transport changed, so a GET and
 * a POST for the same episode still share the Redis entry.
 *
 * The body carried nothing that doesn't fit in a query string: `mediaMeta` was a
 * whole media object (title, synonyms, relations) of which the route reads
 * exactly one field, `idMal` — now `?malId=`.
 *
 * POST is kept verbatim for the warmers / crons / audit scripts, which are not
 * cacheable anyway (they exist to bust the cache) and rely on the 404/204
 * contract below.
 */
export default async function handler(req, res) {
  const isGet = req.method === "GET";
  if (!isGet && req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  // Internal callers (cache warmer, crons, audit) send X-Warmer: 1. They're
  // trusted and shouldn't spend a Redis EVALSHA on the per-IP limiter — that
  // consume() is a write and was needless quota burn during bulk runs.
  const isInternal = req.headers["x-warmer"] === "1";

  const input = (isGet ? req.query : req.body) || {};
  const server = input.server;
  // Query values arrive as strings; the resolvers below expect the numbers the
  // POST body always gave them (ids are compared and used to build upstream
  // URLs, and `NaN` must not silently reach a cache key).
  const aniId = input.aniId != null ? Number(input.aniId) : undefined;
  const episode = input.episode != null ? Number(input.episode) : undefined;
  const sub = input.sub === "dub" ? "dub" : "sub";
  const title = input.title;
  const mediaMeta = isGet
    ? input.malId
      ? { idMal: Number(input.malId) }
      : null
    : input.mediaMeta;

  if (isGet && (!server || !Number.isFinite(aniId) || !Number.isFinite(episode))) {
    return res.status(400).json({ error: "server, aniId and episode required" });
  }

  // "Source absent" is an EXPECTED outcome for the watch page (half the probes
  // miss by design), so it must not read as an error:
  //   - GET  → 200 { absent: true }. A status the CDN is guaranteed to cache
  //     (204 caching is not something to bet the busiest endpoint on) and that
  //     prints nothing in the browser console.
  //   - POST → the original contract: 204 with soft404:true, hard 404 without,
  //     which the warmers and audit scripts still read.
  const wantsSoft404 = !isGet && req.body?.soft404 === true;
  // `hard` = the absence was PROVEN (see HardAbsenceError), not merely observed.
  // GET-only: the POST contract (warmers, audit scripts) has no use for it and
  // its 204 carries no body anyway.
  const notFoundStatus = (msg, { hard = false } = {}) =>
    isGet
      ? res.status(200).json(hard ? { absent: true, hard: true } : { absent: true })
      : wantsSoft404
      ? res.status(204).end()
      : res.status(404).json({ error: msg || "Source not found" });

  /* The cache contract, in one place (three code paths answer "found" and three
     answer "absent", and they used to disagree with each other).

     `CDN-Cache-Control` is what Vercel's edge reads — plain `Cache-Control`
     alone only ever reached the browser, which is why the negative path (~half
     of all probes) re-invoked the function every single time.

     Found → 5 min at the edge, matching SOURCE_CACHE_TTL_S. A payload can be
     served up to its Redis TTL old and then sit another 5 min in the edge, so
     the worst case is a ~10 min old stream URL — well inside the 60-240 min
     lifetime of the CDN tokens we proxy, and the browser's own 60 s means a
     manual refresh always re-resolves.

     Absent → 5 min at the edge, under the 10 min negative sentinel in Redis, so
     the edge never claims "absent" longer than the server itself would. */
  const CACHE_FOUND = "public, s-maxage=300, stale-while-revalidate=600";
  const CACHE_ABSENT = "public, s-maxage=300, stale-while-revalidate=300";
  const cacheFound = () => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader("CDN-Cache-Control", CACHE_FOUND);
  };
  const cacheAbsent = () => {
    res.setHeader("Cache-Control", "public, max-age=30");
    res.setHeader("CDN-Cache-Control", CACHE_ABSENT);
  };

  // Redis lookup FIRST — short-circuit identical (server, aniId, episode, sub)
  // requests served within the last SOURCE_CACHE_TTL_S. The probe fan-out on
  // the watch page sends a burst of these at once, every page load.
  //
  // ORDER MATTERS for Upstash command budget: the cache GET runs BEFORE the
  // rate-limiter consume(). A cache hit is cheap and harmless, so it shouldn't
  // pay the limiter's ~2-3 EVALSHA commands — on a popular episode (the Sunday
  // traffic spike) the vast majority of probes hit the cache, so doing the
  // limiter first multiplied our Redis command count 3-4× for nothing. The
  // limiter only needs to gate the expensive scrape path (cache miss), so we
  // consume() only after we know we're going to scrape.
  const cacheKey = sourceCacheKey({ server, aniId, episode, sub });
  const canCache = redis && server && aniId && episode != null;
  if (canCache) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        if (isNotFoundSentinel(cached)) {
          // Negative cache hit — skip the expensive scrape entirely. This is
          // the main CPU win: ~half of probe fan-outs naturally 404, and a
          // popular episode would re-extract the same dead servers for every
          // visitor without this.
          cacheAbsent();
          return notFoundStatus("Source not found", {
            hard: cached === HARD_NOT_FOUND_SENTINEL,
          });
        }
        cacheFound();
        return res.status(200).json(JSON.parse(cached));
      }
    } catch {
      /* non-fatal */
    }
  }

  // Cache miss → we're about to do the expensive scrape. NOW gate it behind the
  // per-IP rate limiter (consume() is a write: ~2-3 Redis commands). Cache hits
  // above never reach this, so the limiter cost is only paid on the path that
  // actually warrants protection.
  if (redis && !isInternal) {
    try {
      const ipAddress = req.socket.remoteAddress;
      await rateLimiterRedis.consume(ipAddress);
    } catch (error) {
      // rate-limiter-flexible rejects with a RateLimiterRes (has msBeforeNext)
      // on a genuine quota hit, but with a plain Error when its Redis store is
      // unreachable. FAIL OPEN on the latter: a broken limiter store must not
      // 429 every request (that's what spammed the console when the native
      // Redis port was blocked). Only enforce the limit on a real quota breach.
      if (error && typeof error.msBeforeNext === "number") {
        return res.status(429).json({
          error: `Too Many Requests, retry after ${error.msBeforeNext / 1000}`,
        });
      }
      // limiter store error → don't gate; proceed to the scrape.
    }
  }

  // Single-flight: collapse the concurrent cold-cache scrape storm. Only the
  // leader (lock holder) scrapes; followers wait for its published result and
  // serve that — turning N identical scrapes into 1. Skipped when caching is
  // off (no Redis / missing key params) since there's nothing to coordinate on.
  let isLeader = true;
  if (canCache) {
    isLeader = await acquireScrapeLock(cacheKey);
    if (!isLeader) {
      const leaderResult = await waitForLeaderResult(cacheKey);
      if (leaderResult) {
        if (isNotFoundSentinel(leaderResult)) {
          cacheAbsent();
          return notFoundStatus("Source not found", {
            hard: leaderResult === HARD_NOT_FOUND_SENTINEL,
          });
        }
        cacheFound();
        return res.status(200).json(JSON.parse(leaderResult));
      }
      // Leader timed out (slow upstream or it crashed and its lock expired).
      // Fall through and scrape ourselves so a dead leader never wedges us.
      isLeader = true;
    }
  }

  const sendOk = (payload) => {
    if (canCache) {
      // Fire-and-forget — never let cache writes block the response. Release
      // the lock only AFTER the cache write lands, so a follower never finds
      // the lock gone before the result is visible (which would let it scrape).
      const write = redis
        .set(cacheKey, JSON.stringify(payload), "EX", SOURCE_CACHE_TTL_S)
        .catch(() => {});
      if (isLeader) write.finally(() => releaseScrapeLock(cacheKey));
    }
    cacheFound();
    return res.status(200).json(payload);
  };

  const sendNotFound = (msg, { hard = false } = {}) => {
    if (canCache) {
      const write = redis
        .set(
          cacheKey,
          hard ? HARD_NOT_FOUND_SENTINEL : NOT_FOUND_SENTINEL,
          "EX",
          SOURCE_NOTFOUND_TTL_S,
        )
        .catch(() => {});
      if (isLeader) write.finally(() => releaseScrapeLock(cacheKey));
    }
    cacheAbsent();
    return notFoundStatus(msg, { hard });
  };

  // A TRANSIENT resolve failure (upstream down/slow, anti-bot, timeout) — as
  // opposed to a genuine "no source for this episode". Critically it does NOT
  // write the negative-cache sentinel and answers 503, so the client's probe
  // treats it as `retry` (not `fail-404`) and NEVER publishes the server into
  // the 6h availability `absent` snapshot. Otherwise a single flaky scrape hides
  // a working chip (e.g. Megaplay) for everyone until the TTL expires. We still
  // release the scrape lock so followers aren't wedged; they just re-scrape.
  const sendRetryable = (msg, { hostDown = false } = {}) => {
    if (canCache && isLeader) releaseScrapeLock(cacheKey).catch(() => {});
    res.setHeader("Cache-Control", "no-store");
    return res
      .status(503)
      .json({ error: msg || "Source temporarily unavailable", ...(hostDown && { hostDown: true }) });
  };

  // DO NOT prime getMediaMeta's caches from `mediaMeta` — it's a CLIENT-built
  // slim payload (id/title/synonyms/relations, no seasonYear/startDate/format).
  // Priming replaced the lambda's full cached Media with that truncated shape
  // for 24 h (and merged it into the Turso anime row), which broke season
  // detection fleet-wide: the year guard saw no years, the legacy walk crossed
  // the mis-tagged "Kuinaki Sentaku" PREQUEL OVA, detectSeasonNumber said S2,
  // the coherence guards then killed CORRECT player_map rows and re-poisoned
  // them with season-2 panels (the recurring "SnK S1 plays S2"). It is also
  // client-controlled data — nothing a client sends should overwrite server
  // caches. mediaMeta is still read inline below for megaplay's idMal + title.

  // Megaplay â€” extract m3u8 + subtitles directly (no iframe).
  // Megaplay exposes two equivalent stream routes (both verified live):
  //   /stream/mal/<malId>/<episode>/<sub|dub>
  //   /stream/ani/<aniListId>/<episode>/<sub|dub>
  // They resolve to the SAME MegaCloud source when both ids map. We try the MAL
  // route first (historically the better-mapped of the two) and fall back to the
  // AniList route â€” which crucially also covers titles that have NO MAL id, or
  // whose MAL mapping Megaplay hasn't synced yet (their own docs warn the
  // AniList/MAL mapping is incomplete). Either route succeeding is a hit.
  if (server === "megaplay") {
    let malId = mediaMeta?.idMal || null;
    if (!malId) {
      const meta = await getMediaMeta(aniId);
      malId = meta?.idMal || null;
    }
    const lang = sub === "dub" ? "dub" : "sub";
    // Candidate routes in priority order; skip the MAL one when there's no id.
    const routes = [];
    if (malId) routes.push(`https://megaplay.buzz/stream/mal/${malId}/${episode}/${lang}`);
    if (aniId) routes.push(`https://megaplay.buzz/stream/ani/${aniId}/${episode}/${lang}`);
    if (routes.length === 0) {
      return sendNotFound("megaplay: no MAL or AniList id for this anime");
    }
    // Try every route once; return the first hit. Reports whether the run was
    // ALL genuine "file not found" (safe to negative-cache) vs any transient
    // failure (must 503-retry).
    const tryRoutes = async () => {
      let lastError = "Source not found";
      let allAbsent = true;
      for (const url of routes) {
        const result = await extractMegaplay(url);
        if (!result.error && result.streams?.length) return { hit: result };
        lastError = result.error || lastError;
        // A route that failed for any reason OTHER than a confirmed absence
        // marks the run as transient — don't negative-cache a timeout just
        // because the other route legitimately 404s.
        if (!result.absent) allAbsent = false;
      }
      return { hit: null, allAbsent, lastError };
    };

    const warmMegaplay = (result) => {
      // Pre-warm the edge cache NOW, at resolve time — before the player even
      // loads the manifest. Megaplay is proxy-only (the CDN 403s any Referer but
      // megaplay.buzz, which a browser can't forge), so its cold start pays a
      // double hop. Firing the master through the Worker here (with the megaplay
      // Referer) triggers the Worker's warm chain (variant + sampled segments),
      // so by the time the user hits Play the opening is a cache HIT.
      // Fire-and-forget: never delays the resolve response.
      const m3u8 = result.streams[0]?.url;
      if (m3u8 && /\.m3u8/i.test(m3u8)) {
        const warmUrl =
          `${PROXY_BASE}?url=${encodeURIComponent(m3u8)}` +
          `&referer=${encodeURIComponent("https://megaplay.buzz/")}`;
        fetchWithTimeout(warmUrl, { headers: { "x-warmer": "1" } }, 4000).catch(
          () => {},
        );
      }
    };

    let run = await tryRoutes();
    if (run.hit) {
      warmMegaplay(run.hit);
      return sendOk(run.hit);
    }
    // A verdict of "genuinely absent on every route" that came from a SINGLE
    // pass is not trustworthy enough to broadcast: megaplay serves its
    // "Error - MegaPlay / We can't find the file" page (a 200) during transient
    // outages too, and the active-source path — unlike the probe fan-out — has
    // no retry of its own. A one-shot false absence gets negative-cached (10 min)
    // AND published into the 6h availability snapshot, so the Megaplay chip
    // vanishes for everyone until the TTL expires (the "megaplay disappeared
    // after a reload" bug). Confirm a genuine absence with ONE retry: a real
    // "file not found" is deterministic and stays absent; a transient error page
    // clears to a hit or a non-200 (→ transient) on the second look.
    if (run.allAbsent) {
      await new Promise((r) => setTimeout(r, 500));
      run = await tryRoutes();
      if (run.hit) {
        warmMegaplay(run.hit);
        return sendOk(run.hit);
      }
    }
    // Only negative-cache + hide the chip when the absence survived the retry.
    // Anything else stays transient → 503 so the client retries and never buries
    // the chip in the snapshot.
    return run.allAbsent
      ? sendNotFound(run.lastError)
      : sendRetryable(run.lastError);
  }


  // Helper to resolve anime title â€” uses shared cache, only hits AniList if missing
  async function resolveTitle() {
    if (title) return title;
    const m = await getMediaMeta(aniId);
    return m?.title?.english || m?.title?.romaji || null;
  }

  // A provider resolver returning null = genuine "no source for this episode"
  // (→ 204 absent). A TransientSourceError = an upstream hiccup (worker/host
  // timeout) → 503 retryable, so the watch page retries instead of freezing the
  // chip absent for 6h. See TransientSourceError.
  const resolveProvider = async (fn) => {
    try {
      return { data: await fn() };
    } catch (error) {
      if (error instanceof TransientSourceError)
        return { retry: error.message, hostDown: error.hostDown };
      if (error instanceof HardAbsenceError) return { hardAbsent: error.message };
      throw error; // a genuinely unexpected error keeps the outer 500 handling
    }
  };

  // Frembed (VF + VOSTFR) — direct, proxy-free m3u8. Placed before the scraping
  // providers because it needs neither a title nor a slug: the AniList id maps
  // straight to TMDB through Fribb's static cross-map.
  if (FREMBED_SERVERS[server]) {
    const { data, retry, hostDown } = await resolveProvider(() =>
      getFrembedStream(server, aniId, episode),
    );
    if (retry) return sendRetryable(retry, { hostDown });
    if (!data) return sendNotFound("Source not found");
    return sendOk(data);
  }

  // Anime-Sama (VF + VOSTFR) â€” returns iframe embed URL
  if (ANIMESAMA_SERVERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) return sendNotFound("Could not resolve anime title");
    const { data, retry, hostDown } = await resolveProvider(() =>
      getAnimeSamaIframe(server, searchTitle, episode, aniId),
    );
    if (retry) return sendRetryable(retry, { hostDown });
    if (!data) return sendNotFound("Source not found");
    return sendOk(data);
  }

  // voir-anime.to (VF + VOSTFR) â€” Madara/WordPress source
  if (VOIRANIME_SERVERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) return sendNotFound("Could not resolve anime title");
    const { data, retry, hardAbsent, hostDown } = await resolveProvider(() =>
      getVoiranimeIframe(server, searchTitle, episode, aniId),
    );
    if (retry) return sendRetryable(retry, { hostDown });
    if (hardAbsent) return sendNotFound(hardAbsent, { hard: true });
    if (!data) return sendNotFound("Source not found");
    return sendOk(data);
  }

  // Consumet providers (AnimeSaturn, AnimeUnity)
  if (CONSUMET_PROVIDERS[server]) {
    const searchTitle = await resolveTitle();
    if (!searchTitle) return sendNotFound("Could not resolve anime title");
    const { data, retry, hostDown } = await resolveProvider(() =>
      getConsumetStream(server, searchTitle, episode, sub),
    );
    if (retry) return sendRetryable(retry, { hostDown });
    if (!data) return sendNotFound("Source not found");
    return sendOk(data);
  }

  return res.status(400).json({ error: "Unknown server" });
}

// Hard ceiling on the most CPU-expensive endpoint in the API. The internal
// fetches already cap at 3-5s each, so a healthy resolve finishes well under
// this; the limit exists to KILL a runaway invocation (provider in a redirect
// loop, cascading retries against a flapping anti-bot host) before it burns
// the whole Fluid Active CPU budget — a single bad day of those is what spikes
// the dashboard. 15s leaves room for the slowest legitimate multi-provider
// resolve while still cutting the pathological ones short.
export const config = {
  maxDuration: 15,
};
