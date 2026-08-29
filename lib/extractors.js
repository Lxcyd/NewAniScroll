// Stream extractors — pull direct M3U8/MP4 URLs from embed pages.
// Adapted from zuhaz/consumet.ts (github.com/zuhaz/consumet.ts).
// Returning real stream URLs lets us play in our own HLS player and bypass
// X-Frame-Options blocks (sendvid), referer issues, and ad-laden embed pages.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Cloudflare Worker URL — used as a low-cost extraction proxy. Routing the
// embed-page fetches (Sibnet, Sendvid, Vidmoly, Smoothpre/Movearnpre, …)
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
const VIDMOLY_DOMAINS = [
  "ansembed.net",
  "voembed.net",
  "vidmoly.net",
  "vidmoly.to",
  "vidmoly.biz",
];
// Every domain this family answers on — used both to swap domains on retry and
// to recognise an embed as Vidmoly's in `getExtractor`.
// Exported because the source route and the client-side extractor must agree on
// "is this the Vidmoly family?". They used to each test `url.includes("vidmoly")`,
// which silently answered NO for ansembed.net and sent it down the server-side
// extraction path — where the master token binds to OUR IP and every segment
// 410s in the user's browser.
export const VIDMOLY_HOST_RE =
  /(vidmoly\.(?:to|biz|net)|ansembed\.net|voembed\.net)/i;
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
         nous refuse ». La difference est celle que l'interface n'avait pas.
         Un echec d'episode laisse le chip peint — regle du 17/08, et elle est
         bonne : un 503 isole ne prouve pas qu'un lecteur est mort. Mais quand
         le memo d'egress ou le throttle sont poses, on a la preuve positive que
         l'hote refuse TOUT, quel que soit l'episode (mesure du 29/08/2026 :
         sibnet rend le meme 503 sur quatre couples anime/episode differents).
         Continuer a proposer le chip revient alors a offrir un choix qui ne
         peut pas aboutir, et a deplacer le spectateur des qu'il le prend. */
      const hostDown = sibnetShellBlocked() || sibnetThrottled();
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
    let finalUrl = initialUrl;
    const shardHeaders = {
      ...SIBNET_HEADERS,
      /* `pageUrl`, not `embedUrl`: the Referer must be the page we ACTUALLY
         read, which is the watch page whenever shell.php was refused. Sending a
         shell.php Referer for a page we never got makes this hop answer 403
         instead of redirecting. */
      Referer: pageUrl || embedUrl,
      Range: "bytes=0-0",
    };
    try {
      const hop = await fetchWithTimeout(
        initialUrl,
        { method: "GET", headers: shardHeaders, redirect: "manual" },
        left(5000),
      );
      const location = hop.headers.get("location");
      const chosen = location
        ? new URL(location, "https://video.sibnet.ru").toString()
        : null;

      if (chosen) {
        const direct = await probeShard(chosen, shardHeaders, left(4000));
        if (direct) {
          finalUrl = direct;
        } else {
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
          if (rescued) finalUrl = rescued;
          else finalUrl = chosen; // no better option; let the caller try it
        }
      } else if (hop.ok || hop.status === 206) {
        finalUrl = hop.url || initialUrl;
      }
    } catch {
      // Fall back to the un-resolved URL — the worker / proxy chain will
      // pick up the slack (slow but functional).
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
    if (res.status === 404) {
      console.error(`[sendvid] 404 ${embedUrl} (${Date.now() - t0}ms)`);
      return { error: "sendvid: video removed" };
    }
    if (!res.ok) {
      console.error(`[sendvid] HTTP ${res.status} ${embedUrl} (${Date.now() - t0}ms)`);
      return { error: `sendvid HTTP ${res.status}` };
    }
    const html = await res.text();

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
    console.error(`[sendvid] threw ${embedUrl} (${Date.now() - t0}ms): ${e.message}`);
    return { error: `sendvid: ${e.message}` };
  }
}

// ── Embed4Me (lpayer.embed4me.com) — AES-CBC decryption ──────
// Their player fetches /api/v1/video?id=<id>, server returns hex-encoded
// AES-CBC ciphertext with hardcoded key/IV. Decrypts to JSON containing
// the source m3u8.
import * as crypto from "crypto";

const EMBED4ME_KEY = Buffer.from("kiemtienmua911ca", "utf8");
const EMBED4ME_IV = Buffer.from("1234567890oiuytr", "utf8");

function aesCbcDecrypt(hexStr, key, iv) {
  const data = Buffer.from(hexStr, "hex");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export async function extractEmbed4me(embedUrl) {
  try {
    // ID is in fragment (#) or ?id= query
    let m = embedUrl.match(/#([a-zA-Z0-9]+)/);
    if (!m) m = embedUrl.match(/[?&]id=([a-zA-Z0-9]+)/);
    if (!m) return { error: "embed4me: no id in URL" };
    const id = m[1];

    const apiUrl = `https://lpayer.embed4me.com/api/v1/video?id=${id}&w=1920&h=1080&r=https://lpayer.embed4me.com/`;
    // Route via Worker — embed4me IP-binds its decrypted m3u8 token to the
    // caller IP. Doing the API call from Cloudflare (same network the player
    // uses for segment playback) keeps the token valid end-to-end.
    const res = await fetchViaWorker(
      apiUrl,
      {
        headers: {
          "User-Agent": UA,
          Referer: "https://lpayer.embed4me.com/",
        },
      },
      10000
    );
    if (!res.ok) return { error: `embed4me HTTP ${res.status}` };
    let hex = (await res.text()).trim();
    if (hex.startsWith('"') && hex.endsWith('"')) hex = hex.slice(1, -1);

    let json;
    try {
      const dec = aesCbcDecrypt(hex, EMBED4ME_KEY, EMBED4ME_IV);
      json = JSON.parse(dec);
    } catch (e) {
      return { error: `embed4me: decrypt failed (${e.message})` };
    }
    const source = json?.source;
    if (!source) return { error: "embed4me: no source in payload" };
    // Embed4me allows our IP — return the raw URL; client will wrap through
    // our local /api/v2/proxy/m3u8 which fetches directly with proper Referer.
    return {
      streams: [{
        url: source,
        quality: "auto",
        isM3U8: source.includes(".m3u8"),
        referer: "https://lpayer.embed4me.com/",
      }],
    };
  } catch (e) {
    return { error: `embed4me: ${e.message}` };
  }
}

// ── OneUpload (oneupload.to) — JWPlayer config in <script> ───
export async function extractOneupload(embedUrl) {
  try {
    const res = await fetchWithTimeout(
      embedUrl,
      { headers: { "User-Agent": UA, Referer: new URL(embedUrl).origin + "/" }, redirect: "follow" },
      10000
    );
    if (!res.ok) return { error: `oneupload HTTP ${res.status}` };
    const html = await res.text();
    const m = html.match(/file\s*:\s*['"](https?:\/\/[^'"]+)['"]/);
    if (!m) return { error: "oneupload: no source found" };
    return {
      streams: [{
        url: m[1],
        quality: "auto",
        isM3U8: m[1].includes(".m3u8"),
        referer: embedUrl,
      }],
    };
  } catch (e) {
    return { error: `oneupload: ${e.message}` };
  }
}

// ── Movearnpre / Dingtezuni / Callistanise — packed JS ────────
// Players using `eval(function(p,a,c,k,e,d){...})` packing.
function unpackPackedJs(packed, base, count, words) {
  const toBase = (num, b) => {
    if (num === 0) return "0";
    let out = "";
    while (num > 0) {
      const r = num % b;
      out = (r < 10 ? r.toString() : String.fromCharCode(97 + r - 10)) + out;
      num = Math.floor(num / b);
    }
    return out;
  };
  // Build replacement map: short token → full word
  const map = new Map();
  for (let i = 0; i < count && i < words.length; i++) {
    if (words[i]) map.set(toBase(i, base), words[i]);
  }
  // Sort keys longest-first to avoid partial replacements
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  let out = packed;
  for (const k of keys) {
    out = out.replace(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), map.get(k));
  }
  return out;
}

function extractPackedCode(html) {
  const m = html.match(
    /eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)\)\)/s
  );
  if (!m) return null;
  return {
    packed: m[1],
    base: parseInt(m[2], 10),
    count: parseInt(m[3], 10),
    words: m[4].split("|"),
  };
}

export async function extractMovearnpre(embedUrl) {
  try {
    const origin = new URL(embedUrl).origin;
    // The playback CDN (dramiyos-cdn / acek-cdn / mindbodywellness.space)
    // blocks Cloudflare Worker IPs outright (responds 530). Extract direct
    // from the Vercel function and flag the stream so playback goes through
    // the Vercel-side proxy — same AWS IP pool from end to end.
    const res = await fetchWithTimeout(
      embedUrl,
      { headers: { "User-Agent": UA, Referer: origin }, redirect: "follow" },
      10000
    );
    if (!res.ok) return { error: `movearnpre HTTP ${res.status}` };
    const html = await res.text();

    const pk = extractPackedCode(html);
    if (!pk) return { error: "movearnpre: no packed code" };
    const unpacked = unpackPackedJs(pk.packed, pk.base, pk.count, pk.words);

    // The unpacked JWPlayer config exposes multiple HLS sources, e.g.
    //   var links = {
    //     "hls2": "https://eXXX.dramiyos-cdn.com/.../master.m3u8?t=...",  ← REAL VIDEO
    //     "hls3": "https://eXXX.mindbodywellness.space/.../master.txt",   ← fallback
    //     "hls4": "/stream/.../master.m3u8"                                ← TIKTOK IMAGE TRAP
    //   };
    //   sources: [{ file: links.hls4 || links.hls3 || links.hls2 }]
    //
    // The relative /stream/ path is a poisoned playlist that serves TikTok
    // image URLs in place of .ts segments — anti-bot/server-side scraping
    // detection. We must prefer the absolute https:// CDN URL ("hls2"),
    // which carries a signed token that's valid for ~1.5h.
    //
    // Preference order: hls2 (signed CDN m3u8) → hls (any external https
    // m3u8) → hls3 (.txt master, sometimes works) → hls4 (last resort,
    // likely poisoned but caller can still try).
    const linkRegex =
      /['"](hls\d?)['"]\s*:\s*['"]([^'"]+\.(?:m3u8|txt)[^'"]*)['"]/g;
    const linkMap = new Map();
    let mm;
    while ((mm = linkRegex.exec(unpacked)) !== null) {
      linkMap.set(mm[1], mm[2]);
    }

    let chosen = null;
    for (const key of ["hls2", "hls", "hls3", "hls4"]) {
      const v = linkMap.get(key);
      if (!v) continue;
      // Skip the relative /stream/ poisoned path
      if (v.startsWith("/")) continue;
      chosen = { key, url: v };
      break;
    }

    // Legacy fallback: if no link map matched, look for any absolute m3u8
    // (covers older variants of the embed page format).
    if (!chosen) {
      const anyAbs = unpacked.match(
        /['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/
      );
      if (anyAbs) chosen = { key: "abs", url: anyAbs[1] };
    }

    if (!chosen) return { error: "movearnpre: no usable absolute m3u8 (only /stream/ trap)" };

    const masterUrl = chosen.url;
    const referer = origin + "/";

    // Direct-CDN probe (CORS). hls.js fetches every manifest AND every segment
    // with credentials-less CORS, so the CDN must answer with an
    // Access-Control-Allow-Origin header on a cross-origin request or the
    // browser blocks the read. We already know the token isn't IP-bound (these
    // streams play fine through the Worker, a different IP than the viewer). So
    // if the CDN also reflects CORS, the browser can pull segments straight
    // from the CDN — no Worker hop, instant seeks. Probe with an Origin header
    // mimicking a browser; a wildcard or reflected ACAO means direct is safe.
    // On any doubt we fall through to the proxied path (correctness over speed).
    let hlsDirect = false;
    try {
      const cors = await fetchWithTimeout(
        masterUrl,
        {
          method: "GET",
          headers: {
            "User-Agent": UA,
            Referer: referer,
            Origin: "https://aniscroll.app",
            Range: "bytes=0-0",
          },
        },
        4000,
      );
      const acao = cors.headers.get("access-control-allow-origin");
      hlsDirect =
        (cors.ok || cors.status === 206) &&
        !!acao &&
        (acao === "*" || acao === "https://aniscroll.app");
      try { cors.body?.cancel?.(); } catch { /* already drained */ }
    } catch {
      // Probe failed → keep proxied path.
    }

    // .txt master playlists (hls3) are sometimes served as text/plain but
    // contain valid HLS — let the client treat them as m3u8.
    const isM3u8Like = masterUrl.includes(".m3u8") || masterUrl.includes(".txt");

    // Skip the variant probe when the URL is already a variant playlist
    // (smoothpre often returns `index-v1-a1.m3u8` which IS a media playlist
    // — no #EXT-X-STREAM-INF inside, just segments). In that case fetching
    // it just to discover that fact wastes 500ms-1s of latency. Heuristic:
    // master playlists are conventionally named `master.m3u8`; anything
    // matching `/index-v\d` or `/playlist-v\d` is already a variant.
    const looksLikeMaster = /\/master\.(?:m3u8|txt)(?:\?|$)/.test(masterUrl);
    let finalUrl = masterUrl;
    let quality = "auto";
    if (looksLikeMaster) {
      try {
        const masterRes = await fetchWithTimeout(
          masterUrl,
          { headers: { "User-Agent": UA, Referer: referer } },
          10000
        );
        if (masterRes.ok) {
          const master = await masterRes.text();
          const variants = [
            ...master.matchAll(
              /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n([^\n]+)/g
            ),
          ];
          if (variants.length > 0) {
            variants.sort((a, b) => parseInt(b[2]) - parseInt(a[2]));
            const best = variants[0][3].trim();
            const baseUrl = masterUrl.replace(/\/[^/]+(?:\?[^?]*)?$/, "");
            finalUrl = best.startsWith("http") ? best : `${baseUrl}/${best}`;
            quality = `${variants[0][2]}p`;
          }
        }
      } catch {
        // Master probe failed — fall back to the original URL, hls.js can
        // resolve variants client-side.
      }
    }

    return {
      streams: [{
        url: finalUrl,
        quality,
        isM3U8: isM3u8Like || finalUrl.includes(".m3u8"),
        referer: hlsDirect ? null : referer,
        ...(hlsDirect ? { directUrl: true } : {}),
      }],
    };
  } catch (e) {
    return { error: `movearnpre: ${e.message}` };
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

    const m3u8 = data?.sources?.file;
    if (!m3u8) return { error: "megaplay: no source.file in API response" };

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

// ── VOE (voe.sx → mirror domain → obfuscated JSON payload) ───
// VOE rotates its playback domains and hides the source behind a multi-step
// obfuscation. The `voe.sx/e/<id>` page is a tiny JS redirect to a mirror
// host (e.g. maryspecialwatch.com), which serves the real player page with
// a `<script type="application/json">["..."]</script>` payload.
//
// Decoder algorithm — extracted verbatim from VOE's loader.js:
//   1. ROT13 every letter
//   2. Strip noise tokens: @$ ^^ ~@ %? *~ !! #&
//   3. Strip every "_" character
//   4. Base64 decode (binary string)
//   5. Subtract 3 from each char code
//   6. Reverse the string
//   7. Base64 decode again (utf-8 this time — JSON has unicode)
//   8. JSON.parse → { source, direct_access_url, title, ... }
//
// `source` is an HLS master.m3u8; `direct_access_url` is an MP4 fallback.
// Both carry signed tokens that bind to our server's IP for ~4h.
function decodeVoePayload(s) {
  // ROT13
  s = s.replace(/[a-zA-Z]/g, (c) => {
    const code = c.charCodeAt(0);
    const base = code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
  for (const t of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) {
    s = s.split(t).join("");
  }
  s = s.split("_").join("");
  s = Buffer.from(s, "base64").toString("binary");
  s = [...s].map((c) => String.fromCharCode(c.charCodeAt(0) - 3)).join("");
  s = s.split("").reverse().join("");
  s = Buffer.from(s, "base64").toString("utf8");
  return JSON.parse(s);
}

// VOE protects its CDN with DDoS-Guard cookies (`__ddg9_` = IP binding,
// `voe_session`, etc.) that the mirror page issues on first visit. Segments
// fetched by hls.js then go through our /api/v2/proxy/m3u8, which reissues
// the request from the same IP — but without the cookies, the CDN returns
// 403. So we capture the Set-Cookie headers during extraction and stash them
// keyed by the playback CDN host. The m3u8 proxy reads this jar when it
// detects a cloudwindow-route.com / VOE host and forwards them.
//
// Entries are valid for ~90 minutes (token TTL is 4h, but DDoS-Guard cookies
// expire faster). Old entries are GC'd lazily on lookup to avoid leaking.
const VOE_COOKIE_JAR = new Map(); // host → { cookie, expires }

export function getVoeCookieFor(host) {
  const lower = host.toLowerCase();
  for (const [key, { cookie, expires }] of VOE_COOKIE_JAR) {
    if (Date.now() > expires) {
      VOE_COOKIE_JAR.delete(key);
      continue;
    }
    if (lower.includes(key) || key.includes(lower)) return cookie;
  }
  return null;
}

function storeVoeCookies(cdnHost, cookieHeader) {
  // Set-Cookie header may be a single string with multiple cookies separated
  // by ", " — we keep the whole thing and let the proxy forward it as-is.
  if (!cookieHeader) return;
  // Normalize "name=value; attr=...; name2=value2; attr=..." into "name=value; name2=value2"
  // by stripping all attributes (Path, Domain, Expires, Max-Age, Secure, etc.).
  const cookies = [];
  // Set-Cookie can have multiple values joined by comma; node-fetch joins them
  // but commas can also appear in dates. We split on `, ` only when followed
  // by a name=value pattern.
  const parts = cookieHeader.split(/,(?=\s*[a-zA-Z_][a-zA-Z0-9_-]*=)/);
  for (const part of parts) {
    const nameValue = part.trim().split(";")[0];
    if (nameValue.includes("=")) cookies.push(nameValue);
  }
  if (cookies.length === 0) return;
  VOE_COOKIE_JAR.set(cdnHost, {
    cookie: cookies.join("; "),
    expires: Date.now() + 90 * 60 * 1000,
  });
}

export async function extractVoe(embedUrl) {
  try {
    // Step 1: follow the voe.sx → mirror redirect.
    // The redirect happens via JS (window.location.href = '...'), so we
    // fetch the page, parse the redirect URL, and follow it manually.
    let pageUrl = embedUrl;
    let html = "";
    let lastSetCookie = "";
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetchWithTimeout(
        pageUrl,
        {
          headers: {
            "User-Agent": UA,
            Referer: "https://voir-anime.to/",
          },
          redirect: "follow",
        },
        10000
      );
      if (!res.ok) return { error: `voe HTTP ${res.status} on ${pageUrl}` };
      // Capture Set-Cookie from the mirror response — DDoS-Guard issues these.
      const sc =
        res.headers.getSetCookie?.()?.join(", ") ||
        res.headers.get("set-cookie") ||
        "";
      if (sc) lastSetCookie = sc;
      html = await res.text();

      // Look for either the JSON payload (we're on the player page) or
      // a redirect target.
      if (/<script[^>]*type="application\/json"/.test(html)) break;
      const redirect =
        html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/)?.[1] ||
        html.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*url=([^"'>\s]+)/i)?.[1];
      if (!redirect) return { error: "voe: no JSON payload and no redirect" };
      pageUrl = redirect;
    }

    // Step 2: extract and decode the JSON payload.
    const m = html.match(
      /<script[^>]*type="application\/json"[^>]*>\s*\[\s*"([^"]+)"\s*\]\s*<\/script>/
    );
    if (!m) return { error: "voe: JSON payload not found on player page" };

    let data;
    try {
      data = decodeVoePayload(m[1]);
    } catch (e) {
      return { error: `voe: decode failed (${e.message})` };
    }

    const hls = data?.source;
    const mp4 = data?.direct_access_url;
    if (!hls && !mp4) return { error: "voe: payload had no source URL" };

    // Prefer HLS (multi-bitrate, faster start). The `pageUrl` is the mirror
    // domain that issued the signed token — segments validate against it.
    const chosen = hls || mp4;

    // Stash the DDoS-Guard cookies from the mirror under the CDN's host.
    // The m3u8 proxy will read them when forwarding segment requests.
    try {
      const cdnHost = new URL(chosen).hostname;
      // Keep just the suffix that's likely shared across rotating subdomains
      // (e.g. `cloudwindow-route.com`) so future tokens with different
      // wildcard subdomains still match.
      const parts = cdnHost.split(".");
      const suffix = parts.slice(-2).join(".");
      storeVoeCookies(suffix, lastSetCookie);
    } catch {}

    // Playability check: VOE sometimes returns a payload with a `source` URL
    // that's already invalid (token bound to a different IP, the file was
    // removed mid-session, or the playlist is empty). A HEAD passing isn't
    // enough — broken streams routinely return 200 HEAD then 403 / empty body
    // on the actual segment GET, which is the "chip appears, disappears on
    // click" symptom users see. So for HLS we fetch the playlist body and
    // verify it parses; for MP4 we keep HEAD and probe a tiny Range request
    // for actual bytes.
    const isHls = chosen.includes(".m3u8");
    try {
      const cdnHost = new URL(chosen).hostname;
      const cookie = getVoeCookieFor(cdnHost);
      const probe = await fetchWithTimeout(
        chosen,
        {
          method: isHls ? "GET" : "HEAD",
          headers: {
            "User-Agent": UA,
            Referer: pageUrl,
            ...(isHls ? {} : { Range: "bytes=0-1023" }),
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        5000
      );
      // 4xx (except 405 Method Not Allowed which some CDNs use to reject HEAD)
      // means the stream is dead. 5xx is transient — let the player try.
      if (
        probe.status >= 400 &&
        probe.status < 500 &&
        probe.status !== 405 &&
        probe.status !== 416 // some CDNs reject Range on tiny files
      ) {
        return { error: `voe: stream HTTP ${probe.status}` };
      }
      if (isHls && probe.ok) {
        // Validate the playlist body. A real master.m3u8 starts with #EXTM3U
        // and contains either #EXT-X-STREAM-INF (master) or #EXTINF (media).
        // VOE's broken streams sometimes return 200 with an HTML error page
        // (Cloudflare challenge, "video deleted") that would pass HEAD but
        // crash hls.js. The player can't recover from those, so we treat
        // anything that doesn't look like HLS as a dead stream.
        const body = await probe.text();
        if (!body.startsWith("#EXTM3U")) {
          return { error: "voe: playlist not HLS (token likely expired)" };
        }
        const isMaster = body.includes("#EXT-X-STREAM-INF");
        if (!isMaster && !body.includes("#EXTINF")) {
          return { error: "voe: playlist has no variants/segments" };
        }
        // Master playlist passing isn't enough — VOE often serves a valid
        // master while every variant/segment 410s (IP-bound tokens, removed
        // file). Resolve the first non-comment line after each STREAM-INF /
        // EXTINF, then probe that URL. If it 410s, the stream is dead from
        // the player's perspective too.
        const lines = body.split(/\r?\n/);
        let childUrl = null;
        for (let i = 0; i < lines.length - 1 && !childUrl; i++) {
          const tag = lines[i].trim();
          const next = lines[i + 1].trim();
          if (!next || next.startsWith("#")) continue;
          if (tag.startsWith("#EXT-X-STREAM-INF") || tag.startsWith("#EXTINF")) {
            childUrl = next;
          }
        }
        if (childUrl) {
          // Resolve relative URL against the master's URL.
          const resolved = new URL(childUrl, chosen).toString();
          try {
            const child = await fetchWithTimeout(
              resolved,
              {
                method: "GET",
                headers: {
                  "User-Agent": UA,
                  Referer: pageUrl,
                  Range: "bytes=0-1023",
                  ...(cookie ? { Cookie: cookie } : {}),
                },
              },
              4000
            );
            if (
              child.status >= 400 &&
              child.status < 500 &&
              child.status !== 405 &&
              child.status !== 416
            ) {
              return { error: `voe: child ${child.status} (${isMaster ? "variant" : "segment"} dead)` };
            }
          } catch {
            // Network error — don't block; the master was at least valid.
          }
        }
      }
    } catch {
      // Network error on probe — don't block, the player will surface the
      // real error if any.
    }

    // Worker-path validation. VOE binds CDN tokens to the requester's IP,
    // and the client fetches segments through the Cloudflare Worker — which
    // has a different IP than this Vercel extractor. So even if the m3u8
    // checks above passed from Vercel's IP, the worker can still see 410
    // Gone (the "ugc-cdn-c… 410" symptom in browser console). Hit the
    // worker once during extraction to validate the actual playback path.
    const proxyBase = process.env.NEXT_PUBLIC_PROXY_BASE;
    if (proxyBase) {
      try {
        const proxyUrl = `${proxyBase}?url=${encodeURIComponent(chosen)}`;
        const proxyProbe = await fetchWithTimeout(
          proxyUrl,
          {
            method: "GET",
            headers: { "User-Agent": UA, Range: "bytes=0-1023" },
          },
          6000
        );
        if (
          proxyProbe.status >= 400 &&
          proxyProbe.status < 500 &&
          proxyProbe.status !== 405 &&
          proxyProbe.status !== 416
        ) {
          return { error: `voe: worker proxy ${proxyProbe.status}` };
        }
      } catch {
        // Worker unreachable / timeout — don't block; fall through.
      }
    }

    // Capture the cookie at extraction time so the proxy (whether it's the
    // in-tree Vercel endpoint or the Cloudflare Worker) can forward it
    // without sharing in-memory state with the extractor. Without this hop,
    // the Worker has no way to authenticate against cloudwindow-route.
    let voeCookie = null;
    try {
      const cdnHost = new URL(chosen).hostname;
      voeCookie = getVoeCookieFor(cdnHost);
    } catch {}

    return {
      streams: [
        {
          url: chosen,
          quality: "auto",
          isM3U8: chosen.includes(".m3u8"),
          referer: pageUrl,
          voeCookie,
        },
      ],
    };
  } catch (e) {
    return { error: `voe: ${e.message}` };
  }
}

// ── Smoothpre / generic JWPlayer-style embeds ────────────────
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
  if (lower.includes("sibnet"))                       return extractSibnet;
  if (lower.includes("sendvid"))                       return extractSendvid;
  if (lower.includes("uqload"))                        return extractUqload;
  if (lower.includes("megaplay"))                      return extractMegaplay;
  if (lower.includes("embed4me") || lower.includes("lpayer")) return extractEmbed4me;
  if (lower.includes("voe.sx") || lower.includes("voe."))     return extractVoe;
  if (
    lower.includes("movearnpre") ||
    lower.includes("dingtezuni") ||
    lower.includes("callistanise") ||
    lower.includes("smoothpre")
  )
    return extractMovearnpre;
  return extractGenericJwplayer;
}
