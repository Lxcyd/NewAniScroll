// Stream extractors — pull direct M3U8/MP4 URLs from embed pages.
// Adapted from zuhaz/consumet.ts (github.com/zuhaz/consumet.ts).
// Returning real stream URLs lets us play in our own HLS player and bypass
// X-Frame-Options blocks (sendvid), referer issues, and ad-laden embed pages.

import * as crypto from "crypto";
import {
  VIDMOLY_CORE_DOMAINS,
  VIDMOLY_WHITE_LABEL_DOMAINS,
  VIDMOLY_HOST_RE,
} from "./players/vidmolyDomains.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Cloudflare Worker URL — used as a low-cost extraction proxy. Routing the
// embed-page fetches (Sibnet, Sendvid, Vidmoly, …)
// through the Worker means EXTRACTION runs from Cloudflare IPs, the same
// network the BROWSER uses for playback. That keeps any IP-bound tokens the
// upstream hands out valid for the subsequent segment fetches. Without this
// extraction happened on Vercel AWS IPs while playback went via Cloudflare —
// the mismatch made tokens get rejected mid-playback.
// Hardcoded default = the Cloudflare Worker (see UniversalPlayer for why we
// don't trust the env var here). Extraction fetches (anime-sama, etc.) run
// from Cloudflare IPs, matching the browser's playback network.
const WORKER_PROXY_URL = (
  process.env.NEXT_PUBLIC_PROXY_BASE ||
  "https://proxy.aniscroll.com"
).replace(/\/$/, "");

// Fetch wrapper that aborts after `ms` to avoid hung connections.
async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Route an extractor fetch through the Cloudflare Worker. The Worker forwards
// the Referer (auto-detected from the target host) and returns the upstream
// body verbatim, so our existing parsing logic doesn't need to change. Falls
// back to a direct fetch when the Worker URL isn't configured (local dev).
async function fetchViaWorker(targetUrl, options = {}, ms = 10000) {
  if (!WORKER_PROXY_URL) return fetchWithTimeout(targetUrl, options, ms);
  const refererHeader = options.headers?.Referer || options.headers?.referer || "";
  const proxied =
    `${WORKER_PROXY_URL}/?url=${encodeURIComponent(targetUrl)}` +
    (refererHeader ? `&referer=${encodeURIComponent(refererHeader)}` : "");
  // We strip the Referer header from the inner fetch — the Worker handles it
  // via the query param, and the browser block our setting Referer anyway.
  const { headers: rawHeaders, ...rest } = options;
  const headers = { ...(rawHeaders || {}) };
  delete headers.Referer;
  delete headers.referer;
  return fetchWithTimeout(proxied, { ...rest, headers }, ms);
}

/**
 * Extractor result shape:
 *   { streams: [{ url, quality, isM3U8, referer }], error?: string }
 * If extraction fails, returns { error: "..." } — caller should treat as broken.
 */

// ── Vidmoly (vidmoly.to / .net / .biz — and ansembed.net / voembed.net) ─────
// Their anti-bot blocks plain server-side fetches on some IPs and routes
// .to → ads. We try multiple domain variants + a full browser header set
// mimicking what Cat-Catch / JDownloader send; if all fail, caller falls
// back to the raw iframe.
//
// `ansembed.net` is Vidmoly under a white-label domain — the embed page is
// byte-for-byte a Vidmoly page (its own <title>, `cdn.staticmoly.me` assets,
// the vidmoly.me favicon) serving the same `…/hls2/…/master.m3u8`. anime-sama
// lists it as a SEPARATE player, so it is a real extra source per title. It is
// also reachable on networks where the vidmoly.* domains are DNS-blocked, which
// makes it the most reliable member of this family, hence FIRST in the list.
//
// `voembed.net` is the SAME arrangement for voir-anime: since ~2026-08 their
// "LECTEUR myTV" panel serves voembed.net instead of vidmoly.biz on newly
// published titles (verified on every episode linked from the homepage, and on
// sousou-no-frieren-2-vf), while the back catalogue still carries vidmoly.biz.
// Same embed page, same `…/hls2/…/master.m3u8`, and the slug resolves on the
// vidmoly.* mirrors too. Without it here, every migrated title lost its
// Voir-Anime chip — the host filter simply found no panel.
// Les marques blanches d'abord : ansembed porte les panneaux d'anime-sama et
// resiste aux listes de blocage. Les noms eux-memes vivent dans
// lib/players/vidmolyDomains.js — cf. ce fichier pour le pourquoi.
const VIDMOLY_DOMAINS = [...VIDMOLY_WHITE_LABEL_DOMAINS, ...VIDMOLY_CORE_DOMAINS];
// Every domain this family answers on — used both to swap domains on retry and
// to recognise an embed as Vidmoly's in `getExtractor`.
// Exported because the source route and the client-side extractor must agree on
// "is this the Vidmoly family?". They used to each test `url.includes("vidmoly")`,
// which silently answered NO for ansembed.net and sent it down the server-side
// extraction path — where the master token binds to OUR IP and every segment
// 410s in the user's browser.
export { VIDMOLY_HOST_RE };
const VIDMOLY_BROWSER_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Ch-Ua": '"Chromium";v="120", "Google Chrome";v="120"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

async function tryVidmolyDomain(embedUrl, domain, fetcher, label) {
  // Swap whichever domain of the family the embed came on. The old pattern only
  // matched `vidmoly.*`, so an ansembed embed could never be retried on the
  // other mirrors (and vice versa) — the URL went out unchanged and every
  // "retry" hit the same host.
  const url = embedUrl.replace(VIDMOLY_HOST_RE, domain);
  const t0 = Date.now();
  let res;
  try {
    res = await fetcher(
      url,
      {
        headers: { ...VIDMOLY_BROWSER_HEADERS, Referer: "https://anime-sama.to/" },
        redirect: "follow",
      },
      6000,
    );
  } catch (e) {
    console.error(`[vidmoly:${label}] ${domain} fetch failed (${Date.now() - t0}ms): ${e.message}`);
    return null;
  }
  if (!res.ok) {
    console.error(`[vidmoly:${label}] ${domain} HTTP ${res.status} (${Date.now() - t0}ms)`);
    return null;
  }
  const html = await res.text();
  const hasM3u8 = html.includes(".m3u8");
  console.log(`[vidmoly:${label}] ${domain} ${html.length}b m3u8=${hasM3u8} (${Date.now() - t0}ms)`);
  if (html.length < 500) return null;

  const patterns = [
    /file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
    /sources:\s*\[\s*\{[^}]*file:\s*['"]([^'"]+)['"]/,
    /<source\s+src=['"]([^'"]+\.m3u8[^'"]*)['"]/,
    /['"](https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)['"]/,
    /file:\s*['"]([^'"]+)['"]/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1] && m[1].startsWith("http")) {
      return { masterUrl: m[1], url };
    }
  }
  return null;
}

export async function extractVidmoly(embedUrl) {
  const t0 = Date.now();
  try {
    // Vidmoly's master m3u8 token is IP-bound: whichever IP fetched the
    // embed page gets a token only it can use for segments. So extraction
    // and playback MUST share an IP. We extract via the CF Worker and return
    // the raw masterUrl — the client's UniversalPlayer wraps it through
    // PROXY_BASE (the same Worker), so segment fetches share the Worker's IP.
    const tierWorker = async (domain) =>
      tryVidmolyDomain(embedUrl, domain, fetchViaWorker, "worker");

    for (const domain of VIDMOLY_DOMAINS) {
      const w = await tierWorker(domain);
      if (w) {
        console.log(`[vidmoly] HIT worker/${domain} (total ${Date.now() - t0}ms)`);
        return {
          streams: [{
            url: w.masterUrl,
            quality: "auto",
            isM3U8: w.masterUrl.includes(".m3u8"),
            referer: w.url,
          }],
        };
      }
    }

    console.error(`[vidmoly] EXHAUSTED all tiers for ${embedUrl} (total ${Date.now() - t0}ms)`);
    return { error: "vidmoly: no source found on any tier" };
  } catch (e) {
    console.error(`[vidmoly] threw for ${embedUrl} (total ${Date.now() - t0}ms): ${e.message}`);
    return { error: `vidmoly: ${e.message}` };
  }
}

// ── Sibnet (video.sibnet.ru) ─────────────────────────────────
// Browser-equivalent header set for Sibnet. The minimal "Mozilla/5.0" UA we
// used before triggers Sibnet's anti-bot on some Vercel POPs and returns an
// HTML shell that points at a different videoid (we saw 4413957 / 4339887
// served for Death Note instead of the real 4745xxx ids in eps3). Sending a
// full Chrome-style header set drops the trick rate considerably.
const SIBNET_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif," +
    "image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  "Sec-Ch-Ua":
    '"Chromium";v="131", "Google Chrome";v="131", "Not?A_Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  Referer: "https://video.sibnet.ru/",
};

/* Sibnet rate-limits by IP, hard: measured 2026-08-08 the throttle answers 429
   on EVERY page (even one that served a minute earlier) and had not lifted after
   40 minutes. So the scarce resource is the REQUEST COUNT, not the request rate,
   and the fix is to stop spending requests we already know will fail.
 *
 * On an egress where shell.php is refused, the old order cost three round trips
 * per episode — shell.php (403), the worker (which sibnet blocks outright,
 * ~5 s of dead wait), then the watch page that actually works. Two thirds of
 * that traffic was known-doomed from the second episode onward, and it is what
 * pushed a 48-cell batch over the limit.
 *
 * These two memos are per-PROCESS and deliberately not persisted: a block can
 * lift, and a stale "don't bother" on disk would keep a recovered host down. A
 * fresh run always re-probes once, pays one 403, and learns again. */
/* UN seul refus suffit. Deux paraissait prudent et ne l'etait pas : le bridge
   est un processus par plage d'episodes, donc le memo repart de zero toutes les
   quelques cellules et un seuil de 2 faisait payer le plein tarif a la moitie
   d'entre elles. Se tromper coute une page de visionnage — qui marche et qui est
   validee par looksGood ; ne pas se tromper economise deux requetes par episode
   sur un hote qui compte les requetes. */
const SIBNET_SKIP_AFTER_REFUSALS = 1;
let sibnetShellRefusals = 0;

/* Le refus d'egress ne parle pas qu'en 403.
 *
 * Le memo ci-dessus ne comptait que le 403, alors que le commentaire de
 * `extractSibnet` decrit deja le 400 comme la signature du blocage cote
 * Cloudflare (« 400 on the first hop, no redirect »). Mesure du 29/08/2026 :
 * depuis une ligne bloquee, sibnet rend 400 sur `shell.php` ET sur sa page
 * d'accueil, en 5,3 s — ce n'est donc pas une requete mal formee, c'est la
 * porte qui est fermee. Comme 400 n'etait pas compte, aucun memo ne se posait
 * et CHAQUE resolution repayait la cascade complete : `/api/v2/source` mettait
 * 11,8 s a rendre son 503 en production, spinner compris.
 * Un 400 sur une URL que nous avons construite nous-memes ne peut pas etre de
 * notre fait : on le traite comme le refus qu'il est. Le memo expire au bout de
 * 10 min et le moindre succes l'efface, donc se tromper ne coute qu'une page de
 * visionnage. */
const estRefusEgress = (status) => status === 403 || status === 400;

/* …mais ce memo doit EXPIRER, et il ne le faisait pas.
 *
 * Il etait un `let … = false` qu'on passait a `true` sans jamais le remettre :
 * un seul 403 — et le seuil est a 1 — condamnait shell.php pour toute la vie de
 * l'instance. Sur une fonction serverless tiede, ca peut durer des heures, et il
 * ne reste plus que la jambe de derniere chance ; la ou elle ne passe pas non
 * plus, sibnet est simplement mort sur cette instance.
 *
 * Mesure du 17/08/2026, six requetes paralleles sur dev (donc plusieurs
 * instances) pour le meme titre : certaines rendent un flux, d'autres echouent
 * en 0,25 s — trop vite pour avoir tente quoi que ce soit. Ce n'est pas l'hote
 * qui est capricieux, c'est l'HISTORIQUE de chaque instance. Prod, plus
 * frequentee donc plus renouvelee, n'avait pas le probleme : de quoi croire
 * longtemps a une difference d'egress entre les deux environnements.
 *
 * Un blocage d'egress est un etat, pas une verite — le devlog du 08/08 raconte
 * deja un sibnet qui « remarche ». Le memo se comporte donc maintenant comme le
 * throttle 429 juste en dessous : reaction immediate (un refus suffit), oubli au
 * bout de 10 minutes. Et un succes efface le compteur : c'est la preuve directe
 * que l'egress n'est pas ferme. */
const SIBNET_SHELL_BLOCK_MS = 10 * 60 * 1000;
let sibnetShellBlockedUntil = 0;
const sibnetShellBlocked = () => Date.now() < sibnetShellBlockedUntil;
/* Set the moment a 429 is seen anywhere. A throttled host is not a broken host:
   every caller must be able to tell "slow down" from "you are blocked", which is
   exactly the distinction the logs used to lose — both surfaced as
   `embed unreachable or decoy`. */
let sibnetThrottledUntil = 0;
const SIBNET_THROTTLE_COOLDOWN_MS = 5 * 60 * 1000;

function sibnetThrottled() {
  return Date.now() < sibnetThrottledUntil;
}
function noteSibnetStatus(status) {
  if (status === 429) {
    sibnetThrottledUntil = Date.now() + SIBNET_THROTTLE_COOLDOWN_MS;
    console.error("[sibnet] 429 — debit limite, pause de 5 min sur ce processus");
    return "throttled";
  }
  return null;
}

/* Budget de PAROI pour toute la cascade sibnet.
 *
 * Les trois jambes ci-dessous (shell.php -> worker -> page de visionnage) sont
 * sequentielles et plafonnees a 5 s chacune. Quand sibnet ne repond a aucune,
 * le total fait donc 15 s — exactement le `maxDuration` de /api/v2/source. La
 * route etait tuee par la plateforme AVANT de pouvoir formuler une reponse :
 * mesure du 17/08/2026 sur dev, `server=animesama-sibnet` rend un 504
 * FUNCTION_INVOCATION_TIMEOUT sur 6 cellules / 6 (aniId 21, 16498, 154587, VF
 * et VO), pendant que les six autres hotes repondent proprement.
 *
 * Un 504 est le pire des resultats possibles : il coute l'invocation entiere
 * (15 s de budget Fluid), il n'est pas cachable, et il n'apprend rien au client
 * — `requestSource` le classe "retry", donc la sonde recommence, re-paie 15 s,
 * et deux chips (sibnet VF + VO) monopolisent la moitie du pool de 4 pendant
 * ~33 s. C'est le « les lecteurs mettent une eternite » cote UI.
 *
 * Plafonnee a 10 s, la cascade rend `null` d'elle-meme et il reste ~5 s a la
 * route pour formuler un verdict propre et cachable.
 *
 * Note : le memo `sibnetShellBlocked` ne coupe la jambe worker que sur un 403
 * EXPLICITE. Quand la jambe directe expire (pas de reponse du tout), le memo
 * reste faux et les trois jambes sont payees plein tarif — c'est le cas mesure.
 *
 * Le partage n'est PAS uniforme, et c'est le point delicat : la jambe qui
 * marche sur un egress bloque est la TROISIEME (la page de visionnage — cf.
 * l'entree du 08/08). Un budget global simple l'aurait affamee, puisque les
 * deux premieres jambes le consomment avant elle : on aurait echange un 504
 * contre une regression silencieuse du seul chemin qui aboutit. Les deux
 * premieres jambes se partagent donc une enveloppe courte, et la derniere garde
 * une reserve qui lui est propre.
 */
/* Repartition revue le 17/08/2026 — le total ne bouge pas (10 s), sa decoupe si.
 *
 * Symptome : le chip « Anime-Sama Sibnet » manquait en VF sur une serie ou la
 * VF existe (aniId 177699, panel `saison1hs`, eps3 = sibnet videoid 6236560 —
 * verifie dans episodes.js, et le lecteur joue dans un navigateur).
 *
 * Mesure, meme requete, meme panel resolu des deux cotes :
 *   dev  (avec l'enveloppe) : ep1 503 a 5,28 s | ep2 503 a 5,19 s | ep3 OK
 *   prod (sans l'enveloppe) : ep1 OK a 4,81 s  | ep2 OK          | ep3 OK
 * Les autres titres passent sur dev en 2,2-2,9 s.
 *
 * Donc shell.php repond en ~2 a ~5 s depuis Vercel selon la video, et
 * l'enveloppe de 5 s tombait PILE dessus : la jambe qui allait aboutir etait
 * coupee quelques centaines de ms trop tot, l'hote etait declare injoignable, et
 * le chip disparaissait. Un « presque » transforme en absence.
 *
 * La jambe de derniere chance, elle, n'a jamais eu besoin de 5 s : mesuree a
 * ~0,2-0,3 s a chaque fois (c'est une page servie normalement, pas un tarpit).
 * On lui en prend 2,5 pour les donner a la premiere. Somme inchangee, donc pas
 * un gramme de risque de 504 en plus — c'etait tout l'objet de l'enveloppe. */
const SIBNET_PRELIM_BUDGET_MS = 7500; // shell.php + worker, ENSEMBLE
const SIBNET_LASTRESORT_MS = 2500;    // page de visionnage, reserve a elle seule

/* Enveloppe de bout en bout de `extractSibnet`, jambes CDN comprises.
 *
 * Les hops d'apres la cascade (resolution du 302, sonde du shard, repli sur un
 * autre shard) avaient chacun leur propre plafond — 5 s + 4 s + 4 s — sans
 * aucun rapport avec ce que la cascade venait deja de depenser. Pire cas
 * theorique : 10 + 13 = 23 s pour une route plafonnee a 15 s, c'est-a-dire le
 * 504 que l'enveloppe precedente cherchait justement a eviter, par une autre
 * porte. Ils partagent desormais une echeance commune. */
const SIBNET_TOTAL_MS = 13000;

async function fetchSibnetEmbed(embedUrl) {
  // Enveloppe commune aux deux premieres jambes seulement.
  const prelimDeadline = Date.now() + SIBNET_PRELIM_BUDGET_MS;
  const prelimLeft = () => prelimDeadline - Date.now();
  // Moins d'une demi-seconde restante : la jambe ne peut plus aboutir, et la
  // tenter ne ferait que depenser une requete chez un hote qui les COMPTE
  // (cf. le throttle 429 plus haut).
  const outOfPrelim = () => prelimLeft() < 500;

  // The "second number" in Sibnet's cvn URL (e.g. /44/13/95/4413957.mp4
  // for embed videoid=4745138) is NORMAL — it's an internal CDN file id,
  // unrelated to the embed videoid. Don't validate it. We only need to
  // confirm the embed page itself contains a player.src that points at
  // the videoid we asked for, which catches the "anti-bot served a default
  // page" case without rejecting legitimate redirects.
  const expectedId = (embedUrl.match(/videoid=(\d+)/) || [])[1];
  const looksGood = (html) => {
    const m = html.match(/player\.src\(\[\{src:\s*"([^"]+)"/);
    if (!m) return false;
    if (!expectedId) return true;
    const got = (m[1].match(/\/(\d+)\.mp4/) || [])[1];
    return got === expectedId;
  };

  if (sibnetThrottled()) {
    // Spending a request while throttled only extends the throttle.
    console.error(`[sibnet] throttle actif — ${embedUrl} non demande`);
    return null;
  }

  const t0 = Date.now();
  try {
    if (sibnetShellBlocked()) throw new Error("shell.php refuse sur cet egress (memo)");
    const res = await fetchWithTimeout(embedUrl, { headers: SIBNET_HEADERS }, prelimLeft());
    if (noteSibnetStatus(res.status)) return null;
    if (estRefusEgress(res.status)) {
      if (++sibnetShellRefusals >= SIBNET_SKIP_AFTER_REFUSALS && !sibnetShellBlocked()) {
        sibnetShellBlockedUntil = Date.now() + SIBNET_SHELL_BLOCK_MS;
        sibnetShellRefusals = 0;
        console.error(
          `[sibnet] shell.php refuse — page de visionnage seule pendant ${SIBNET_SHELL_BLOCK_MS / 60000} min`,
        );
      }
    }
    if (res.ok) {
      const html = await res.text();
      if (looksGood(html)) {
        // Preuve directe que l'egress n'est pas ferme : on repart de zero.
        sibnetShellRefusals = 0;
        sibnetShellBlockedUntil = 0;
        console.log(`[sibnet] OK direct ${embedUrl} (${Date.now() - t0}ms)`);
        return { html, via: "direct", pageUrl: embedUrl };
      }
      console.error(`[sibnet] direct mismatch ${embedUrl} (${Date.now() - t0}ms) — falling through`);
    } else {
      console.error(`[sibnet] direct HTTP ${res.status} for ${embedUrl} (${Date.now() - t0}ms)`);
    }
  } catch (e) {
    console.error(`[sibnet] direct failed for ${embedUrl} (${Date.now() - t0}ms): ${e.message}`);
  }

  /* Skipped once shell.php is known-refused: sibnet blocks Cloudflare egress
     outright, so this leg cannot succeed where the direct leg failed for an
     IP reason — it only buys a 5 s timeout per episode. */
  if (WORKER_PROXY_URL && !sibnetShellBlocked() && !outOfPrelim()) {
    const tw = Date.now();
    try {
      const res = await fetchViaWorker(embedUrl, { headers: SIBNET_HEADERS }, prelimLeft());
      if (res.ok) {
        const html = await res.text();
        if (looksGood(html)) {
          console.log(`[sibnet] OK worker ${embedUrl} (${Date.now() - tw}ms)`);
          return { html, via: "worker", pageUrl: embedUrl };
        }
      }
    } catch {}
    console.error(`[sibnet] worker failed for ${embedUrl} (${Date.now() - tw}ms)`);
  }

  /* Last resort: the WATCH page instead of the embed page.
     `shell.php` and `/video<ID>` are two views of one upload and carry the same
     `player.src`, but sibnet gates them separately — measured 2026-08-08 from a
     blocked line, shell.php answers 403 (every videoid, even one that does not
     exist —
     so it's the endpoint that's shut, not the videos) while /video<ID> answers
     200. Trying it costs one request on a path that was already failing, and it
     is the difference between a host that works and a host that is simply gone.
     `looksGood` still validates the videoid, so a decoy page can't slip through
     this door either. */
  if (expectedId) {
    const tv = Date.now();
    const watchUrl = `https://video.sibnet.ru/video${expectedId}`;
    try {
      const res = await fetchWithTimeout(watchUrl, { headers: SIBNET_HEADERS }, SIBNET_LASTRESORT_MS);
      if (noteSibnetStatus(res.status)) return null;
      if (res.ok) {
        const html = await res.text();
        if (looksGood(html)) {
          console.log(`[sibnet] OK watch-page ${watchUrl} (${Date.now() - tv}ms)`);
          return { html, via: "watch", pageUrl: watchUrl };
        }
      }
    } catch {}
    console.error(`[sibnet] watch page failed for ${watchUrl} (${Date.now() - tv}ms)`);
  }

  return null;
}

/* CDN shards that are known to honour a signed sibnet URL.
 *
 * The signature is NOT bound to a hostname: measured 2026-08-08, the very same
 * `st=`/`e=`/`stor=` query served a 206 from cvs111-2 and a 400 from dv97, for
 * two different files, minted from two different machines. The 302 hands each
 * client whichever shard sibnet's geo-routing picks, and some shards refuse
 * some networks — from Luc's line every redirect lands on dv97, which refuses
 * it, while Vercel is routed to cvs111-2 and plays.
 *
 * So a shard that says no is worth retrying elsewhere with the identical query.
 * This list is a fallback, never the first choice: the shard sibnet chose is
 * always tried first, and it is the right one for nearly every visitor.
 *
 * If sibnet retires cvs111-2 this goes stale and sibnet degrades to what it
 * does today on a blocked line — no worse. Refresh it by reading the `Location`
 * of a redirect from a machine where sibnet plays. */
const SIBNET_FALLBACK_SHARDS = ["cvs111-2.sibnet.ru"];

/**
 * Ask one shard for a single byte. Returns the usable URL, or null if the shard
 * refused, hung, or errored — a refusing shard often HANGS rather than answering,
 * so the short timeout is the point, not a detail.
 */
async function probeShard(url, headers, ms = 4000) {
  try {
    const res = await fetchWithTimeout(
      url,
      { method: "GET", headers, redirect: "follow" },
      ms,
    );
    if (res.ok || res.status === 206) return res.url || url;
  } catch {
    // Treated as a refusal — see above.
  }
  return null;
}

/**
 * Re-issue a refused shard URL against a known-good shard, path and query
 * untouched. Returns the working URL, or null if none answered — in which case
 * the caller keeps what it had and nothing is made worse.
 */
async function retryOnFallbackShard(refusedUrl, refererUrl, ms = 4000) {
  let target;
  try {
    target = new URL(refusedUrl);
  } catch {
    return null;
  }
  for (const shard of SIBNET_FALLBACK_SHARDS) {
    if (target.host === shard) continue; // that IS the shard that just refused
    const candidate = `https://${shard}${target.pathname}${target.search}`;
    const ok = await probeShard(
      candidate,
      { ...SIBNET_HEADERS, Referer: refererUrl, Range: "bytes=0-0" },
      ms,
    );
    if (ok) {
      console.log(`[sibnet] shard ${target.host} refused — rescued via ${shard}`);
      return ok;
    }
  }
  return null;
}

export async function extractSibnet(embedUrl) {
  // Echeance commune a TOUTES les jambes (cascade + hops CDN) : ce qu'il reste
  // du budget, plafonne par le maximum propre a chaque hop. Plancher a 500 ms —
  // en dessous, la jambe ne peut pas aboutir, mais un timeout de 0 la ferait
  // echouer en apparaissant comme un refus de l'hote.
  const deadline = Date.now() + SIBNET_TOTAL_MS;
  const left = (max) => Math.max(500, Math.min(max, deadline - Date.now()));
  try {
    // Sibnet blocks Cloudflare Worker IPs at the source (400 on the first
    // hop, no redirect) BUT — and this is the win — once we follow the
    // 302 chain (sibnet.ru → dv97 → cvnXX) to the final CDN URL, that
    // final URL is signed with a `noip=1` flag. That flag means:
    //   - any IP can fetch it (no IP binding)
    //   - no Referer required (verified: 206 from a fresh browser-style
    //     fetch with Referer: aniscroll.com AND with no Referer at all)
    //
    // So we resolve the chain server-side and hand the browser the final
    // cvn URL. Vidstack <video src> plays it directly — no Worker, no
    // proxy, no per-segment hops.
    const got = await fetchSibnetEmbed(embedUrl);
    /* `transient` separates the two failures that used to look identical to the
       caller, and the difference decides whether the chip disappears for 6h.
       Here we never GOT the page — direct and worker both refused — so we know
       nothing about whether this episode has a sibnet upload. Measured
       2026-08-08: sibnet answers 403 on shell.php from some egress IPs (Luc's
       residential line and Cloudflare; Vercel is fine, so production was never
       affected), which turned every sibnet episode into a "proven absence" on
       the blocked machine and cached it.
       Compare `no source found` below: there the page arrived and genuinely had
       no player.src, which IS evidence. */
    if (!got) {
      /* Name the throttle. "unreachable or decoy" for a 429 is how a rate limit
         spent an evening looking like a block — two opposite causes, one
         message, and the log could not tell "slow down" from "you are shut
         out". Both are transient; only one is worth waiting on. */
      /* `hostDown` : on ne dit pas « cet episode a echoue », on dit « cet HOTE
         nous refuse » — la difference que l'interface n'avait pas.
         Le SEUL fait qui le prouve est le throttle : un 429 porte sur l'egress
         entier, tous episodes confondus.
         `sibnetShellBlocked()` en etait aussi, et c'etait trop : ce memo est
         arme par UN SEUL 400/403 (SIBNET_SKIP_AFTER_REFUSALS = 1) pour dix
         minutes, et il ne coupe qu'UNE des deux jambes — la page de visionnage
         continue de resoudre, ce qu'on mesure encore le 29/08/2026 (200 en
         0,10 s pendant que le memo etait pose). En tirer « cet hote refuse
         tout » condamnait un lecteur qui marche, pour dix minutes, a l'echelle
         du lambda. */
      const hostDown = sibnetThrottled();
      return sibnetThrottled()
        ? { error: "sibnet: debit limite (429) — reessayer plus tard", transient: true, throttled: true, hostDown }
        : { error: "sibnet: embed unreachable or decoy", transient: true, hostDown };
    }
    const { html, via, pageUrl } = got;

    const m = html.match(/player\.src\(\[\{src:\s*"([^"]+)",\s*type:\s*"([^"]+)"/);
    if (!m) return { error: "sibnet: no source found" };

    const path = m[1];
    const initialUrl = path.startsWith("http") ? path : `https://video.sibnet.ru${path}`;

    /* Resolve the 302 chain in TWO steps rather than letting fetch follow it.
       `redirect: "manual"` costs one fast hop against video.sibnet.ru — which
       always answers us — and hands back the shard in `Location` BEFORE we
       commit to it. Following automatically looks simpler and is worse: when
       the chosen shard is one that refuses this network it does not refuse
       quickly, it hangs, and the whole request dies on the abort timeout with
       no response object at all. So we never learn which shard to retry, and
       the fallback below can never fire. That is exactly how it failed when
       measured on 2026-08-08. Range: bytes=0-0 keeps every probe to one byte. */
    let finalUrl = null;
    const shardHeaders = {
      ...SIBNET_HEADERS,
      /* `pageUrl`, not `embedUrl`: the Referer must be the page we ACTUALLY
         read, which is the watch page whenever shell.php was refused. Sending a
         shell.php Referer for a page we never got makes this hop answer 403
         instead of redirecting. */
      Referer: pageUrl || embedUrl,
      Range: "bytes=0-0",
    };
    /** Une jambe de resolution : le hop manuel, puis le shard. */
    const resolveShard = async (budget) => {
      try {
        const hop = await fetchWithTimeout(
          initialUrl,
          { method: "GET", headers: shardHeaders, redirect: "manual" },
          budget,
        );
        const location = hop.headers.get("location");
        const chosen = location
          ? new URL(location, "https://video.sibnet.ru").toString()
          : null;
        if (!chosen) return null;

        const direct = await probeShard(chosen, shardHeaders, left(4000));
        if (direct) return direct;
        /* The shard sibnet routed us to refuses this network. The signature
           is not bound to a hostname — measured, one identical
           `st`/`e`/`stor` query served 206 from cvs111-2 and 400 from dv97 —
           so the same URL on another shard is the same file, legitimately
           signed. */
        const rescued = await retryOnFallbackShard(
          chosen,
          pageUrl || embedUrl,
          left(4000),
        );
        return rescued || chosen; // no better option; let the caller try it
      } catch {
        return null;
      }
    };

    finalUrl = await resolveShard(left(5000));
    /* UNE SECONDE CHANCE, mais JAMAIS a credit.
       La premiere jambe herite de ce que la cascade a laisse — et `left()`
       plancher a 500 ms, ce qui ne suffit pas a un aller-retour transatlantique.
       Un echec la n'est donc pas la preuve que sibnet refuse : c'est souvent la
       preuve qu'on ne lui a pas laisse le temps de repondre.
       Elle est bornee par l'echeance commune et ne s'ouvre que s'il reste de
       quoi aboutir. Un forfait fixe ici, c'etait deborder les 13 s de
       `SIBNET_TOTAL_MS` et finir en FUNCTION_INVOCATION_TIMEOUT — la route
       entiere perdue (15 s de `maxDuration`), donc PIRE que l'echec qu'on
       cherchait a rattraper : mesure sur dev le 08/09/2026. */
    const reste = deadline - Date.now();
    if (!finalUrl && reste > 2500) finalUrl = await resolveShard(Math.min(3000, reste - 500));

    /* CE QUI NE DOIT JAMAIS PARTIR AU NAVIGATEUR : l'url de la grille.
       `https://video.sibnet.ru/v/<hash>/<id>.mp4` n'est pas un fichier, c'est le
       portail qui redirige vers un shard signe, et il exige un Referer sibnet —
       qu'un navigateur ne peut pas forger (mesure le 08/09/2026 : 403 sans
       Referer, 302 avec). L'ancien code la rendait quand meme, marquee
       `directUrl`, en pariant sur un « proxy qui prendrait le relais » qui
       n'existe pas pour un flux direct : le lecteur restait noir, puis la page
       basculait toute seule sur un autre hote. C'est exactement « sibnet ne
       charge pas, il change de lecteur tout seul ».
       Le shard, lui, est signe `noip=1` : n'importe quelle IP, sans Referer.
       Mieux vaut un echec franc, que la page traite en une seconde, qu'une url
       dont on sait qu'elle ne peut pas jouer. */
    if (!finalUrl || /(^|\/\/)video\.sibnet\.ru/i.test(finalUrl)) {
      return {
        error: "sibnet: portail non resolu (aucun shard signe)",
        transient: true,
      };
    }

    return {
      streams: [{
        url: finalUrl,
        quality: "default",
        isM3U8: m[2].includes("m3u8") || finalUrl.includes(".m3u8"),
        referer: null,
        directUrl: true, // browser plays the cvn URL straight — no proxy needed
        noCors: true,    // sibnet's CDN doesn't send Access-Control-Allow-Origin
        via,             // diagnostic only
      }],
    };
  } catch (e) {
    return { error: `sibnet: ${e.message}` };
  }
}

// ── Sendvid (sendvid.com) — bypasses X-Frame-Options ─────────
export async function extractSendvid(embedUrl) {
  const t0 = Date.now();
  try {
    const res = await fetchViaWorker(
      embedUrl,
      {
        headers: { "User-Agent": UA, Referer: "https://sendvid.com/" },
      },
      6000,
    );
    // 410 Gone = video supprimee (mesure du 01/11/2026 : 4 liens sur 51, le reste
    // de l'hote repondant) — une absence prouvee, comme le 404.
    if (res.status === 404 || res.status === 410) {
      console.error(`[sendvid] ${res.status} ${embedUrl} (${Date.now() - t0}ms)`);
      return { error: "sendvid: video removed" };
    }
    /* Meme contrat que sibnet plus haut : un echec de TRANSPORT n'est pas une
       preuve d'absence. Seul le 404 ci-dessus (« cette video a ete retiree ») en
       est une ; tout le reste veut dire qu'on n'a pas vu la page, donc qu'on ne
       sait rien de cet episode. Sans ce partage, le 31/08/2026 a coute tous les
       chips sendvid pour 6 h : sendvid.com repondait 502 sur TOUTES ses urls,
       page d'accueil comprise (verifie depuis deux reseaux, l'IP d'ici et le
       Worker Cloudflare), et chaque 502 etait publie comme « pas de source »
       puis mis en cache negatif — l'hote serait revenu que les chips seraient
       restes eteints.
       `hostDown` sur les 5xx et le 429 : ce sont des pannes/limites d'HOTE, pas
       d'episode — la page d'erreur est la meme pour tout le catalogue. */
    if (!res.ok) {
      console.error(`[sendvid] HTTP ${res.status} ${embedUrl} (${Date.now() - t0}ms)`);
      return {
        error: `sendvid HTTP ${res.status}`,
        transient: true,
        hostDown: res.status >= 500 || res.status === 429,
      };
    }
    const html = await res.text();
    // La meme panne, servie en 200 : sendvid remplace la page d'embed par un
    // ecran « We are experiencing technical difficulties » (1 146 octets, sans
    // player). Sans ce test, elle ressort en « no source found » — c'est-a-dire
    // en absence prouvee, exactement ce que le 502 vient d'eviter.
    if (/Technical Difficulties/i.test(html) && html.length < 4000) {
      console.error(`[sendvid] maintenance page ${embedUrl} (${Date.now() - t0}ms)`);
      return { error: "sendvid: page de maintenance", transient: true, hostDown: true };
    }

    let videoUrl = null;
    const sourceMatch = html.match(/<source\s+src="([^"]+)"\s+type="video\/mp4"/);
    if (sourceMatch) videoUrl = sourceMatch[1];

    if (!videoUrl) {
      const varMatch = html.match(/var\s+video_source\s*=\s*"([^"]+)"/);
      if (varMatch) videoUrl = varMatch[1];
    }
    if (!videoUrl) {
      const ogMatch = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/);
      if (ogMatch) videoUrl = ogMatch[1];
    }
    if (!videoUrl) {
      console.error(`[sendvid] no source ${embedUrl} (${Date.now() - t0}ms, ${html.length}b)`);
      return { error: "sendvid: no source found" };
    }

    // Sendvid plays DIRECT from its CDN — no proxy. Confirmed by the user: the
    // direct path is dramatically faster than routing through the Worker (the
    // proxy adds a hop AND the CDN throttles the proxied pull to rate=250k). The
    // signed URL carries `ip=<extractor>` but the sendvid CDN does NOT hard-bind
    // on it for real browsers — datacenter IPs (our curl probes) get 403, but a
    // residential viewer plays fine, so we serve the direct URL. `noCors` because
    // the CDN sends no CORS headers; the trade-off is HoverPreview is disabled
    // for Sendvid (canvas would taint) — acceptable, speed matters more here.
    // referer:null so the <video> sends no Referer (no-referrer set on the
    // element for direct streams); the CDN doesn't gate on Referer either.
    console.log(
      `[sendvid] OK ${embedUrl} → ${videoUrl.slice(0, 80)}… (direct, ${Date.now() - t0}ms)`,
    );
    return {
      streams: [{
        url: videoUrl,
        quality: "default",
        isM3U8: videoUrl.includes(".m3u8"),
        referer: null,
        directUrl: true,
        noCors: true,
      }],
    };
  } catch (e) {
    // Timeout / DNS / socket : on n'a pas atteint la page. Transitoire, comme
    // les 5xx ci-dessus — jamais une absence.
    console.error(`[sendvid] threw ${embedUrl} (${Date.now() - t0}ms): ${e.message}`);
    return { error: `sendvid: ${e.message}`, transient: true };
  }
}

// ── Megaplay (megaplay.buzz/stream/{mal,ani}/<id>/<ep>/<sub|dub>) ────
// The caller builds the URL and tries the MAL route first, the AniList route
// second (both live — the old "ani route times out / was retired" note was
// stale: /stream/ani/<aniListId>/… resolves the same file in <0.5s).
// Megaplay is HiAnime/AniWatch's MegaCloud-derivative. Two things to know:
//   1. megaplay.buzz sits behind Cloudflare, which 403s/challenges Vercel's
//      AWS datacenter IPs — a DIRECT server-side fetch works locally (or from
//      any residential IP) but fails intermittently in prod, which is why the
//      chip "often" disappeared even though the video exists. So we fetch via
//      the CF Worker (fetchViaWorker), the same fix anime-sama needed: the
//      request then runs from Cloudflare's own network and gets through. The
//      Worker auto-sets Referer: https://megaplay.buzz/ (worker detectReferer),
//      which is all Megaplay needs — no manual Referer/X-Requested-With header
//      is required (verified live through the Worker). We keep a direct-fetch
//      fallback for local dev where WORKER_PROXY_URL may be unset.
//   2. The embed page contains `data-id="<fileId>"` in the player div. That
//      file ID is what /stream/getSources?id=<id> uses to return JSON with
//      a clean m3u8 + a list of subtitle tracks.
//
// JSON shape:
//   {
//     sources: { file: "https://cdn.mewstream.buzz/.../master.m3u8" },
//     tracks: [
//       { file: "...subtitles/eng-2.vtt", label: "English", kind: "captions", default: true },
//       { file: "...subtitles/fre-12.vtt", label: "French", kind: "captions" },
//       ...
//     ]
//   }
//
// Subtitle track labels come from upstream players as full English names
// ("French", "Spanish (Latin America)", "Portuguese - Brazil"). Our subtitle
// auto-select compares against BCP47 codes ("fr", "es", "pt"), so we need
// to translate. The previous `label.slice(0, 5).toLowerCase()` shortcut
// produced "engli" / "frenc" — nothing matched and we always fell through
// to the first track, ignoring the user's French/English defaults.
const LANG_NAME_TO_CODE = {
  english: "en",
  french: "fr",
  spanish: "es",
  portuguese: "pt",
  german: "de",
  italian: "it",
  russian: "ru",
  japanese: "ja",
  chinese: "zh",
  korean: "ko",
  arabic: "ar",
  dutch: "nl",
  polish: "pl",
  turkish: "tr",
  swedish: "sv",
  thai: "th",
  vietnamese: "vi",
  indonesian: "id",
  hungarian: "hu",
  czech: "cs",
  greek: "el",
  hebrew: "he",
  hindi: "hi",
  romanian: "ro",
  ukrainian: "uk",
  finnish: "fi",
  norwegian: "no",
  danish: "da",
  bulgarian: "bg",
  croatian: "hr",
  serbian: "sr",
  slovak: "sk",
  slovenian: "sl",
  catalan: "ca",
  malay: "ms",
  filipino: "tl",
  tagalog: "tl",
};

function subtitleLabelToCode(label) {
  if (!label) return "en";
  // Already looks like a code? ("en", "fr", "en-US", "pt-BR")
  if (/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(label)) return label.toLowerCase();
  // Strip parens / brackets / dashes / colons, take first word.
  const first = label
    .toLowerCase()
    .replace(/[\[(].*?[\])]/g, "")
    .split(/[\s\-_:/]+/)[0]
    ?.trim();
  if (!first) return "en";
  return LANG_NAME_TO_CODE[first] || first.slice(0, 2);
}

/* Clef et IV recopies tels quels de leur `lib/newclient.min.js` public (cf. le
   pave de la branche megaplay de pages/api/v2/source). Leur `O(a, 32)` prend la
   chaine de 16 octets et la COMPLETE DE ZEROS a 32 : c'est de l'AES-256 avec une
   clef de 16 octets utiles, et se tromper la-dessus rend un binaire illisible
   plutot qu'une erreur — d'ou la verification JSON stricte en sortie.
   Un seul exemplaire, partage par la route et par le detecteur OP/ED : le jour
   ou megaplay change la clef, une copie oubliee casserait en silence (c'est ce
   qui est arrive a `extractMegaplay` entre le 20/09 et le 28/09). */
const MEGAPLAY_ENC_IV = Buffer.from("W0;27ToaUpl_P%'c", "utf8");
const MEGAPLAY_ENC_KEY = Buffer.alloc(32);
Buffer.from("i?LMTAx0Q6,:}50U", "utf8").copy(MEGAPLAY_ENC_KEY, 0);

/** Le `enc` de getSources -> l'URL du master, ou `null` s'il ne s'ouvre pas. */
export function ouvreEncMegaplay(enc) {
  if (typeof enc !== "string" || !enc) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-cbc", MEGAPLAY_ENC_KEY, MEGAPLAY_ENC_IV);
    /* Padding desactive : leur bourrage n'est pas du PKCS#7 valide (on a vu des
       octets 0x06 en queue d'un bloc plein), donc `final()` jetterait sur un
       dechiffrement pourtant correct. On coupe sur la derniere accolade plutot
       que de faire confiance a la queue. */
    d.setAutoPadding(false);
    const clair = Buffer.concat([d.update(enc.replace(/-/g, "+").replace(/_/g, "/"), "base64"), d.final()])
      .toString("utf8");
    const fin = clair.lastIndexOf("}");
    if (fin < 0) return null;
    const fichier = JSON.parse(clair.slice(0, fin + 1))?.file;
    return typeof fichier === "string" && /^https:\/\/\S+\.m3u8$/.test(fichier)
      ? fichier
      : null;
  } catch {
    return null;
  }
}

// Fetch a megaplay.buzz URL via the CF Worker (bypasses the Cloudflare block on
// Vercel's datacenter IPs), falling back to a direct fetch when the Worker is
// unreachable/unset (local dev) or errors. The Worker proxies the JSON/HTML
// verbatim and sets the megaplay Referer itself, so no extra headers are needed.
async function fetchMegaplay(url, ms = 10000) {
  const direct = () =>
    fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://megaplay.buzz/",
        },
      },
      ms,
    );
  if (!WORKER_PROXY_URL) return direct();
  try {
    const res = await fetchViaWorker(url, {}, ms);
    if (res.ok) return res;
    // Worker returned an upstream error wrapper — try once more directly in
    // case the Worker edge itself is degraded rather than megaplay.
    return await direct();
  } catch {
    return direct();
  }
}

// No token expiry on the m3u8 — segments validate by Referer only.
export async function extractMegaplay(embedUrl) {
  try {
    // Step 1: fetch the embed page (via Worker → CF network, so Cloudflare
    // doesn't 403 the datacenter IP).
    const pageRes = await fetchMegaplay(embedUrl);
    if (!pageRes.ok) return { error: `megaplay HTTP ${pageRes.status}` };
    const html = await pageRes.text();

    // The error page has <title>Error - MegaPlay</title>; valid pages have
    // <title>File 1234 - MegaPlay</title>. This is the ONE genuine "no source
    // for this episode" verdict — `absent: true` tells the caller it's safe to
    // negative-cache. Every OTHER failure below is transient (upstream down,
    // anti-bot, timeout) and must NOT be cached as absent, or one flaky scrape
    // hides the Megaplay chip for the whole 6h availability-snapshot TTL.
    if (/Error - MegaPlay/i.test(html) || /We can't find the file/i.test(html)) {
      return { error: "megaplay: file not found", absent: true };
    }

    // Step 2: pull the internal file ID from `data-id="..."` on the player div.
    const idMatch = html.match(/data-id="(\d+)"/);
    if (!idMatch) return { error: "megaplay: data-id not in page" };
    const fileId = idMatch[1];

    // Step 3: fetch the JSON sources endpoint (same Worker route). getSources
    // returns the same JSON with the Worker's default megaplay Referer — the
    // per-request Referer/X-Requested-With headers aren't required (verified).
    const apiRes = await fetchMegaplay(
      `https://megaplay.buzz/stream/getSources?id=${fileId}`,
    );
    if (!apiRes.ok) return { error: `megaplay API HTTP ${apiRes.status}` };
    let data;
    try {
      data = JSON.parse(await apiRes.text());
    } catch (e) {
      return { error: `megaplay: API JSON parse (${e.message})` };
    }

    /* `sources.file` en clair a disparu de leur reponse ; le master est
       desormais chiffre dans `enc`. Le clair reste lu en premier au cas ou il
       reviendrait. */
    const m3u8 = data?.sources?.file || ouvreEncMegaplay(data?.enc);
    if (!m3u8) return { error: "megaplay: ni source.file ni enc lisible dans la reponse" };

    const subtitles = (data?.tracks || [])
      .filter((t) => t?.kind === "captions" || t?.kind === "subtitles")
      .map((t) => ({
        file: t.file,
        label: t.label || t.lang || "Subtitle",
        // Map "English" → "en", "French" → "fr", etc. so the player's
        // default-track picker can compare against BCP47 prefs.
        language: subtitleLabelToCode(t.lang || t.label),
        kind: t.kind || "captions",
        default: !!t.default,
      }));

    return {
      streams: [
        {
          url: m3u8,
          quality: "auto",
          isM3U8: m3u8.includes(".m3u8"),
          referer: "https://megaplay.buzz/",
        },
      ],
      subtitles,
    };
  } catch (e) {
    return { error: `megaplay: ${e.message}` };
  }
}

// ── Generic JWPlayer-style embeds ────────────────────────────
export async function extractGenericJwplayer(embedUrl) {
  try {
    const origin = new URL(embedUrl).origin;
    // Direct fetch — these hosts allow our IP, and tokens bind to the same IP.
    const res = await fetchWithTimeout(
      embedUrl,
      { headers: { "User-Agent": UA, Referer: origin }, redirect: "follow" },
      10000
    );
    if (!res.ok) return { error: `embed HTTP ${res.status}` };
    const html = await res.text();

    const patterns = [
      /file\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
      /file\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/,
      /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*['"]([^'"]+)['"]/,
      /source\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
      /['"]?(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)['"]?/,
    ];
    let url = null;
    for (const p of patterns) {
      const m = html.match(p);
      if (m && m[1]) { url = m[1]; break; }
    }
    if (!url) return { error: "embed: no stream found" };

    return {
      streams: [{
        url,
        quality: "auto",
        isM3U8: url.includes(".m3u8"),
        referer: embedUrl,
      }],
    };
  } catch (e) {
    return { error: `embed: ${e.message}` };
  }
}

// ── Uqload (uqload.is / uqload.net / uqload.to / uqload.com) ─────────────────
// Standard file-locker player: the JWPlayer setup with the HLS `file:` URL is
// hidden inside a Dean-Edwards P.A.C.K.E.R block (`eval(function(p,a,c,k,e,d){…`).
// We unpack it WITHOUT executing remote code (pure string substitution) and
// read the `file:` source. The master m3u8 plays with or without a Referer and
// isn't hard IP-bound (verified on SnK ep3), so it's safe to serve direct.

/**
 * Reverse a Dean-Edwards P.A.C.K.E.R payload to its original source string.
 * Deterministic (no eval of untrusted code): rebuilds the base-`a` symbol table
 * and substitutes every token. Returns null when the block isn't a packer.
 */
function unpackPacker(packedBlock) {
  const m = packedBlock.match(
    /\}\s*\(\s*'(.*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*?)'\.split\('\|'\)/s,
  );
  if (!m) return null;
  let [, payload, radixS, countS, keysS] = m;
  const radix = parseInt(radixS, 10);
  let count = parseInt(countS, 10);
  const keys = keysS.split("|");
  payload = payload.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  const encode = (n) =>
    (n < radix ? "" : encode(Math.floor(n / radix))) +
    ((n = n % radix) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  const dict = {};
  while (count--) dict[encode(count)] = keys[count] || encode(count);
  return payload.replace(/\b\w+\b/g, (w) => (w in dict ? dict[w] : w));
}

export async function extractUqload(embedUrl) {
  const t0 = Date.now();
  try {
    // CRITICAL: uqload gates the embed on the EMBEDDING site's Referer. With
    // its own domain as Referer it returns a 38-byte "Video embed restricted
    // for this domain" stub (no packer). Sending the anime-sama Referer (the
    // site that hosts the iframe) returns the real player page. A plain fetch
    // from our IP works — no Worker needed.
    const res = await fetchWithTimeout(
      embedUrl,
      {
        headers: {
          "User-Agent": UA,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
          Referer: "https://anime-sama.to/",
        },
        redirect: "follow",
      },
      10000,
    );
    if (res.status === 404) return { error: "uqload: video removed" };
    if (!res.ok) return { error: `uqload HTTP ${res.status}` };
    const html = await res.text();
    if (/embed restricted/i.test(html)) {
      return { error: "uqload: embed restricted for this domain" };
    }

    // Grab the packer block and unpack it, then read the JWPlayer `file:` src.
    const packed = html.match(
      /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\.split\('\|'\)[\s\S]*?\)\)/,
    );
    let url = null;
    if (packed) {
      const unpacked = unpackPacker(packed[0]);
      if (unpacked) {
        const f =
          unpacked.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/) ||
          unpacked.match(/file\s*:\s*["']([^"']+)["']/) ||
          unpacked.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
        if (f) url = f[1] || f[0];
      }
    }
    // Fallback: some variants expose the source unpacked in the raw HTML.
    if (!url) {
      const raw = html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
      if (raw) url = raw[0];
    }
    if (!url) {
      console.error(`[uqload] no source ${embedUrl} (${Date.now() - t0}ms, ${html.length}b)`);
      return { error: "uqload: no source found" };
    }

    console.log(`[uqload] OK ${embedUrl} → ${url.slice(0, 80)}… (${Date.now() - t0}ms)`);
    return {
      streams: [{
        url,
        quality: "auto",
        isM3U8: url.includes(".m3u8"),
        // The CDN accepts the pull with or without a Referer; send uqload's to
        // be safe (harmless when unused).
        referer: "https://uqload.is/",
      }],
    };
  } catch (e) {
    console.error(`[uqload] threw ${embedUrl} (${Date.now() - t0}ms): ${e.message}`);
    return { error: `uqload: ${e.message}` };
  }
}

// Map a host string → extractor function
export function getExtractor(url) {
  const lower = url.toLowerCase();
  // ansembed.net / voembed.net are Vidmoly white-labelled — same page, same
  // m3u8 (see VIDMOLY_DOMAINS). Without this they fell through to the generic
  // JW Player extractor, losing the domain-retry and Worker tiers.
  if (VIDMOLY_HOST_RE.test(lower))                     return extractVidmoly;
  if (lower.includes("sibnet"))                        return extractSibnet;
  if (lower.includes("uqload"))                        return extractUqload;
  if (lower.includes("sendvid"))                       return extractSendvid; // rallume le 01/11/2026
  /* Les aiguillages vers megaplay, embed4me/lpayer, voe et
     movearnpre/dingtezuni/callistanise/smoothpre ont ete retires le
     20/09/2026 (cf. lib/servers.js et EXTRACTABLE_HOSTS). megaplay passe par
     son propre chemin dans /api/v2/source. Les extracteurs embed4me,
     oneupload, movearnpre et voe ont ete supprimes le 20/11/2026 : Luc a
     tranche qu'ils ne reviendraient pas (lib/lecteurs.json). */
  return extractGenericJwplayer;
}
