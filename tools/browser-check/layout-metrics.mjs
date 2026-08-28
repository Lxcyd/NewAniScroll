/**
 * Mesurer la geometrie reelle de la page /watch, au pixel : marges laterales,
 * air sous la barre de serveurs, et surtout l'OVERHEAD VERTICAL — tout ce que
 * la colonne de gauche porte en plus du lecteur.
 *
 * Pourquoi : la largeur de la colonne du lecteur se calcule depuis la hauteur
 * de l'ecran moins cet overhead (voir la grille de pages/en/anime/watch), donc
 * une constante fausse de quelques pixels se voit directement en bas de page.
 * Trois estimations successives ont rate la cible ; la mesure, elle, a donne
 * 143px du premier coup. A rejouer apres tout changement de hauteur dans cette
 * colonne (padding haut, hauteur de la barre de serveurs, cadre du lecteur).
 *
 *   node tools/browser-check/layout-metrics.mjs <url> [largeur] [hauteur]
 *
 * Meme plomberie CDP que watch-check.mjs — vrai Chrome, aucune dependance — et
 * la meme precaution : chaque chargement consomme le limiteur par IP de
 * /api/v2/source. Espacer les executions.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, w = "1920", h = "980"] = process.argv.slice(2);
const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9357);

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
    `--window-size=${w},${h}`,
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
  if (msg.id && attente.has(msg.id)) {
    attente.get(msg.id)(msg);
    attente.delete(msg.id);
  }
};
const envoie = (method, params = {}) =>
  new Promise((res) => {
    const id = ++n;
    attente.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await envoie("Runtime.enable");
await dors(9000);

const releve = `(() => {
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { top: Math.round(r.top + scrollY), bottom: Math.round(r.bottom + scrollY),
             left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) }; };
  const def = document.getElementById("default");
  const prim = document.getElementById("primary");
  const sec = document.getElementById("secondary");
  const det = document.getElementById("details");
  const bar = prim && prim.querySelector('[class*="mt-3"]');
  const box = prim && prim.firstElementChild;
  const eps = sec && sec.querySelector('[class*="flex-col"]');
  return {
    vp: { w: innerWidth, h: innerHeight },
    default: R(def), primary: R(prim), secondary: R(sec), details: R(det),
    playerBox: R(box), serversBar: R(bar), epsCard: R(eps),
    fontSize: getComputedStyle(document.documentElement).fontSize,
  };
})()`;

const { result } = await envoie("Runtime.evaluate", {
  expression: releve,
  returnByValue: true,
});
const m = result.result.value;
console.log(JSON.stringify(m, null, 2));

if (m && m.serversBar && m.default) {
  const gaucheDef = m.default.left;
  const droiteDef = m.vp.w - m.default.right;
  const bas = m.vp.h - m.serversBar.bottom;
  const overhead = m.serversBar.bottom - m.playerBox.h;
  console.log(
    `\nmarge gauche=${gaucheDef}px  droite=${droiteDef}px  air sous serveurs=${bas}px` +
      `\noverhead vertical (hors lecteur) = ${overhead}px = ${(overhead / 16).toFixed(2)}rem` +
      `\nlecteur ${m.playerBox.w}x${m.playerBox.h}  |  liste eps ${m.epsCard ? m.epsCard.w : "?"}px`,
  );
}

ws.close();
chrome.kill();
