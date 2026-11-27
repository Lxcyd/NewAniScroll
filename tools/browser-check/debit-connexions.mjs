/**
 * La carte des BRIDAGES de debit, CDN par CDN.
 *
 * Pourquoi (27/11/2026) : un CDN qui bride PAR CONNEXION ne bride pas le
 * total. Si une connexion plafonne a 5 Mo/s et que quatre en font 18, un
 * segment de 9 Mo (vidmoly en 1080p) arrive en 0,5 s au lieu de 1,8 — c'est
 * exactement l'attente qui suit un saut. Avant d'ecrire un chargeur parallele,
 * on mesure : ce script dit, pour le CDN d'un serveur donne,
 *   - s'il respecte `Range` (206) ou rend le fichier entier (200) ;
 *   - le protocole (h1.1 = 6 connexions max par hote, h2/h3 = multiplexe) ;
 *   - le debit d'UN segment en 1, 2, 4 et 6 morceaux paralleles (Range) ;
 *   - le debit cumule de 1, 2, 4 et 6 segments DISTINCTS en parallele.
 *
 *   node tools/browser-check/debit-connexions.mjs <serveur> [aniId] [episode]
 *
 * Deroulement : on ouvre la page de lecture sur dev (les jetons vidmoly sont
 * lies a l'IP : il faut le navigateur de la machine), on releve l'adresse de
 * la playlist de segments que le lecteur charge, puis on QUITTE la page pour
 * une page vide du meme site (robots.txt) — plus de lecteur qui concurrence —
 * et on y joue les mesures avec fetch(no-store). Chaque mesure prend des
 * segments differents : ni le cache du navigateur ni celui du CDN ne servent
 * deux fois le meme.
 *
 * UNE visite de la page de lecture par execution (limiteur par IP de
 * /api/v2/source) ; les requetes suivantes vont au CDN, pas au site. Espacer
 * les executions.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [serveur, aniId = "154587", episode = "1"] = process.argv.slice(2);
if (!serveur) {
  console.error("usage : node tools/browser-check/debit-connexions.mjs <serveur> [aniId] [episode]");
  process.exit(1);
}
const BASE = process.env.SITE || "https://dev.aniscroll.com";
const url = `${BASE}/en/anime/watch/${aniId}/x?num=${episode}&server=${serveur}`;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9361);
const profil = mkdtempSync(join(tmpdir(), "aniscroll-debit-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profil}`,
  "--no-first-run", "--no-default-browser-check", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
  "--window-size=1600,900",
  // Le WAF Cloudflare defie « HeadlessChrome » (cf. player-timeline.mjs).
  "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"],
  { stdio: "ignore" });
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; }
  catch { if (i > 60) throw new Error("Chrome ne repond pas"); await dors(300); }
}
const onglet = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(onglet.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const att = new Map();
const ev = [];
ws.onmessage = (m) => {
  const x = JSON.parse(m.data);
  if (x.id && att.has(x.id)) { att.get(x.id)(x); att.delete(x.id); } else if (x.method) ev.push(x);
};
const send = (method, params = {}) => new Promise((res) => { const id = ++n; att.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalue = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "erreur page");
  return r.result?.result?.value;
};
await send("Network.enable");
await send("Page.enable");
await send("Page.navigate", { url });
console.log(`→ ${url}`);

/* La playlist de SEGMENTS : la premiere reponse m3u8 qui n'est pas un master.
   On attend jusqu'a 40 s. */
let playlist = null;
for (let i = 0; i < 80 && !playlist; i++) {
  await dors(500);
  for (const e of ev) {
    if (e.method !== "Network.responseReceived") continue;
    const u = e.params.response.url;
    if (!/\.m3u8/i.test(decodeURIComponent(u))) continue;
    const corps = await send("Network.getResponseBody", { requestId: e.params.requestId });
    const texte = corps.result?.base64Encoded ? Buffer.from(corps.result.body, "base64").toString() : corps.result?.body || "";
    if (/#EXTINF/.test(texte)) { playlist = { url: u, texte }; break; }
  }
}
if (!playlist) {
  console.log("aucune playlist de segments en 40 s (lecteur en iframe ? serveur absent ?)");
  ws.close(); chrome.kill(); process.exit(2);
}
const segs = playlist.texte.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  .map((l) => new URL(l, playlist.url).toString());
console.log(`playlist : ${segs.length} segments · ${new URL(playlist.url).hostname}`);

/* Hors du lecteur : une page vide du meme site, pour que hls.js ne concurrence
   plus les mesures et que l'Origin reste celle du site (CORS). */
await send("Page.navigate", { url: `${BASE}/robots.txt` });
await dors(2500);

const MESURE = `async (segs, plan) => {
  const t = () => performance.now();
  const proto = (u) => {
    const e = performance.getEntriesByName(u).pop();
    return e ? e.nextHopProtocol || "?" : "?";
  };
  const lire = async (u, debut, fin) => {
    const h = {};
    if (debut != null) h.Range = "bytes=" + debut + "-" + (fin == null ? "" : fin);
    const r = await fetch(u, { headers: h, cache: "no-store", referrerPolicy: "no-referrer" });
    const b = await r.arrayBuffer();
    return { statut: r.status, octets: b.byteLength, total: Number((r.headers.get("content-range") || "").split("/")[1]) || null };
  };
  const out = [];
  let i = Math.min(Math.floor(segs.length * 0.3), segs.length - 1);
  const prochain = () => segs[(i++) % segs.length];
  // 1. Range respecte ? Et la taille d'un segment.
  const sonde = prochain();
  const s = await lire(sonde, 0, 1023);
  out.push({ test: "range", statut: s.statut, octets: s.octets, total: s.total, proto: proto(sonde) });
  const rangeOk = s.statut === 206 && s.total;
  // 2. UN segment en N morceaux paralleles.
  if (rangeOk) for (const k of plan) {
    const u = prochain();
    const tete = await lire(u, 0, 0);
    const taille = tete.total;
    const part = Math.ceil(taille / k);
    const t0 = t();
    const r = await Promise.all(Array.from({ length: k }, (_, j) =>
      lire(u, j * part, Math.min(taille, (j + 1) * part) - 1)));
    const ms = t() - t0;
    const oct = r.reduce((a, x) => a + x.octets, 0);
    out.push({ test: "morceaux", k, ms: Math.round(ms), Mo: +(oct / 1e6).toFixed(2), MoS: +(oct / 1e3 / ms).toFixed(2), statuts: [...new Set(r.map((x) => x.statut))] });
  }
  // 3. K segments DISTINCTS en parallele.
  for (const k of plan) {
    const us = Array.from({ length: k }, prochain);
    const t0 = t();
    let r;
    try { r = await Promise.all(us.map((u) => lire(u))); }
    catch (e) { out.push({ test: "segments", k, erreur: String(e) }); continue; }
    const ms = t() - t0;
    const oct = r.reduce((a, x) => a + x.octets, 0);
    out.push({ test: "segments", k, ms: Math.round(ms), Mo: +(oct / 1e6).toFixed(2), MoS: +(oct / 1e3 / ms).toFixed(2), statuts: [...new Set(r.map((x) => x.statut))] });
  }
  return out;
}`;
let res;
try {
  res = await evalue(`(${MESURE})(${JSON.stringify(segs)}, [1, 2, 4, 6])`);
} catch (e) {
  console.log("mesure impossible :", e.message);
  ws.close(); chrome.kill(); process.exit(3);
}
for (const r of res) {
  if (r.test === "range") console.log(`Range : ${r.statut === 206 ? "RESPECTE (206)" : `IGNORE (${r.statut})`} · segment ${r.total ? (r.total / 1e6).toFixed(1) + " Mo" : "?"} · protocole ${r.proto}`);
  else if (r.erreur) console.log(`${r.test} ×${r.k} : ${r.erreur}`);
  else console.log(`${r.test.padEnd(8)} ×${r.k} : ${String(r.ms).padStart(5)} ms · ${r.Mo} Mo · ${r.MoS} Mo/s · statut ${r.statuts.join("/")}`);
}
ws.close();
chrome.kill();
process.exit(0);
