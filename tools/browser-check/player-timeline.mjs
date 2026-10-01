/**
 * La chronologie d'une ouverture de lecteur, maillon par maillon.
 *
 * Pourquoi : « les lecteurs sont lents » (01/10/2026) ne dit ni lequel, ni a
 * quel moment, ni si c'est le code de la page, le Worker ou le CDN. Ce banc
 * ouvre UNE page dans un vrai Chrome et chronometre chaque maillon ; rejoue
 * sur dev et sur la prod avec le meme episode, il separe « le code a ralenti »
 * de « le cas d'usage a change ».
 *
 *   node tools/browser-check/player-timeline.mjs <url> [secondes de lecture]
 *
 * Il imprime :
 *   - document et /api/v2/source : duree, cache ;
 *   - playlists et premiers segments : duree, statut, cache du Worker, Ko/s ;
 *   - premiere image (requestVideoFrameCallback) ;
 *   - hauteur jouee et avance du tampon a 5, 15 et 30 s, les `waiting` ;
 *   - deux sauts (+5 min, puis -2 min) : ms jusqu'a l'image presentee ;
 *   - toute reponse en erreur sur le chemin video, et les hotes contactes.
 *
 * SEED_LS='{"cle":"valeur"}' : poser du localStorage avant d'ouvrir le lien
 * (un debit memorise, un point de reprise). SAUTS=0 : pas de sauts.
 *
 * Une seule visite, jamais de boucle contre le site : espacer les executions
 * (limiteur par IP de /api/v2/source).
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, duree = "30"] = process.argv.slice(2);
if (!url) {
  console.error("usage : node tools/browser-check/player-timeline.mjs <url> [secondes]");
  process.exit(1);
}
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9359);
const profil = mkdtempSync(join(tmpdir(), "aniscroll-cdp-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profil}`,
  "--no-first-run", "--no-default-browser-check", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
  "--window-size=1600,900"], { stdio: "ignore" });
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; }
  catch { if (i > 60) throw new Error("Chrome ne repond pas"); await dors(300); }
}
const SEED = process.env.SEED_LS ? JSON.parse(process.env.SEED_LS) : null;
const premier = SEED ? new URL(url).origin + "/robots.txt" : "about:blank";
const onglet = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(premier)}`, { method: "PUT" }).then((r) => r.json());
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
const evalue = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Network.enable");
await send("Runtime.enable");
await send("Page.enable");
if (SEED) {
  await dors(1500);
  for (const [k, v] of Object.entries(SEED)) {
    await evalue(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === "string" ? v : JSON.stringify(v))})`);
  }
}
/* Temoin pose avant tout script de la page : il guette le <video>, note la
   premiere image presentee et cumule les attentes (`waiting` → `playing`). */
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const t = (window.__tl = { image: null, imageA: null, video: null, attentes: [], enAttente: null, tete: [] });
  let vu = null;
  /* La tete de lecture et le compteur affiche, toutes les 100 ms : combien de
     temps la barre reste a 0:00 quand on ouvre a un minutage. */
  setInterval(() => {
    const v = document.querySelector("video");
    if (!v || t.tete.length > 400) return;
    const c = document.querySelector('.vds-time[data-type="current"]');
    t.tete.push([Math.round(performance.now()), Math.round(v.currentTime * 10) / 10, c ? c.textContent.trim() : null]);
  }, 100);
  setInterval(() => {
    const v = document.querySelector("video");
    if (!v || v === vu) return;
    vu = v;
    if (!t.video) t.video = performance.now();
    v.requestVideoFrameCallback?.((_n, m) => { if (t.image == null) { t.image = performance.now(); t.imageA = m.mediaTime; } });
    v.addEventListener("waiting", () => { if (t.image != null && t.enAttente == null) t.enAttente = performance.now(); });
    const fin = () => { if (t.enAttente != null) { t.attentes.push(Math.round(performance.now() - t.enAttente)); t.enAttente = null; } };
    v.addEventListener("playing", fin);
    v.addEventListener("seeked", fin);
  }, 50);
})()` });
await send("Page.navigate", { url });
console.log(`→ ${url}`);

let image = null;
for (let i = 0; i < 120 && image == null; i++) {
  await dors(500);
  image = await evalue(`window.__tl ? window.__tl.image : null`);
}
if (image == null) console.log("premiere image : AUCUNE en 60 s");
else {
  const video = await evalue(`window.__tl.video`);
  const imageA = await evalue(`window.__tl.imageA`);
  console.log(`<video> a ${(video / 1000).toFixed(2)} s, premiere image a ${(image / 1000).toFixed(2)} s (image du fichier : ${imageA == null ? "?" : imageA.toFixed(1) + " s"})`);
  /* Les paliers de la tete de lecture jusqu'a 3 s apres la premiere image. */
  const tete = (await evalue(`window.__tl.tete`)) || [];
  const paliers = [];
  for (const [quand, ct, compteur] of tete) {
    if (quand > image + 3000) break;
    const d = paliers[paliers.length - 1];
    const stable = d && Math.abs(d.ct - ct) < 1.5 && d.compteur === compteur;
    if (stable) d.fin = quand;
    else if (!d || Math.abs(d.ct - ct) >= 1.5 || d.compteur !== compteur) paliers.push({ debut: quand, fin: quand, ct, compteur });
  }
  console.log("  tete de lecture : " + paliers.slice(0, 8).map((x) => `${(x.debut / 1000).toFixed(1)}-${(x.fin / 1000).toFixed(1)} s → ${x.ct} s [${x.compteur ?? "sans compteur"}]`).join("  |  "));
}

const etat = `(() => {
  const v = document.querySelector("video");
  if (!v) return null;
  let avance = 0;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) > v.currentTime) avance = v.buffered.end(i) - v.currentTime;
  }
  return { t: Math.round(v.currentTime * 10) / 10, pause: v.paused, h: v.videoHeight, avance: Math.round(avance), attentes: window.__tl.attentes.slice() };
})()`;
if (image != null) {
  await evalue(`document.querySelector("video")?.play().catch(() => {})`);
  let ecoule = 0;
  for (const palier of [5, 15, Number(duree)]) {
    await dors((palier - ecoule) * 1000);
    ecoule = palier;
    const e = await evalue(etat);
    console.log(`  +${String(palier).padStart(2)} s  ${e ? `tete ${e.t} s · ${e.h}p · ${e.avance} s d'avance${e.pause ? " · EN PAUSE" : ""}` : "plus de <video>"}`);
  }
  const e = await evalue(etat);
  const att_ = e?.attentes || [];
  console.log(`  attentes en lecture : ${att_.length} (${att_.reduce((a, b) => a + b, 0)} ms)`);

  if (process.env.SAUTS !== "0") {
    for (const [nom, delta] of [["+5 min", 300], ["-2 min", -120]]) {
      const r = await evalue(`(async () => {
        const v = document.querySelector("video");
        if (!v || !(v.duration > 0)) return null;
        const cible = Math.max(0, Math.min(v.duration - 30, v.currentTime + ${delta}));
        const t0 = performance.now();
        const fin = new Promise((res) => {
          v.addEventListener("seeked", () => {
            if (!v.requestVideoFrameCallback) return res(performance.now() - t0);
            v.requestVideoFrameCallback(() => res(performance.now() - t0));
          }, { once: true });
          setTimeout(() => res(null), 45000);
        });
        v.currentTime = cible;
        const ms = await fin;
        return { cible: Math.round(cible), ms: ms == null ? null : Math.round(ms), h: v.videoHeight };
      })()`);
      console.log(`  saut ${nom} : ${r ? (r.ms == null ? "RIEN en 45 s" : `${r.ms} ms`) + ` (vers ${r.cible} s, ${r.h}p)` : "impossible"}`);
      await dors(3000);
    }
  }
}

/* ── Le reseau ── */
const req = new Map();
let t0 = null;
for (const e of ev) {
  const p = e.params;
  if (e.method === "Network.requestWillBeSent") {
    if (t0 == null && p.type === "Document" && p.request.url.startsWith(url.split("?")[0])) t0 = p.timestamp;
    req.set(p.requestId, { url: p.request.url, type: p.type, debut: p.timestamp });
  } else if (e.method === "Network.responseReceived") {
    const r = req.get(p.requestId);
    if (!r) continue;
    r.statut = p.response.status;
    r.entetes = Object.fromEntries(Object.entries(p.response.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    r.reponse = p.timestamp;
  } else if (e.method === "Network.loadingFinished") {
    const r = req.get(p.requestId);
    if (r) { r.fin = p.timestamp; r.octets = p.encodedDataLength; }
  } else if (e.method === "Network.loadingFailed") {
    const r = req.get(p.requestId);
    if (r) { r.fin = p.timestamp; r.echec = p.errorText || "echec"; }
  }
}
const interne = (u) => (u.includes("/?url=") ? decodeURIComponent((u.split("url=")[1] || "").split("&")[0]) : u);
const court = (u) => { try { const x = new URL(interne(u)); return x.hostname + x.pathname.split("/").slice(-1)[0].slice(0, 40); } catch { return u.slice(0, 60); } };
const ligne = (r) => {
  const a = ((r.debut - t0) * 1000).toFixed(0).padStart(6);
  const d = r.fin ? `${((r.fin - r.debut) * 1000).toFixed(0)} ms` : "en vol";
  const ko = r.octets ? ` · ${(r.octets / 1024).toFixed(0)} Ko` : "";
  const debit = r.octets > 50000 && r.fin ? ` · ${(r.octets / 1024 / (r.fin - r.debut)).toFixed(0)} Ko/s` : "";
  const cache = r.entetes?.["x-aniscroll-cache"] || r.entetes?.["x-vercel-cache"] || "";
  // Le detail du rendu serveur, quand la route le publie (page de lecture).
  const st = r.entetes?.["server-timing"] ? `  {${r.entetes["server-timing"].replace(/;dur=/g, " ")}}` : "";
  return `  ${a} ms  ${String(r.echec || r.statut || "?").padEnd(4)} ${d}${ko}${debit}${cache ? ` · ${cache}` : ""}  ${r.viaWorker ? "[W] " : ""}${court(r.url)}${st}`;
};
const tout = [...req.values()].filter((r) => t0 != null && r.debut >= t0).sort((a, b) => a.debut - b.debut);
for (const r of tout) r.viaWorker = /proxy\.aniscroll\.com\/\?url=/.test(r.url);
const video = tout.filter((r) => ["XHR", "Fetch", "Media"].includes(r.type) &&
  (r.viaWorker || /\.m3u8|\/seg-|\.ts(\?|$)|\.m4s|\.mp4/i.test(r.url)) && !/aniscroll\.com\/api\//.test(r.url));
const playlists = video.filter((r) => /\.m3u8/i.test(interne(r.url)));
const segments = video.filter((r) => !/\.m3u8/i.test(interne(r.url)));

console.log("\ndocument et source :");
for (const r of tout.filter((r) => r.type === "Document" || /\/api\/v2\/source/.test(r.url)).slice(0, 8)) console.log(ligne(r));
/* TOUT=<secondes> : chaque requete partie dans cette fenetre, hors images et
   polices. Pour voir ce qui occupe le temps entre la source et le manifeste. */
if (process.env.TOUT) {
  console.log(`toutes les requetes des ${process.env.TOUT} premieres secondes :`);
  for (const r of tout.filter((r) => r.debut - t0 < Number(process.env.TOUT) && !["Image", "Font", "Stylesheet"].includes(r.type))) {
    console.log(ligne(r) + `  (${r.type})`);
  }
}
console.log("playlists :");
for (const r of playlists.slice(0, 4)) console.log(ligne(r));
console.log(`segments (${segments.length}), les 6 premiers :`);
for (const r of segments.slice(0, 6)) console.log(ligne(r));
const finis = segments.filter((r) => r.fin && r.octets > 50000);
if (finis.length) {
  const debits = finis.map((r) => r.octets / 1024 / (r.fin - r.debut)).sort((a, b) => a - b);
  const caches = {};
  for (const r of finis) { const c = r.entetes?.["x-aniscroll-cache"] || "direct"; caches[c] = (caches[c] || 0) + 1; }
  console.log(`  debit par segment : mediane ${debits[Math.floor(debits.length / 2)].toFixed(0)} Ko/s, mini ${debits[0].toFixed(0)}, maxi ${debits[debits.length - 1].toFixed(0)} · ${JSON.stringify(caches)}`);
}
const vus = new Map();
for (const r of segments) { const k = (() => { try { const x = new URL(interne(r.url)); return x.hostname + "/" + x.pathname.split("/").slice(-2).join("/"); } catch { return r.url; } })(); vus.set(k, (vus.get(k) || 0) + 1); }
const doubles = [...vus].filter(([k, c]) => c > 1 && !/init\.mp4$/.test(k));
console.log(`segments demandes plus d'une fois : ${doubles.length ? `${doubles.length} (` + doubles.slice(0, 4).map(([k, c]) => `${k.split("/").pop()}×${c}`).join(", ") + ")" : "aucun"}`);
const erreurs = video.filter((r) => r.echec || r.statut >= 400);
console.log(`erreurs sur le chemin video : ${erreurs.length}`);
for (const r of erreurs.slice(0, 8)) console.log(ligne(r));
const hotes = new Map();
for (const r of video) { try { const h = new URL(interne(r.url)).hostname; hotes.set(h, (hotes.get(h) || 0) + 1); } catch {} }
console.log("hotes contactes :", [...hotes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, c]) => `${h}×${c}`).join(", ") || "aucun");

ws.close();
chrome.kill();
process.exit(0);
