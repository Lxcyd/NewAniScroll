/**
 * Audit mobile : ouvrir des pages dans un VRAI Chrome emule en telephone et
 * relever ce qui casse a l'ecran.
 *
 *   node tools/browser-check/mobile-audit.mjs <base> <dossier-sortie> <chemin...>
 *   ex. node tools/browser-check/mobile-audit.mjs http://localhost:3124 out /en /en/schedule
 *
 * Pour chaque page, en 390x844 (iPhone 14), User-Agent iPhone, tactile :
 *  - capture pleine page  -> <dossier>/<slug>.png
 *  - debordement horizontal : largeur du document > ecran, et les elements
 *    fautifs (ceux qui depassent a droite sans etre dans un conteneur qui
 *    defile horizontalement)
 *  - cibles tactiles < 40 px (boutons, liens, champs visibles)
 *  - textes < 11 px
 *
 * Meme principe que watch-check.mjs : Chrome deja installe + WebSocket de
 * Node 22, aucune dependance. MOBILE_W / MOBILE_H changent l'ecran.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [base, sortie, ...chemins] = process.argv.slice(2);
if (!base || !sortie || !chemins.length) {
  console.error("usage : node tools/browser-check/mobile-audit.mjs <base> <dossier-sortie> <chemin...>");
  process.exit(1);
}
mkdirSync(sortie, { recursive: true });

const W = Number(process.env.MOBILE_W || 390);
const H = Number(process.env.MOBILE_H || 844);
const ATTENTE = Number(process.env.ATTENTE_MS || 6000);
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9356);

const profil = mkdtempSync(join(tmpdir(), "aniscroll-mobile-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profil}`,
   "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio"],
  { stdio: "ignore" },
);

const dors = (ms) => new Promise((r) => setTimeout(r, ms));
for (let t0 = Date.now(); ; ) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch {}
  if (Date.now() - t0 > 20000) throw new Error("Chrome ne repond pas");
  await dors(300);
}
const onglet = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(onglet.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const attente = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && attente.has(msg.id)) { attente.get(msg.id)(msg); attente.delete(msg.id); }
};
const envoie = (method, params = {}) =>
  new Promise((res) => { const id = ++n; attente.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await envoie("Page.enable");
await envoie("Runtime.enable");
await envoie("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await envoie("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await envoie("Emulation.setUserAgentOverride", { userAgent: UA, platform: "iPhone" });
await envoie("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });

const releve = `(() => {
  const vw = innerWidth;
  const nom = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const c = typeof el.className === "string" ? el.className.trim().split(/\\s+/).slice(0, 3).join(".") : "";
    if (c) s += "." + c;
    const t = (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30).replace(/\\s+/g, " ");
    return t ? s + ' "' + t + '"' : s;
  };
  const visible = (el, r) => {
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  // un parent qui defile ou coupe horizontalement => le debordement est voulu
  const contenu = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
    }
    return false;
  };
  const deborde = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    if ((r.right > vw + 1 || r.left < -1) && !contenu(el)) {
      // ne garder que le plus haut fautif : si le parent deborde deja, on saute
      const p = el.parentElement, pr = p && p.getBoundingClientRect();
      if (pr && (pr.right > vw + 1 || pr.left < -1) && !contenu(p)) continue;
      deborde.push(nom(el) + " [" + Math.round(r.left) + "→" + Math.round(r.right) + "]");
    }
  }
  const petits = [];
  for (const el of document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=tab]")) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    if (r.width < 40 || r.height < 40) petits.push(nom(el) + " " + Math.round(r.width) + "x" + Math.round(r.height));
  }
  let texteMini = 0; const exemplesTexte = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t; (t = tw.nextNode()); ) {
    if (!t.textContent.trim()) continue;
    const el = t.parentElement; const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 11) { texteMini++; if (exemplesTexte.length < 5) exemplesTexte.push(fs + "px " + nom(el)); }
  }
  return {
    url: location.pathname + location.search,
    largeurDoc: document.documentElement.scrollWidth, ecran: vw,
    hauteur: document.documentElement.scrollHeight,
    deborde: deborde.slice(0, 15), nbDeborde: deborde.length,
    ciblesPetites: petits.length, exemplesCibles: petits.slice(0, 8),
    texteMini, exemplesTexte,
  };
})()`;

const rapport = [];
for (const chemin of chemins) {
  const url = base.replace(/\/$/, "") + chemin;
  const slug = chemin.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "racine";
  await envoie("Page.navigate", { url });
  await dors(ATTENTE);
  // La fenetre « Nouveautes » s'ouvre au premier passage d'un profil neuf :
  // la fermer comme un visiteur, sinon elle masque le haut de chaque page.
  await envoie("Runtime.evaluate", {
    expression: `[...document.querySelectorAll("button")].find((b) => /^Compris/.test(b.innerText.trim()))?.click()`,
  });
  await dors(600);
  const r = (await envoie("Runtime.evaluate", { expression: releve, returnByValue: true })).result?.result?.value;
  // Captures ecran par ecran (une pleine page de 6000 px est illisible une
  // fois reduite). TRANCHES limite le nombre d'ecrans par page.
  const hauteur = r?.hauteur || H;
  const tranches = Math.min(Math.ceil(hauteur / H), Number(process.env.TRANCHES || 6));
  for (let i = 0; i < tranches; i++) {
    const cap = await envoie("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true,
      clip: { x: 0, y: i * H, width: W, height: Math.min(H, hauteur - i * H), scale: 1 },
    });
    if (cap.result?.data) writeFileSync(join(sortie, `${slug}-${i + 1}.png`), Buffer.from(cap.result.data, "base64"));
  }
  rapport.push({ chemin, ...r });
  console.log(`\n■ ${chemin}  doc ${r?.largeurDoc}px / ecran ${r?.ecran}px  · ${r?.nbDeborde} debordements · ${r?.ciblesPetites} cibles < 40px · ${r?.texteMini} textes < 11px`);
  for (const d of r?.deborde || []) console.log("   ↔ " + d);
  for (const c of (r?.exemplesCibles || []).slice(0, 4)) console.log("   ☐ " + c);
}
writeFileSync(join(sortie, "rapport.json"), JSON.stringify(rapport, null, 2));
ws.close();
chrome.kill();
process.exit(0);
