/**
 * Vitesse percue d'une serie de pages, AVANT / APRES une passe de perf.
 *
 *   node tools/browser-check/perf-measure.mjs <sortie.json> [origine] [runs]
 *   node tools/browser-check/perf-measure.mjs --compare avant.json apres.json
 *
 * Pourquoi (20/11/2026). La passe « 31 etapes » devait dire si le site est
 * VRAIMENT plus rapide ; rien dans le depot ne mesurait LCP/CLS/TTFB (cf.
 * hydration-check.mjs, dont ce script reprend la plomberie CDP sans
 * dependance).
 *
 * Deux profils :
 *   - bureau : 1600x900, reseau et CPU de la machine ;
 *   - mobile : 390x844, UA iPhone (=> variante `?__m=1` servie par Cloudflare),
 *     CPU x4, « Slow 4G » facon Lighthouse (150 ms RTT, 1,6 Mb/s, 750 kb/s).
 *
 * Chaque chargement est a FROID : cache navigateur, cookies, stockage et
 * service worker effaces avant la navigation. C'est la premiere visite qu'on
 * mesure, celle qui fait fuir.
 *
 * Mesures : TTFB, FCP, LCP, CLS, TBT (somme des taches longues au-dela de
 * 50 ms jusqu'a 5 s apres load), octets transferes par type, nombre de
 * requetes. Mediane de `runs` passages (3 par defaut).
 *
 * QUOTA (CLAUDE.md regle 2) : ce n'est pas une boucle de sondage — une suite
 * finie (~50 chargements) majoritairement servie par le cache HTML Cloudflare.
 * La page watch consomme le limiteur par IP de /api/v2/source : ne pas
 * enchainer deux executions.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ── Comparaison de deux fichiers ─────────────────────────────────────── */
if (process.argv[2] === "--compare") {
  const a = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const b = JSON.parse(readFileSync(process.argv[4], "utf8"));
  const cles = ["ttfb", "fcp", "lcp", "cls", "tbt", "js", "css", "font", "img", "total", "req"];
  for (const profil of Object.keys(b.mediane)) {
    console.log(`\n=== ${profil} ===`);
    console.log(["page".padEnd(28), ...cles.map((k) => k.padStart(15))].join(""));
    for (const page of Object.keys(b.mediane[profil])) {
      const x = a.mediane[profil]?.[page] || {};
      const y = b.mediane[profil][page];
      const cell = (k) => {
        if (x[k] == null || y[k] == null) return String(y[k] ?? "?").padStart(15);
        const f = (v) => (k === "cls" ? v.toFixed(3) : String(Math.round(v)));
        return `${f(x[k])}>${f(y[k])}`.padStart(15);
      };
      console.log([page.slice(0, 27).padEnd(28), ...cles.map(cell)].join(""));
    }
  }
  console.log("\n(ms pour les temps ; Ko transferes pour js/css/font/img/total)");
  process.exit(0);
}

const SORTIE = process.argv[2];
if (!SORTIE) {
  console.error("usage : perf-measure.mjs <sortie.json> [origine] [runs]");
  process.exit(2);
}
const ORIGINE = process.argv[3] || "https://dev.aniscroll.com";
const RUNS = Number(process.argv[4] || 3);

const PAGES = [
  "/fr",
  "/fr/anime/154587", // Frieren : populaire, cache chaud
  "/fr/anime/21", // One Piece : gros catalogue d'episodes
  "/fr/anime/watch/154587/frieren?id=animesama-ansembed-154587-1&num=1",
  "/fr/search/anime",
  "/fr/schedule",
  "/fr/anime/popular",
  "/fr/discover",
  "/fr/profile/Lucyd-952364",
];

const PROFILS = {
  bureau: { w: 1600, h: 900, mobile: false, cpu: 1, net: null },
  mobile: {
    w: 390,
    h: 844,
    mobile: true,
    cpu: 4,
    net: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
};

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9358);

const profilDir = mkdtempSync(join(tmpdir(), "aniscroll-perf-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profilDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--lang=fr-FR",
    "--accept-lang=fr-FR,fr",
  ],
  { stdio: "ignore" },
);

const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const attends = async (fn, max = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > max) throw new Error("delai depasse");
    await dors(300);
  }
};

await attends(() => fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()));
const onglet = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(onglet.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let n = 0;
const attente = new Map();
/** requestId -> { type, octets } pour le chargement en cours. */
let reqs = new Map();

ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && attente.has(msg.id)) {
    attente.get(msg.id)(msg);
    attente.delete(msg.id);
    return;
  }
  const p = msg.params;
  if (msg.method === "Network.requestWillBeSent") reqs.set(p.requestId, { type: p.type || "Other", octets: 0 });
  if (msg.method === "Network.responseReceived") {
    const r = reqs.get(p.requestId);
    if (r) r.type = p.type || r.type;
  }
  if (msg.method === "Network.loadingFinished") {
    const r = reqs.get(p.requestId);
    if (r) r.octets = p.encodedDataLength || 0;
  }
};
const envoie = (method, params = {}) =>
  new Promise((res) => {
    const id = ++n;
    attente.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalue = async (expr) => {
  const r = await envoie("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await envoie("Network.enable");
await envoie("Page.enable");
await envoie("Runtime.enable");
await envoie("Network.setBypassServiceWorker", { bypass: true });
await envoie("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__p = { lcp: null, cls: 0, tbt: 0, fcp: null };
    const obs = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch {} };
    obs("largest-contentful-paint", (e) => { window.__p.lcp = e.startTime; });
    obs("layout-shift", (e) => { if (!e.hadRecentInput) window.__p.cls += e.value; });
    obs("longtask", (e) => { window.__p.tbt += Math.max(0, e.duration - 50); });
    obs("paint", (e) => { if (e.name === "first-contentful-paint") window.__p.fcp = e.startTime; });
  `,
});

const mediane = (a) => {
  const v = a.filter((x) => x != null).sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

const brut = {};
for (const [nom, pr] of Object.entries(PROFILS)) {
  brut[nom] = {};
  await envoie("Emulation.setDeviceMetricsOverride", { width: pr.w, height: pr.h, deviceScaleFactor: pr.mobile ? 3 : 1, mobile: pr.mobile });
  await envoie("Emulation.setCPUThrottlingRate", { rate: pr.cpu });
  await envoie("Network.emulateNetworkConditions", pr.net ? { offline: false, ...pr.net } : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  if (pr.ua) await envoie("Network.setUserAgentOverride", { userAgent: pr.ua, acceptLanguage: "fr-FR,fr" });
  else await envoie("Network.setUserAgentOverride", { userAgent: (await evalue("navigator.userAgent")).replace("HeadlessChrome", "Chrome"), acceptLanguage: "fr-FR,fr" });

  for (const page of PAGES) {
    brut[nom][page] = [];
    for (let i = 0; i < RUNS; i++) {
      // A FROID : rien du passage precedent ne doit servir.
      await envoie("Page.navigate", { url: "about:blank" });
      await dors(300);
      await envoie("Network.clearBrowserCache");
      await envoie("Network.clearBrowserCookies");
      await envoie("Storage.clearDataForOrigin", { origin: ORIGINE, storageTypes: "all" });
      reqs = new Map();
      await envoie("Page.navigate", { url: ORIGINE + page });
      try {
        await attends(() => evalue(`document.readyState === "complete"`), 60000);
      } catch {
        console.log(`${nom} ${page} : load jamais atteint (60 s)`);
      }
      await dors(5000);
      const t = await evalue(`(() => {
        const nav = performance.getEntriesByType("navigation")[0] || {};
        return { ttfb: nav.responseStart, load: nav.loadEventEnd, ...window.__p };
      })()`);
      const ko = { js: 0, css: 0, font: 0, img: 0, total: 0 };
      for (const r of reqs.values()) {
        const k = r.type === "Script" ? "js" : r.type === "Stylesheet" ? "css" : r.type === "Font" ? "font" : r.type === "Image" ? "img" : null;
        if (k) ko[k] += r.octets / 1024;
        ko.total += r.octets / 1024;
      }
      const m = { ...t, ...ko, req: reqs.size };
      brut[nom][page].push(m);
      console.log(
        `${nom.padEnd(7)} ${page.slice(0, 40).padEnd(41)} #${i + 1} ttfb ${Math.round(m.ttfb ?? -1)} fcp ${Math.round(m.fcp ?? -1)} lcp ${Math.round(m.lcp ?? -1)} cls ${(m.cls ?? 0).toFixed(3)} tbt ${Math.round(m.tbt ?? 0)} js ${Math.round(m.js)}K total ${Math.round(m.total)}K req ${m.req}`,
      );
    }
  }
}

const med = {};
for (const [nom, pages] of Object.entries(brut)) {
  med[nom] = {};
  for (const [page, runs] of Object.entries(pages)) {
    med[nom][page] = {};
    for (const k of ["ttfb", "fcp", "lcp", "cls", "tbt", "load", "js", "css", "font", "img", "total", "req"])
      med[nom][page][k] = mediane(runs.map((r) => r[k]));
  }
}
writeFileSync(SORTIE, JSON.stringify({ origine: ORIGINE, date: new Date().toISOString(), runs: RUNS, mediane: med, brut }, null, 2));
console.log(`\necrit : ${SORTIE}`);
ws.close();
chrome.kill();
process.exit(0);
