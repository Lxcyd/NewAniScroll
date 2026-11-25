/**
 * Comment l'outil de remplissage JOINT anizone, en cascade (25/11/2026).
 *
 * anizone.to et son CDN refusent (403) les IP de Vercel, du Worker et de
 * GitHub (Azure). lib/anizone/core.mjs appelle le `fetch` global : on le
 * remplace ici, pour les seuls hotes d'anizone, par le premier moyen qui passe :
 *
 *   1. DIRECT, avec les en-tetes d'un vrai Chrome (Accept, sec-ch-ua,
 *      Sec-Fetch-*…) : ceux de Node (`accept: *\/*`, `sec-fetch-mode: cors`)
 *      signent un robot ;
 *   2. (hors de ce fichier) WARP : le workflow fait sortir la machine par
 *      Cloudflare WARP quand la sonde directe echoue, et relance — l'etape 1
 *      se rejoue alors depuis une autre IP ;
 *   3. NAVIGATEUR : un Chrome reel (playwright-core, Chrome installe sur la
 *      machine, ecran virtuel si DISPLAY) ouvre anizone.to, passe le test
 *      anti-robot de Cloudflare s'il y en a un, puis TOUTES les requetes
 *      partent de la page : meme origine pour anizone.to (cookie
 *      cf_clearance compris), et CORS accepte pour le CDN, qui n'autorise que
 *      l'origine https://anizone.to.
 *
 * Chaque refus est DECRIT (statut, cf-mitigated, titre de la page) : un
 * blocage pur et un test anti-robot ne se contournent pas pareil.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HOTES =/(^|\.)anizone\.to$|(^|\.)vid-cdn\.xyz$/i;
const natif = globalThis.fetch.bind(globalThis);

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const NAVIGATION = {
  "User-Agent": CHROME_UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const hoteDe = (u) => {
  try {
    return new URL(typeof u === "string" ? u : u.url).hostname;
  } catch {
    return "";
  }
};

/** Le refus, en une ligne : de quoi trancher entre blocage et test. */
export async function decris(r) {
  let titre = "";
  try {
    titre = ((await r.clone().text()).match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
  } catch {}
  const h = (n) => r.headers.get(n) || "-";
  return `HTTP ${r.status} server=${h("server")} cf-mitigated=${h("cf-mitigated")} cf-ray=${h("cf-ray")} titre="${titre.trim().slice(0, 80)}"`;
}

async function sonde(f) {
  const r = await f("https://anizone.to/anime", { signal: AbortSignal.timeout(25_000) });
  const ok = r.ok && /data-csrf=/.test(await r.clone().text());
  return { ok, detail: await decris(r) };
}

// ── 1. Direct ───────────────────────────────────────────────────────────

function direct(url, init = {}) {
  if (!HOTES.test(hoteDe(url))) return natif(url, init);
  const page = /anizone\.to$/i.test(hoteDe(url)) && (init.method || "GET") === "GET";
  const base = page
    ? NAVIGATION
    : {
        "User-Agent": CHROME_UA,
        Accept: "*/*",
        "Accept-Language": NAVIGATION["Accept-Language"],
        "sec-ch-ua": NAVIGATION["sec-ch-ua"],
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": /vid-cdn/.test(hoteDe(url)) ? "cross-site" : "same-origin",
        Origin: "https://anizone.to",
        Referer: "https://anizone.to/",
      };
  // Les en-tetes de core.mjs (Cookie, X-Livewire, Content-Type…) l'emportent,
  // sauf son User-Agent, remplace par celui du navigateur imite.
  const propres = { ...(init.headers || {}) };
  delete propres["User-Agent"];
  return natif(url, { ...init, headers: { ...base, ...propres } });
}

// ── 3. Navigateur ───────────────────────────────────────────────────────

const INTERDITS = new Set(["user-agent", "cookie", "referer", "origin", "host", "content-length"]);

async function navigateur(log) {
  let chromium;
  try {
    // PLAYWRIGHT_CORE : chemin d'un playwright-core installe ailleurs (essai local).
    const mod = await import(
      process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core"
    );
    chromium = mod.chromium || mod.default?.chromium;
  } catch {
    log("  navigateur : playwright-core absent");
    return null;
  }
  const executablePath =
    process.env.CHROME_PATH ||
    ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium",
      "C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));
  const browser = await chromium.launch({
    executablePath: executablePath || undefined,
    channel: executablePath ? undefined : "chrome",
    // Un ecran virtuel (xvfb-run) vaut mieux que le mode sans tete, que
    // Cloudflare reconnait.
    headless: !process.env.DISPLAY,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1366,768",
    ],
  });
  /* Le Chrome sans tete se dit « HeadlessChrome » : UA de bureau, a SA
     version (un UA qui ment sur la version se repere aux sec-ch-ua). */
  const majeure = String(await browser.version()).match(/\d+/)?.[0] || "131";
  const ctx = await browser.newContext({
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    viewport: { width: 1366, height: 768 },
    userAgent: CHROME_UA.replace("131.0.0.0", `${majeure}.0.0.0`),
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["fr-FR", "fr", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
  const page = await ctx.newPage();
  await page.goto("https://anizone.to/anime", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  // Le test « Just a moment… » se resout seul en quelques secondes.
  const fin = Date.now() + 60_000;
  while (Date.now() < fin) {
    const html = await page.content().catch(() => "");
    if (/data-csrf=/.test(html)) break;
    await page.waitForTimeout(2000);
  }
  const titre = await page.title().catch(() => "");
  if (!/data-csrf=/.test(await page.content().catch(() => ""))) {
    log(`  navigateur : toujours refuse (titre « ${titre} »)`);
    await browser.close();
    return null;
  }
  log(`  navigateur : anizone ouvert (« ${titre} »)`);

  const viaPage = async (url, init = {}) => {
    if (!HOTES.test(hoteDe(url))) return natif(url, init);
    const headers = Object.fromEntries(
      Object.entries(init.headers || {}).filter(([k]) => !INTERDITS.has(k.toLowerCase())),
    );
    const job = page.evaluate(
      async ({ url, method, headers, body }) => {
        // `same-origin` : les cookies (cf_clearance) pour anizone.to, aucun
        // pour le CDN, dont le CORS refuse une requete avec identifiants.
        const r = await fetch(url, { method, headers, body, credentials: "same-origin" });
        return { s: r.status, h: [...r.headers], t: await r.text() };
      },
      { url: String(url), method: init.method || "GET", headers, body: init.body ?? undefined },
    );
    const delai = new Promise((_, ko) => setTimeout(() => ko(new Error("delai depasse (navigateur)")), 45_000));
    const { s, h, t } = await Promise.race([job, delai]);
    return new Response(s === 204 || s === 304 ? null : t, { status: s, headers: h });
  };
  return { fetch: viaPage, fermer: () => browser.close() };
}

/**
 * Installe le premier transport qui passe. Rend son nom, ou null si aucun ;
 * `fermer()` libere le navigateur en fin de passage.
 */
export async function installe(log = console.log) {
  globalThis.fetch = direct;
  // ANIZONE_NAVIGATEUR=1 : saute le direct (pour essayer le navigateur d'une
  // IP qui n'en a pas besoin).
  if (!process.env.ANIZONE_NAVIGATEUR) {
    const d = await sonde(direct).catch((e) => ({ ok: false, detail: e.message }));
    log(`  direct : ${d.ok ? "OK" : d.detail}`);
    if (d.ok) return { mode: "direct", fermer: async () => {} };
  }

  const nav = await navigateur(log).catch((e) => (log(`  navigateur : ${e.message}`), null));
  if (nav) {
    const v = await sonde(nav.fetch).catch((e) => ({ ok: false, detail: e.message }));
    log(`  navigateur, requete depuis la page : ${v.ok ? "OK" : v.detail}`);
    if (v.ok) {
      globalThis.fetch = nav.fetch;
      return { mode: "navigateur", fermer: nav.fermer };
    }
    await nav.fermer();
  }
  globalThis.fetch = natif;
  return null;
}
