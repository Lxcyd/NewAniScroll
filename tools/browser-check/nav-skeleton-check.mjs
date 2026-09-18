/**
 * Verifier, dans un VRAI Chrome, la passe de vitesse du 18/09/2026 :
 *
 *   1. le prechauffage au survol : apres 150 ms immobile sur une carte, UNE
 *      requete /_next/data/.../anime/<id>.json part ;
 *   2. le squelette : au clic, `.as-route-skeleton` est la en quelques ms, la
 *      navbar reste AU-DESSUS (elementFromPoint en haut de l'ecran), et il
 *      disparait quand la fiche est peinte ;
 *   3. la requete de donnees du clic sort du cache (fromDiskCache) ;
 *   4. les onglets differes : clic « Episodes » -> des lignes apparaissent ;
 *   5. la page de lecture : UN seul /api/v2/skip, aucun `server=` dedans ;
 *   6. aucune requete vers fonts.googleapis.com ni cdnjs (Font Awesome).
 *
 *   node tools/browser-check/nav-skeleton-check.mjs [origine]
 *
 * Origine par defaut : dev.aniscroll.com (localhost ment). Chaque run consomme
 * le limiteur par IP des routes appelees : espacer les executions.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINE = process.argv[2] || "https://dev.aniscroll.com";
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9357);

const profil = mkdtempSync(join(tmpdir(), "aniscroll-nav-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profil}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--mute-audio",
    "--window-size=1600,900",
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
const onglet = await fetch(
  `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(ORIGINE + "/en")}`,
  { method: "PUT" },
).then((r) => r.json());

const ws = new WebSocket(onglet.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const attente = new Map();
/** Toutes les requetes : url, instant, et si la reponse sortait du cache. */
const reqs = new Map();
const erreurs = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && attente.has(msg.id)) {
    attente.get(msg.id)(msg);
    attente.delete(msg.id);
    return;
  }
  const p = msg.params;
  if (msg.method === "Network.requestWillBeSent")
    reqs.set(p.requestId, { url: p.request.url, t: Date.now(), cache: false });
  if (msg.method === "Network.requestServedFromCache" && reqs.has(p.requestId))
    reqs.get(p.requestId).cache = true;
  if (msg.method === "Network.responseReceived" && reqs.has(p.requestId)) {
    const r = reqs.get(p.requestId);
    r.status = p.response.status;
    if (p.response.fromDiskCache || p.response.fromServiceWorker) r.cache = true;
    r.xcache = p.response.headers?.["x-vercel-cache"];
  }
  if (msg.method === "Runtime.exceptionThrown")
    erreurs.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && p.type === "error")
    erreurs.push(p.args.map((a) => a.value ?? a.description).join(" "));
};
const envoie = (method, params = {}) =>
  new Promise((res) => {
    const id = ++n;
    attente.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
await envoie("Network.enable");
await envoie("Runtime.enable");
await envoie("Page.enable");
const evalue = async (expr) => {
  const r = await envoie("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.result?.value;
};
const depuis = (t, re) => [...reqs.values()].filter((r) => r.t >= t && re.test(r.url));
let ok = true;
const verdict = (bon, nom, detail) => {
  ok &&= bon;
  console.log(`${bon ? "OK   " : "ECHEC"} ${nom.padEnd(34)} ${detail}`);
};

await attends(() => evalue(`document.readyState === "complete"`), 45000);
await dors(6000);
console.log(`origine : ${ORIGINE}\n`);

// 6. Pas de CSS/polices tierces bloquantes.
const tiers = [...reqs.values()].filter((r) => /fonts\.googleapis|cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome/.test(r.url));
verdict(tiers.length === 0, "aucune police/CSS tierce", `${tiers.length} requete(s)`);

// 1. Survol prolonge d'une carte.
const carte = await evalue(`(() => {
  const el = [...document.querySelectorAll("[data-anime-preview]")].find(e => {
    const b = e.getBoundingClientRect(); return b.width > 60 && b.top > 120 && b.bottom < innerHeight;
  });
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { id: el.getAttribute("data-anime-preview"), x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2) };
})()`);
if (!carte) throw new Error("aucune carte visible sur /en");
const tSurvol = Date.now();
await envoie("Input.dispatchMouseEvent", { type: "mouseMoved", x: carte.x - 40, y: carte.y - 40 });
await dors(80);
await envoie("Input.dispatchMouseEvent", { type: "mouseMoved", x: carte.x, y: carte.y });
await dors(900);
const chauffe = depuis(tSurvol, new RegExp(`/_next/data/.*/anime/${carte.id}\\.json`));
verdict(chauffe.length === 1, "prechauffage au survol", chauffe.map((r) => r.url.split("/_next/data/")[1]).join(" ") || "aucune requete");

// 2 + 3. Clic : squelette, navbar au-dessus, donnees depuis le cache.
const tClic = Date.now();
await envoie("Input.dispatchMouseEvent", { type: "mousePressed", x: carte.x, y: carte.y, button: "left", clickCount: 1 });
await envoie("Input.dispatchMouseEvent", { type: "mouseReleased", x: carte.x, y: carte.y, button: "left", clickCount: 1 });
let vuSquelette = null;
let navDessus = null;
for (let i = 0; i < 200; i++) {
  const etat = await evalue(`(() => {
    const s = document.querySelector(".as-route-skeleton");
    const top = document.elementFromPoint(innerWidth / 2, 20);
    return { s: !!s, nav: !!(top && top.closest("nav, header, [class*='z-[9999]']")), path: location.pathname };
  })()`);
  if (etat?.s && vuSquelette == null) {
    vuSquelette = Date.now() - tClic;
    navDessus = etat.nav;
  }
  if (etat?.path?.includes(`/anime/${carte.id}`) && !etat.s) break;
  await dors(15);
}
const finNav = Date.now() - tClic;
verdict(vuSquelette != null, "squelette au clic", vuSquelette != null ? `+${vuSquelette} ms` : "jamais vu (navigation plus rapide que le sondage ?)");
if (vuSquelette != null) verdict(!!navDessus, "navbar au-dessus du squelette", navDessus ? "oui" : "NON — le squelette la recouvre");
const donneesClic = depuis(tClic, new RegExp(`/_next/data/.*/anime/${carte.id}\\.json`));
verdict(
  donneesClic.length === 0 || donneesClic.every((r) => r.cache),
  "donnees du clic depuis le cache",
  donneesClic.map((r) => `${r.cache ? "cache" : "reseau"} ${r.status ?? "?"} ${r.xcache ?? ""}`).join(", ") || "aucune requete (cache interne du routeur)",
);
console.log(`      fiche peinte en ${finNav} ms`);

// 4. Onglet Episodes (chunk differe).
await dors(2500);
const tOnglet = Date.now();
await evalue(`(() => { const b = [...document.querySelectorAll("button")].find(x => /^(Épisodes|Episodes)/i.test(x.textContent.trim())); b && b.click(); return !!b; })()`);
const lignes = await attends(
  () => evalue(`document.querySelectorAll('a[href*="/anime/watch/"]').length`),
  15000,
).catch(() => 0);
const epReq = depuis(tOnglet, /\/api\/v2\/episode\//);
verdict(lignes > 0, "onglet Episodes", `${lignes} liens d'episode, ${epReq.length} requete(s) /episode apres le clic`);

// 5. Page de lecture : un seul /skip, sans server=.
const tWatch = Date.now();
await evalue(`(() => { const a = document.querySelector('a[href*="/anime/watch/"]'); a && a.click(); return !!a; })()`);
await attends(() => evalue(`location.pathname.includes("/anime/watch/")`), 20000);
await dors(12000);
const skips = depuis(tWatch, /\/api\/v2\/skip\//);
verdict(
  skips.length <= 1 && skips.every((r) => !/[?&]server=/.test(r.url)),
  "un seul /api/v2/skip",
  skips.map((r) => r.url.split("/api/v2/skip/")[1]).join(" | ") || "aucun",
);

console.log("");
if (erreurs.length) {
  console.log(`erreurs console (${erreurs.length}) :`);
  for (const e of [...new Set(erreurs)].slice(0, 12)) console.log("  " + String(e).slice(0, 300));
} else console.log("erreurs console : aucune");

ws.close();
chrome.kill();
process.exit(ok ? 0 : 1);
