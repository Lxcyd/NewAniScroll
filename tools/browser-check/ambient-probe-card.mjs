/**
 * La meme mesure que ambient-probe.mjs, mais sur la carte au survol : couleur
 * de l'image de la carte contre couleur du halo juste a cote. C'est la
 * REFERENCE — la lumiere que celle du lecteur doit egaler.
 *
 *   CARD=3 node tools/browser-check/ambient-probe-card.mjs https://dev.aniscroll.com/fr [out.png]
 *
 * `CARD` est le rang de la vignette survolee parmi les `[data-anime-preview]`
 * de la page ; toutes ne portent pas une bande-annonce, d'ou le reglage.
 *
 * Le survol est un VRAI survol (Input.dispatchMouseEvent) et non un evenement
 * synthetique : le provider n'ouvre la carte que si le pointeur se pose et ne
 * bouge plus (voir HoverPreviewProvider), donc on envoie deux deplacements au
 * meme point. Et Chrome tourne ici SANS `--disable-gpu` : la bande-annonce est
 * une video YouTube, qu'un Chrome sans GPU ne decode pas toujours.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9363);
const profil = mkdtempSync(join(tmpdir(), "aniscroll-cdp-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profil}`, "--no-first-run", "--no-default-browser-check",
  "--mute-audio", "--autoplay-policy=no-user-gesture-required",
  "--window-size=1600,900", "--hide-scrollbars",
], { stdio: "ignore" });

const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const attends = async (fn, max = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - t0 > max) throw new Error("Chrome ne repond pas");
    await dors(300);
  }
};
await attends(() => fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()));
const onglet = await fetch(
  `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`,
  { method: "PUT" },
).then((r) => r.json());
const ws = new WebSocket(onglet.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const attente = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && attente.has(msg.id)) { attente.get(msg.id)(msg); attente.delete(msg.id); }
};
const envoie = (method, params = {}) => new Promise((res) => {
  const id = ++n; attente.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evalue = async (expression, awaitPromise = false) => {
  const r = await envoie("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text;
};
await envoie("Runtime.enable");

await dors(6000);
await evalue(`(() => { for (const b of document.querySelectorAll("button")) {
  const t = (b.textContent || "").trim();
  if (/^(Compris.*|Continuer|Terminer|Fermer|Plus tard|Valider.*)$/i.test(t)) b.click();
} })()`);
await dors(1500);

const cible = await evalue(`(() => {
  const els = [...document.querySelectorAll("[data-anime-preview]")];
  const el = els[Number(${JSON.stringify(process.env.CARD || "2")})] || els[0];
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), id: el.getAttribute("data-anime-preview"), total: els.length };
})()`);
console.log("carte visee :", JSON.stringify(cible));
if (!cible) { console.log("aucune carte"); process.exit(1); }
await dors(500);

// Un vrai survol : on arrive, puis on ne bouge plus (deux evenements au meme
// point — le provider n'ouvre que sur un pointeur au repos).
for (const [dx, dy] of [[-40, -40], [0, 0], [0, 0]]) {
  await envoie("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: cible.x + dx, y: cible.y + dy, buttons: 0,
  });
  await dors(400);
}

let etat = null;
for (let t = 0; t < 30; t++) {
  await dors(1000);
  etat = await evalue(`(() => {
    const root = document.querySelector(".as-preview-root");
    if (!root) return "pas de carte";
    const frames = [...document.querySelectorAll("iframe")].length;
    const r = root.getBoundingClientRect();
    return { carte: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, iframes: frames };
  })()`);
  console.log(`t+${t + 1}s`, JSON.stringify(etat));
  if (etat && etat.iframes >= 2 && t > 6) break;
}

const png = await envoie("Page.captureScreenshot", { format: "png" });
if (out) writeFileSync(out, Buffer.from(png.result.data, "base64"));
await evalue(`window.__shot = ${JSON.stringify(png.result.data)}; "ok"`);

const r = await evalue(`(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + window.__shot;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const moyenne = (px, py, w, h) => {
    const d = x.getImageData(Math.round(px), Math.round(py), Math.round(w), Math.round(h)).data;
    let r=0,g=0,b=0; for (let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];}
    const k=d.length/4; return [r/k,g/k,b/k].map(v=>Math.round(v));
  };
  const hsl = ([r,g,b]) => { r/=255;g/=255;b/=255;
    const mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2,d=mx-mn;
    let h=0,s=0; if(d){ s=d/(1-Math.abs(2*l-1));
      h = mx===r?((g-b)/d+(g<b?6:0)):mx===g?((b-r)/d+2):((r-g)/d+4); h*=60; }
    return { h: Math.round(h), s: Math.round(s*100), l: Math.round(l*100) }; };
  const root = document.querySelector(".as-preview-root").getBoundingClientRect();
  // La video occupe le haut de la carte (45 %).
  const vh = root.height * 0.45;
  const bandeW = Math.round(root.width * 0.2);
  const cy = root.y + vh * 0.25;
  const bh = Math.round(vh * 0.5);
  const out = {
    videoGauche: moyenne(root.x + 3, cy, bandeW, bh),
    videoDroite: moyenne(root.x + root.width - bandeW - 3, cy, bandeW, bh),
    videoTout:   moyenne(root.x + 2, root.y + 2, root.width - 4, vh - 4),
    haloGauche:  moyenne(Math.max(0, root.x - 34), cy, 30, bh),
    haloDroite:  moyenne(root.x + root.width + 4, cy, 30, bh),
  };
  const res = {};
  for (const [k, rgb] of Object.entries(out)) res[k] = { rgb, ...hsl(rgb) };
  return res;
})()`, true);
console.log(JSON.stringify(r, null, 1));
ws.close(); chrome.kill(); process.exit(0);
