/**
 * Ouvrir une page du site dans un VRAI Chrome et rapporter ce qu'elle montre.
 *
 * Pourquoi : il n'y avait aucun moyen de verifier une correction d'affichage
 * autrement qu'en demandant une capture d'ecran. Les mesures cote reseau
 * (ffmpeg, curl) disent ce que valent les flux, jamais ce que le lecteur en
 * fait. Ce script comble exactement ce trou, et sans rien installer : Chrome
 * est deja la, et Node 22 a un client WebSocket integre — donc pas de
 * Playwright, pas de dependance, pas de navigateur telecharge.
 *
 *   node tools/browser-check/watch-check.mjs <url> [secondes]
 *
 * Il imprime, chaque seconde : l'etat de la vignette d'ouverture
 * (`img.as-poster`), l'etat de la video, la luminance de sa premiere frame
 * mesuree comme le player la mesure, et si le canvas est lisible du tout.
 * Puis les hotes video reellement contactes — le seul moyen fiable de savoir
 * quel lecteur a joue, l'interface pouvant afficher autre chose.
 *
 * A savoir avant de s'en servir : en navigation headless et profil neuf, la
 * page ne choisit pas forcement le lecteur de l'URL (pas de preference, pas
 * d'historique, et un hote qui refuse une IP inconnue bascule sur le suivant).
 * Lire les hotes contactes, pas le nom du chip.
 *
 * Et une precaution : chaque chargement resout des lecteurs, donc consomme le
 * limiteur par IP de /api/v2/source (50 req/s, memoire du lambda). Enchainer
 * les executions rend des 429 — qui frappent aussi le navigateur de qui
 * partage cette IP. Espacer.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, secondes = "12"] = process.argv.slice(2);
if (!url) {
  console.error("usage : node tools/browser-check/watch-check.mjs <url> [secondes]");
  process.exit(1);
}

const CHROME =
  process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9355);

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
const evenements = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && attente.has(msg.id)) {
    attente.get(msg.id)(msg);
    attente.delete(msg.id);
  } else if (msg.method) evenements.push(msg);
};
const envoie = (method, params = {}) =>
  new Promise((res) => {
    const id = ++n;
    attente.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await envoie("Network.enable");
await envoie("Runtime.enable");

/* Mesure faite DANS la page, avec le meme calcul que le player : la frame
   reduite a 16x9, luminance Rec.709. `lisible: false` = canvas teinte, c'est
   la signature d'un flux sans en-tete CORS (sibnet, sendvid). */
const releve = `(() => {
  const img = document.querySelector("img.as-poster");
  const v = document.querySelector("video");
  let luma = null, lisible = null;
  if (v && v.readyState >= 2) {
    try {
      const c = document.createElement("canvas");
      c.width = 16; c.height = 9;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(v, 0, 0, 16, 9);
      const d = x.getImageData(0, 0, 16, 9).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4)
        s += d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
      luma = Math.round((s / (d.length / 4)) * 10) / 10;
      lisible = true;
    } catch { lisible = false; }
  }
  let memo = 0;
  try { memo = Object.keys(JSON.parse(localStorage.getItem("as:firstframe") || "{}")).length; } catch {}
  return {
    vignette: !img
      ? "aucun element"
      : img.className.includes("as-poster-off") ? "cachee" : "AFFICHEE",
    /* L'image est-elle DEJA telechargee ? C'est la seule chose qui compte au
       moment ou le verdict tombe : une vignette dont le fichier arrive apres
       coup laisse un trou noir. Le <link rel=preload> de la page /watch existe
       pour que ce soit vrai bien avant. */
    image: !img ? "-" : img.complete && img.naturalWidth > 0 ? "prete" : "en vol",
    preload: !!document.querySelector('link[rel="preload"][as="image"]'),
    video: v ? v.readyState : "aucune",
    lisible, luma,
    memo,
  };
})()`;

console.log(`→ ${url}`);
for (let t = 1; t <= Number(secondes); t++) {
  await dors(1000);
  const r = await envoie("Runtime.evaluate", {
    expression: releve,
    returnByValue: true,
  });
  console.log(
    `t+${String(t).padStart(2)}s  ${JSON.stringify(r.result?.result?.value)}`,
  );
}

const hotes = new Map();
for (const e of evenements.filter((x) => x.method === "Network.requestWillBeSent")) {
  const u = e.params.request.url;
  const interne = u.includes("proxy.aniscroll.com/?url=")
    ? decodeURIComponent(u.split("url=")[1] || "")
    : u;
  try {
    const h = new URL(interne).hostname;
    if (!/aniscroll|anilist|thetvdb|simkl|tmdb|google|vercel/i.test(h))
      hotes.set(h, (hotes.get(h) || 0) + 1);
  } catch {}
}
console.log(
  "\nhotes contactes :",
  [...hotes].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([h, c]) => `${h}×${c}`).join(", ") || "aucun",
);

ws.close();
chrome.kill();
process.exit(0);
