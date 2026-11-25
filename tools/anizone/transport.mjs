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
 *   2. CHROME « A LA MAIN » (cf. section 3) : passe le test anti-robot de
 *      Cloudflare, puis Node reutilise son cookie cf_clearance, ou a defaut
 *      TOUTES les requetes partent de la page (meme origine pour anizone.to,
 *      CORS accepte pour le CDN, qui n'autorise que https://anizone.to).
 *   (le workflow peut en plus faire sortir la machine par Tor : ANIZONE_PROXY.)
 *
 * Chaque refus est DECRIT (statut, cf-mitigated, titre de la page) : un
 * blocage pur et un test anti-robot ne se contournent pas pareil.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOTES = /(^|\.)anizone\.to$|(^|\.)vid-cdn\.xyz$/i;
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


// ── 3. Chrome « a la main » ─────────────────────────────────────────────
/*
 * MESURE DU 25/11/2026 sur GitHub : en direct, anizone repond
 * `cf-mitigated: challenge` (« Just a moment… ») — un TEST, pas un blocage ;
 * un Chrome lance PAR PLAYWRIGHT recoit « Attention Required! » (bloque) :
 * ses drapeaux d'automatisation et son attache CDP des l'ouverture se voient.
 * WARP : « Attention Required! » en direct comme en Chrome — pire, retire.
 *
 * Donc : Chrome lance comme par un humain (aucun drapeau d'automatisation,
 * vrai profil, fenetre sur l'ecran virtuel), et PERSONNE n'est attache a la
 * page pendant le test — on ne lit que le titre de l'onglet par /json/list du
 * port de debogage, qui ne touche pas la page. Si le test demande de cocher
 * la case, un VRAI clic souris (xdotool) sur l'ecran virtuel. On ne s'attache
 * (playwright connectOverCDP) qu'une fois le test passe.
 */

const INTERDITS = new Set(["user-agent", "cookie", "referer", "origin", "host", "content-length"]);

function cheminChrome() {
  return (
    process.env.CHROME_PATH ||
    [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    ].find((p) => existsSync(p))
  );
}

async function playwright() {
  // PLAYWRIGHT_CORE : chemin d'un playwright-core installe ailleurs.
  const mod = await import(
    process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core"
  );
  return mod.chromium || mod.default?.chromium;
}

const attends = (ms) => new Promise((r) => setTimeout(r, ms));

async function onglet(port) {
  try {
    const r = await natif(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    const l = await r.json();
    return l.find((t) => t.type === "page");
  } catch {
    return null;
  }
}

const PASSE = (t) => /anizone/i.test(t) && !/just a moment|attention required|un instant/i.test(t);
const BLOQUE = (t) => /attention required|access denied/i.test(t);

/** Le clic sur la case du test : repere la boite du widget (~300×65) dans la
 *  page, puis clic X11 a ses coordonnees ecran. */
async function cocheLaCase(port, log) {
  if (process.platform !== "linux" || !process.env.DISPLAY) return false;
  try {
    execFileSync("xdotool", ["version"], { stdio: "ignore" });
  } catch {
    log("  chrome : xdotool absent, pas de clic");
    return false;
  }
  const chromium = await playwright();
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = b.contexts()[0]?.pages()[0];
    const cible = await page.evaluate(() => {
      const r = [...document.querySelectorAll("div, iframe")]
        .map((e) => e.getBoundingClientRect())
        .find((r) => r.width > 280 && r.width < 320 && r.height > 55 && r.height < 80);
      if (!r) return null;
      const bord = (window.outerWidth - window.innerWidth) / 2;
      return {
        x: Math.round(window.screenX + bord + r.left + 30),
        y: Math.round(window.screenY + (window.outerHeight - window.innerHeight) - bord + r.top + r.height / 2),
      };
    });
    if (!cible) {
      log("  chrome : case introuvable");
      return false;
    }
    execFileSync("xdotool", ["mousemove", String(cible.x - 40), String(cible.y + 25)]);
    await attends(300);
    execFileSync("xdotool", ["mousemove", String(cible.x), String(cible.y), "click", "1"]);
    log(`  chrome : clic sur la case (${cible.x}, ${cible.y})`);
    return true;
  } finally {
    // Se detacher sans fermer Chrome.
    await b.close().catch(() => {});
  }
}

async function chromeALaMain(log) {
  const exe = cheminChrome();
  if (!exe) {
    log("  chrome : introuvable");
    return null;
  }
  const port = 9300 + Math.floor(Math.random() * 400);
  const profil = mkdtempSync(join(tmpdir(), "anizone-chrome-"));
  const [fx, fy] = String(process.env.ANIZONE_FENETRE || "0,0").split(",");
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profil}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--lang=fr-FR",
    `--window-position=${fx},${fy}`,
    "--window-size=1366,768",
    "--disable-dev-shm-usage",
    ...(process.env.ANIZONE_PROXY ? [`--proxy-server=${process.env.ANIZONE_PROXY}`] : []),
    ...(process.env.ANIZONE_NO_SANDBOX ? ["--no-sandbox"] : []),
    ...(process.platform === "linux" && !process.env.DISPLAY ? ["--headless=new"] : []),
    "https://anizone.to/anime",
  ];
  const proc = spawn(exe, args, { stdio: "ignore" });
  const tuer = async () => {
    try {
      proc.kill();
    } catch {}
    await attends(800);
    try {
      rmSync(profil, { recursive: true, force: true });
    } catch {}
  };

  const debut = Date.now();
  let titre = "";
  let clics = 0;
  while (Date.now() - debut < 120_000) {
    await attends(3000);
    const o = await onglet(port);
    if (!o) continue;
    titre = o.title || "";
    if (PASSE(titre) || BLOQUE(titre)) break;
    // Le test non interactif se resout en ~5-15 s ; au-dela, il veut un clic.
    if (Date.now() - debut > 25_000 * (clics + 1) && clics < 3) {
      clics++;
      await cocheLaCase(port, log).catch((e) => log(`  chrome : clic impossible (${e.message})`));
    }
  }
  log(`  chrome : titre « ${titre} » apres ${Math.round((Date.now() - debut) / 1000)} s`);
  if (!PASSE(titre)) {
    await tuer();
    return null;
  }

  // Passe : on s'attache maintenant, pour lire depuis la page.
  const chromium = await playwright();
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => /anizone/.test(p.url())) || ctx.pages()[0];
  const ua = await page.evaluate(() => navigator.userAgent);
  const cookies = (await ctx.cookies("https://anizone.to")).map((c) => `${c.name}=${c.value}`).join("; ");

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

  /* Le cookie cf_clearance vaut pour CET UA et CETTE IP : Node peut s'en
     servir directement, sans passer par la page (plus rapide). Le CDN, lui,
     passe toujours par la page. */
  const viaCookie = (url, init = {}) => {
    const hote = hoteDe(url);
    if (!/(^|\.)anizone\.to$/i.test(hote)) return HOTES.test(hote) ? viaPage(url, init) : natif(url, init);
    const h = { ...(init.headers || {}) };
    const deja = h.Cookie ? `${h.Cookie}; ` : "";
    return direct(url, { ...init, headers: { ...h, Cookie: deja + cookies, "User-Agent": ua } });
  };

  const fermer = async () => {
    await b.close().catch(() => {});
    await tuer();
  };
  return { viaPage, viaCookie, fermer };
}

/**
 * Installe le premier transport qui passe. Rend `{ mode, fermer }`, ou null ;
 * `fermer()` libere le navigateur en fin de passage.
 */
export async function installe(log = console.log) {
  globalThis.fetch = direct;
  // ANIZONE_NAVIGATEUR=1 : saute le direct (pour essayer Chrome d'une IP qui
  // n'en a pas besoin).
  if (!process.env.ANIZONE_NAVIGATEUR) {
    const d = await sonde(direct).catch((e) => ({ ok: false, detail: e.message }));
    log(`  direct : ${d.ok ? "OK" : d.detail}`);
    if (d.ok) return { mode: "direct", fermer: async () => {} };
  }

  const nav = await chromeALaMain(log).catch((e) => (log(`  chrome : ${e.message}`), null));
  if (nav) {
    for (const [mode, f] of [
      ["chrome+cookie", nav.viaCookie],
      ["chrome", nav.viaPage],
    ]) {
      const v = await sonde(f).catch((e) => ({ ok: false, detail: e.message }));
      log(`  ${mode} : ${v.ok ? "OK" : v.detail}`);
      if (v.ok) {
        globalThis.fetch = f;
        return { mode, fermer: nav.fermer };
      }
    }
    await nav.fermer();
  }
  globalThis.fetch = natif;
  return null;
}
