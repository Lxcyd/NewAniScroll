/**
 * La lumiere d'ambiance du LECTEUR dit-elle la couleur de l'image ?
 *
 * On compare, sur la meme frame gelee :
 *   - la couleur moyenne d'une bande de la video (bord gauche, bord droit,
 *     cadre entier),
 *   - la couleur du halo juste a l'exterieur du lecteur, a la meme hauteur.
 * Rendu en HSL, parce que c'est la que les deux fautes se lisent : une teinte
 * qui bouge (h), une lumiere plus lourde ou plus pale que l'image (s, l).
 *
 * Le pendant existe pour la carte au survol — ambient-probe-card.mjs, meme
 * mesure, meme sortie. C'est le seul moyen de comparer les deux lumieres
 * autrement qu'a l'oeil.
 *
 *   SCAN=180,360,540 node tools/browser-check/ambient-probe.mjs <url> [out.png]
 *   SEEK=360         node tools/browser-check/ambient-probe.mjs <url> [out.png]
 *
 * SCAN sonde plusieurs instants et garde le plus SATURE : une scene grise ne
 * dit rien d'une lumiere d'ambiance, et la plupart des ouvertures d'episode
 * sont noires. SEEK impose l'instant.
 *
 * Deux details qui ont coute du temps : la capture d'ecran est renvoyee DANS la
 * page (data: URL, same-origin, donc lisible) au lieu d'etre decodee ici —
 * Chrome sait deja decoder un PNG ; et la video est mise en PAUSE avant la
 * photo, sans quoi la mesure et l'image ne portent pas sur la meme frame.
 *
 * Voir aussi les pieges communs a ces sondes dans watch-check.mjs (le lecteur
 * joue n'est pas celui de l'URL ; le limiteur par IP de /api/v2/source).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9362);
const profil = mkdtempSync(join(tmpdir(), "aniscroll-cdp-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profil}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
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

const congedie = `(() => { let n = 0;
  for (const b of document.querySelectorAll("button")) {
    const t = (b.textContent || "").trim();
    if (/^(Compris.*|Continuer|Terminer|Fermer|Plus tard|Valider.*)$/i.test(t)) { b.click(); n++; }
  } return n; })()`;

for (let t = 0; t < 22; t++) {
  await dors(1000);
  await evalue(congedie);
  const e = await evalue(`(() => { const v = document.querySelector("video");
    if (!v) return "pas de video";
    if (v.readyState >= 3 && v.paused) { v.muted = true; v.play().catch(() => {}); }
    return { pret: v.readyState, t: Math.round(v.currentTime*10)/10 }; })()`);
  if (e && e.t > 3) break;
}
/* Une lumiere d'ambiance ne se juge pas sur une scene grise. On va donc
   CHERCHER une image coloree : quelques sondages dans le fichier, on garde la
   plus saturee. (Mesure faite dans la page, sur la video elle-meme.) */
if (process.env.SCAN) {
  const quand = process.env.SCAN.split(",").map(Number);
  let best = null;
  for (const s of quand) {
    await evalue(`(() => { document.querySelector("video").currentTime = ${s}; })()`);
    let ok = false;
    for (let t = 0; t < 10 && !ok; t++) {
      await dors(700);
      ok = await evalue(`(() => { const v = document.querySelector("video");
        return v.readyState === 4 && Math.abs(v.currentTime - ${s}) < 2; })()`) === true;
    }
    const m = await evalue(`(() => {
      const v = document.querySelector("video");
      const c = document.createElement("canvas"); c.width = 32; c.height = 18;
      const x = c.getContext("2d", { willReadFrequently: true });
      try { x.drawImage(v, 0, 0, 32, 18); } catch { return null; }
      let d; try { d = x.getImageData(0, 0, 32, 18).data; } catch { return null; }
      let r=0,g=0,b=0; for (let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];}
      const k=d.length/4; r/=k*255; g/=k*255; b/=k*255;
      const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2, dd=mx-mn;
      const s = dd ? dd/(1-Math.abs(2*l-1)) : 0;
      return { sat: Math.round(s*100), lum: Math.round(l*100) };
    })()`);
    console.log(`  ${s}s ->`, JSON.stringify(m));
    if (m && m.lum > 12 && (!best || m.sat > best.m.sat)) best = { s, m };
  }
  if (best) {
    console.log("retenu :", best.s + "s", JSON.stringify(best.m));
    process.env.SEEK = String(best.s);
  }
}
if (process.env.SEEK) {
  await evalue(`(() => { document.querySelector("video").currentTime = ${Number(process.env.SEEK)}; })()`);
  for (let t = 0; t < 12; t++) {
    await dors(1000);
    const e = await evalue(`(() => { const v = document.querySelector("video"); return { t: v.currentTime, pret: v.readyState }; })()`);
    if (e && e.pret === 4 && e.t > Number(process.env.SEEK) + 1) break;
  }
}
// L'ambient melange a la frame precedente : on la laisse se poser, puis on GELE
// la video pour que la photo et la mesure portent sur la meme image.
await dors(1500);
await evalue(`(() => { document.querySelector("video").pause(); })()`);
await dors(600);

const png = await envoie("Page.captureScreenshot", { format: "png" });
if (out) writeFileSync(out, Buffer.from(png.result.data, "base64"));

const mesure = `(async () => {
  const dataUrl = "data:image/png;base64," + window.__shot;
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const moyenne = (px, py, w, h) => {
    const d = x.getImageData(Math.round(px), Math.round(py), Math.round(w), Math.round(h)).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; }
    const k = d.length / 4;
    return [r/k, g/k, b/k].map((v) => Math.round(v));
  };
  const hsl = ([r, g, b]) => {
    r/=255; g/=255; b/=255;
    const mx = Math.max(r,g,b), mn = Math.min(r,g,b), l = (mx+mn)/2, d = mx-mn;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2*l - 1));
      h = mx === r ? ((g-b)/d + (g<b?6:0)) : mx === g ? ((b-r)/d + 2) : ((r-g)/d + 4);
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s*100), l: Math.round(l*100) };
  };

  const p = document.querySelector(".vds-player").getBoundingClientRect();
  const v = document.querySelector("video");
  // La video dans son cadre (elle peut etre lettreboxee) : on mesure les bandes
  // sur l'ELEMENT tel qu'il est a l'ecran, comme le halo les voit.
  const bandeW = Math.round(p.width * 0.18);
  const bandeH = Math.round(p.height * 0.5);
  const cy = p.y + p.height / 2 - bandeH / 2;
  const bords = {
    videoGauche: moyenne(p.x + 4, cy, bandeW, bandeH),
    videoDroite: moyenne(p.x + p.width - bandeW - 4, cy, bandeW, bandeH),
    videoTout:   moyenne(p.x + 2, p.y + 2, p.width - 4, p.height - 4),
  };
  // Le halo : une bande juste a l'exterieur, assez loin du bord pour ne pas
  // attraper la video elle-meme, assez pres pour etre le halo et pas la page.
  const halo = {
    haloGauche: moyenne(Math.max(0, p.x - 34), cy, 30, bandeH),
    haloDroite: moyenne(p.x + p.width + 4, cy, 30, bandeH),
  };
  const tout = { ...bords, ...halo };
  const sortie = {};
  for (const [k, rgb] of Object.entries(tout)) sortie[k] = { rgb, ...hsl(rgb) };
  return sortie;
})()`;

await evalue(`window.__shot = ${JSON.stringify(png.result.data)}; "ok"`);
const r = await evalue(mesure, true);
console.log(JSON.stringify(r, null, 1));
ws.close(); chrome.kill(); process.exit(0);
