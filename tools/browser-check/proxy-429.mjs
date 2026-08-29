/**
 * Qui fait les requetes 429 sur proxy.aniscroll.com, et combien ?
 *
 * Pourquoi ce banc : la console montre une avalanche de 429 sur les segments
 * video, mais pas QUI les demande. Le worker fait du prechauffage en tache de
 * fond (20 segments echantillonnes par playlist), hls.js fait ses reprises, et
 * les deux passent par la meme URL — impossible de les distinguer a l'oeil.
 * Ici on enregistre chaque requete proxy avec son STATUT et la premiere image
 * de sa pile d'appel, donc l'origine est nommee.
 *
 *   node tools/browser-check/proxy-429.mjs <url> [secondes]
 *
 * Precaution identique a watch-check.mjs : chaque chargement resout des
 * lecteurs et consomme le limiteur par IP de /api/v2/source. Espacer les runs.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, secondes = "30"] = process.argv.slice(2);
if (!url) {
  console.error("usage : node tools/browser-check/proxy-429.mjs <url> [secondes]");
  process.exit(1);
}

const CHROME =
  process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9356);

const profil = mkdtempSync(join(tmpdir(), "aniscroll-cdp-"));
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
    "--autoplay-policy=no-user-gesture-required",
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
    if (Date.now() - t0 > max) throw new Error("Chrome ne repond pas");
    await dors(300);
  }
};

await attends(() =>
  fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()),
);
const onglet = await fetch(
  `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`,
  { method: "PUT" },
).then((r) => r.json());

const ws = new WebSocket(onglet.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const attente = new Map();
const requetes = new Map(); // requestId -> { cible, pile }
const reponses = []; // { cible, statut, pile }
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && attente.has(msg.id)) {
    attente.get(msg.id)(msg);
    attente.delete(msg.id);
    return;
  }
  if (msg.method === "Network.requestWillBeSent") {
    const u = msg.params.request.url;
    if (!u.includes("proxy.aniscroll.com")) return;
    let cible = u;
    try {
      cible = new URL(decodeURIComponent(new URL(u).searchParams.get("url") || u));
      cible = cible.hostname + cible.pathname;
    } catch {}
    const cadres = msg.params.initiator?.stack?.callFrames || [];
    const cadre = cadres[0];
    requetes.set(msg.params.requestId, {
      cible,
      pile: cadre
        ? `${(cadre.url || "").split("/").pop()}:${cadre.lineNumber}:${cadre.columnNumber}`
        : msg.params.initiator?.type || "?",
      /* Les noms de fonction survivent parfois a la minification, et c'est le
         seul fil qui remonte au code source depuis un bundle d'une ligne. */
      noms: cadres.map((c) => c.functionName || "?").filter(Boolean).slice(0, 6),
    });
  }
  if (msg.method === "Network.responseReceived") {
    const r = requetes.get(msg.params.requestId);
    if (r) reponses.push({ ...r, statut: msg.params.response.status });
  }
};
const envoie = (method, params = {}) =>
  new Promise((res) => {
    const id = ++n;
    attente.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await envoie("Network.enable");
await envoie("Runtime.enable");

console.log(`→ ${url}`);
for (let t = 1; t <= Number(secondes); t++) {
  await dors(1000);
  if (t % 5 === 0) {
    const n429 = reponses.filter((r) => r.statut === 429).length;
    console.log(`t+${String(t).padStart(2)}s  proxy: ${reponses.length} reponses, ${n429} en 429`);
  }
}

const parStatut = new Map();
for (const r of reponses) parStatut.set(r.statut, (parStatut.get(r.statut) || 0) + 1);
console.log("\nstatuts :", [...parStatut].sort((a, b) => b[1] - a[1])
  .map(([s, c]) => `${s}×${c}`).join(", ") || "aucune requete proxy");

const echecs = reponses.filter((r) => r.statut >= 400);
const parPile = new Map();
for (const r of echecs) parPile.set(r.pile, (parPile.get(r.pile) || 0) + 1);
console.log("origines des echecs :", [...parPile].sort((a, b) => b[1] - a[1])
  .map(([p, c]) => `${p}×${c}`).join(", ") || "aucun");

const parCible = new Map();
for (const r of echecs) parCible.set(r.cible, (parCible.get(r.cible) || 0) + 1);
console.log("cibles les plus reessayees :", [...parCible].sort((a, b) => b[1] - a[1])
  .slice(0, 6).map(([c, n]) => `${c.split("/").pop()}×${n}`).join(", ") || "aucune");

/* Combien de segments DISTINCTS ont ete demandes, et par qui : c'est ce qui
   separe « hls.js remplit son tampon » d'un balayage de toute la timeline. */
const ok = reponses.filter((r) => r.statut === 200);
console.log(
  `\n200 : ${ok.length} requetes, ${new Set(ok.map((r) => r.cible)).size} cibles distinctes`,
);
const parPile200 = new Map();
for (const r of ok) parPile200.set(r.pile, (parPile200.get(r.pile) || 0) + 1);
console.log("origines des 200 :", [...parPile200].sort((a, b) => b[1] - a[1])
  .slice(0, 5).map(([p, c]) => `${p}×${c}`).join(", "));
const exemple = echecs[0] || ok[0];
if (exemple) console.log("pile d'un exemple :", exemple.noms?.join(" ← ") || "-");

ws.close();
chrome.kill();
process.exit(0);
