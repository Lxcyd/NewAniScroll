/**
 * Ce que le lecteur du site AFFICHE, image par image, a des instants donnes.
 *
 * Pourquoi : les bornes OP/ED etaient verifiees sur des decodages ffmpeg du
 * detecteur, jamais sur l'image que le lecteur montre. Or l'heure du lecteur
 * depend de la variante jouee et du point de reprise (hls.js cale son horloge
 * sur le premier segment charge) : Railgun S ep1, Luc voyait a « Flux »
 * 22:01.55 une image situee 1 a 2 s plus loin que prevu (30/09/2026).
 *
 *   node tools/browser-check/frame-truth.mjs <url dev> <dossier> <t1> [t2 ...]
 *
 * Une seule visite. Pour chaque t (horloge du LECTEUR) : saut, attente de
 * l'image presentee (requestVideoFrameCallback), capture 160x90 en PNG, et
 * les lignes « Image » / « Flux » du panneau de stats (ouvert par « s »).
 * Ecrit <dossier>/truth.json ; spike/frame_match.py le compare au detecteur.
 * Jamais de boucle contre le site : espacer les executions.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, outDir, ...ts] = process.argv.slice(2);
if (!url || !outDir || !ts.length) {
  console.error("usage : node tools/browser-check/frame-truth.mjs <url> <dossier> <t1> [t2 ...]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9358);
const profil = mkdtempSync(join(tmpdir(), "aniscroll-cdp-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profil}`,
  "--no-first-run", "--no-default-browser-check", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
  "--window-size=1600,900"], { stdio: "ignore" });
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; }
  catch { if (i > 60) throw new Error("Chrome ne repond pas"); await dors(300); }
}
/* SEED_PROGRESS="<cle>=<secondes>" (ex. 16049:1=600) : poser un point de
   reprise AVANT d'ouvrir le lien, comme chez quelqu'un qui a deja regarde
   l'episode (un profil neuf ne voit pas les retours au minutage sauvegarde).
   On passe par robots.txt du meme domaine pour ecrire son localStorage. */
const SEED = process.env.SEED_PROGRESS;
/* UA_NORMAL=1 : se presenter comme un Chrome ordinaire. En headless, l'agent
   dit « HeadlessChrome » et vidmoly refuse l'extraction : la page basculait sur
   frembed, et le lien horodate vise sur vidmoly n'etait jamais observe
   (02/10/2026). */
const UA_NORMAL = !!process.env.UA_NORMAL;
const premier = SEED ? new URL(url).origin + "/robots.txt" : process.env.TRACE_REMOVE || UA_NORMAL ? "about:blank" : url;
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
if (UA_NORMAL) {
  const v = await send("Browser.getVersion");
  const ua = String(v.result?.userAgent || "").replace("HeadlessChrome", "Chrome");
  if (ua) await send("Network.setUserAgentOverride", { userAgent: ua });
  if (!SEED && !process.env.TRACE_REMOVE) await send("Page.navigate", { url });
}
/* TRACE_REMOVE=1 : dire QUEL noeud React n'arrive pas a retirer (le message
   « removeChild: not a child » ne nomme ni le noeud ni son vrai parent). */
if (process.env.TRACE_REMOVE) {
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const d = (n) => n ? (n.nodeName + (n.id ? "#" + n.id : "") + (n.className && n.className.baseVal === undefined ? "." + String(n.className).split(" ").slice(0, 4).join(".") : "") + " " + String(n.outerHTML || n.textContent || "").slice(0, 160)) : "null";
    const o = Node.prototype.removeChild;
    Node.prototype.removeChild = function (c) {
      if (c && c.parentNode !== this) console.error("TRACE_REMOVE enfant=[" + d(c) + "] parent attendu=[" + d(this).slice(0, 120) + "] parent reel=[" + d(c.parentNode).slice(0, 120) + "]");
      return o.call(this, c);
    };
  })()` });
  if (!SEED) await send("Page.navigate", { url });
}
if (SEED) {
  await dors(1500);
  const [cle, sec] = SEED.split("=");
  await evalue(`localStorage.setItem("aniscroll:progress", JSON.stringify({ ${JSON.stringify(cle)}: { time: ${Number(sec)}, duration: 1424, updatedAt: Date.now() } }))`);
  await send("Page.navigate", { url });
  await dors(1000);
}
/* THROTTLE_KBPS : brider le debit pour que l'ABR reste sur une variante basse
   (Luc regardait megaplay en 480p ; le banc montait en 720p). */
if (process.env.THROTTLE_KBPS) {
  const bps = (Number(process.env.THROTTLE_KBPS) * 1000) / 8;
  await send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: bps, uploadThroughput: bps });
}

let pret = null;
for (let i = 0; i < 90 && !pret; i++) {
  if (i % 5 === 4) console.log("  attente video", i + 1, await evalue(`JSON.stringify([location.search, document.querySelectorAll("iframe").length, !!document.querySelector("video")])`));
  pret = await evalue(`(() => { const v = document.querySelector("video"); return v && v.readyState >= 2 && v.duration > 0 ? v.duration : null })()`);
  if (!pret) await dors(1000);
}
if (!pret) { console.error("video jamais prete"); chrome.kill(); process.exit(2); }

// Panneau de stats : touche « s » (keybinding toggleStats).
await evalue(`document.querySelector("video")?.focus()`);
for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "s", code: "KeyS", text: type === "keyDown" ? "s" : undefined, windowsVirtualKeyCode: 83 });
await dors(800);

const segs = () => ev.filter((e) => e.method === "Network.requestWillBeSent").map((e) => {
  let u = e.params.request.url;
  if (u.includes("url=")) u = decodeURIComponent(u.split("url=")[1] || "");
  return u.split("?")[0].split("/").slice(-1)[0];
}).filter((u) => /seg|\.ts|m3u8/.test(u));

const releves = [];
/* PLAY_S=<secondes> : au lieu de sauts en pause, on part du premier t et on
   LAISSE JOUER ; chaque ~5e image presentee est capturee avec la ligne « Flux »
   lue au meme instant. C'est ce que voit quelqu'un qui regarde. */
if (process.env.PLAY_S) {
  const r = await evalue(`(async () => {
    const v = document.querySelector("video");
    v.pause();
    await new Promise((res) => { v.addEventListener("seeked", res, { once: true }); v.currentTime = ${Number(ts[0])}; setTimeout(res, 20000); });
    await new Promise((res) => setTimeout(res, 3000));
    const out = []; let k = 0;
    const lire = () => {
      const l = {};
      for (const row of document.querySelectorAll("div.flex.items-center.justify-between")) {
        const s = row.querySelectorAll("span"); if (s.length === 2) l[s[0].textContent.trim()] = s[1].textContent.trim();
      }
      return l;
    };
    await new Promise((res) => {
      const fin = performance.now() + ${Number(process.env.PLAY_S)} * 1000;
      const cb = (_n, m) => {
        if (k++ % 5 === 0) {
          const c = document.createElement("canvas"); c.width = 160; c.height = 90;
          c.getContext("2d").drawImage(v, 0, 0, 160, 90);
          const l = lire();
          out.push({ mediaTime: m.mediaTime, flux: l["Flux"] || null, image: l["Image"] || null, resolution: l["Résolution"] || null, img: c.toDataURL("image/png") });
        }
        if (performance.now() < fin) v.requestVideoFrameCallback(cb); else res();
      };
      v.requestVideoFrameCallback(cb);
      v.play();
    });
    v.pause();
    return out;
  })()`);
  for (const [i, x] of (r || []).entries()) {
    const fichier = `p_${String(i).padStart(3, "0")}.png`;
    writeFileSync(join(outDir, fichier), Buffer.from(x.img.split(",")[1], "base64"));
    /* « Flux » du panneau est rafraichi a chaque image, mais le texte peut
       avoir une image de retard : on garde aussi mediaTime pour recalculer. */
    releves.push({ t: x.mediaTime, mediaTime: x.mediaTime, image: x.image, flux: x.flux, resolution: x.resolution, png: fichier });
  }
  console.log(`${releves.length} images capturees en lecture`);
}
for (const t of process.env.PLAY_S ? [] : ts) {
  const avant = segs().length;
  /* t = « ici » : ne pas bouger, relever ce que le lecteur affiche de lui-meme
     (lien ?tf= de la page de releve, qui doit se poser seul sur l'image). */
  const ici = t === "ici";
  if (ici) {
    // Historique des positions pendant le chargement (diagnostic des liens ?tf=).
    /* ICI_S=<secondes> : suivre plus longtemps (vidmoly : extraction dans le
       navigateur, le lecteur arrive tard). On note aussi le lecteur reellement
       joue (`id=` de l'URL) et un eventuel repli en <iframe>. */
    for (let k = 0; k < Number(process.env.ICI_S || 8) * 2; k++) {
      const x = await evalue(`(() => { const v = document.querySelector("video"); return [v ? Math.round(v.currentTime * 100) / 100 : null, v ? v.paused : null, v ? v.readyState : null, v ? Math.round((v.duration || 0)) : null, document.querySelectorAll("iframe").length, location.search, [...document.querySelectorAll("[data-releve-marks] div")].map((d) => d.style.left).join(" ")] })()`);
      console.log("  pos", k * 0.5, JSON.stringify(x));
      await dors(500);
    }
    /* SHOT=1 : capture de la PAGE (pas de l'image video), souris sur le lecteur
       pour faire sortir les controles — reperes de la barre de progression. */
    if (process.env.SHOT) {
      // Profil vierge : nouveautes et bandeau de preferences recouvrent le lecteur.
      for (let k = 0; k < 3; k++) {
        await evalue(`(() => { for (const b of document.querySelectorAll("button")) if (/^(Compris|Valider|Tout refuser|Refuser|Tout accepter|Accepter)/i.test(b.textContent.trim())) { b.click(); return } })()`);
        await dors(400);
      }
      const b = await evalue(`(() => { const r = document.querySelector("video").getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b[0] + b[2] / 2, y: b[1] + b[3] - 40 });
      await dors(800);
      const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: b[0], y: b[1] + b[3] - 140, width: b[2], height: 140, scale: 1 } });
      if (shot?.result?.data) writeFileSync(join(outDir, "barre.png"), Buffer.from(shot.result.data, "base64"));
    }
  }
  const r = await evalue(`(async () => {
    const v = document.querySelector("video");
    if (!${ici}) {
      v.pause();
      await new Promise((res) => { v.addEventListener("seeked", res, { once: true }); v.currentTime = ${Number(t) || 0}; setTimeout(res, 20000); });
    }
    const meta = await new Promise((res) => {
      if (!v.requestVideoFrameCallback) return res(null);
      v.requestVideoFrameCallback((_n, m) => res(m));
      setTimeout(() => res(null), 4000);
    });
    await new Promise((res) => setTimeout(res, 1200));
    const c = document.createElement("canvas"); c.width = 160; c.height = 90;
    let img = null;
    try { c.getContext("2d").drawImage(v, 0, 0, 160, 90); img = c.toDataURL("image/png"); } catch (e) { img = "ERR " + e; }
    const lignes = {};
    for (const row of document.querySelectorAll("div.flex.items-center.justify-between")) {
      const s = row.querySelectorAll("span");
      if (s.length === 2) lignes[s[0].textContent.trim()] = s[1].textContent.trim();
    }
    return { paused: v.paused, cur: v.currentTime, mediaTime: meta ? meta.mediaTime : null, img, image: lignes["Image"] || null, flux: lignes["Flux"] || null, resolution: lignes["Résolution"] || null };
  })()`);
  const fichier = `t_${t}.png`;
  if (r?.img?.startsWith("data:")) writeFileSync(join(outDir, fichier), Buffer.from(r.img.split(",")[1], "base64"));
  const rec = { t: ici ? "ici" : Number(t), paused: r?.paused, cur: r?.cur, mediaTime: r?.mediaTime, image: r?.image, flux: r?.flux, resolution: r?.resolution, png: fichier, segments: segs().slice(avant) };
  releves.push(rec);
  console.log(JSON.stringify({ ...rec, segments: rec.segments.slice(0, 4) }));
}
/* THEN_PLAY=<secondes> : apres les releves, appuyer sur lecture (clic au
   centre du lecteur, comme Luc) et suivre le lecteur. Sert a voir s'il
   DISPARAIT (PlayerErrorBoundary reste sur son repli) ou repart ailleurs. */
if (process.env.THEN_PLAY) {
  const boite = await evalue(`(() => { const r = document.querySelector("video")?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null })()`);
  if (boite) {
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: boite[0], y: boite[1], button: "left", clickCount: 1 });
  }
  for (let k = 0; k < Number(process.env.THEN_PLAY) * 2; k++) {
    const x = await evalue(`(() => { const v = document.querySelector("video"); return v ? [Math.round(v.currentTime * 100) / 100, v.paused, v.readyState, !!document.querySelector(".aniscroll-skip-btn"), !!document.querySelector(".aniscroll-next-btn")] : "PLUS DE VIDEO" })()`);
    console.log("  lecture", k * 0.5, JSON.stringify(x));
    await dors(500);
    // Le clic synthetique ne lance pas toujours la lecture en headless.
    if (k === 1 && Array.isArray(x) && x[1]) await evalue(`document.querySelector("video")?.play().catch(() => {})`);
  }
}
if (process.env.CONSOLE) {
  for (const e of ev.filter((x) => x.method === "Runtime.consoleAPICalled" || x.method === "Runtime.exceptionThrown")) {
    const a = e.params.args ? e.params.args.map((x) => x.value ?? x.description ?? "").join(" ") : JSON.stringify(e.params.exceptionDetails?.exception?.description || "");
    if (/hls|diag|resume|tf|seek|reprise|error|Error|TRACE_REMOVE/i.test(a)) console.log("  console", String(a).slice(0, Number(process.env.CONSOLE) > 1 ? 1500 : 220));
  }
}
writeFileSync(join(outDir, "truth.json"), JSON.stringify({ url, releves, segments_depart: segs().slice(0, 10) }, null, 1));
ws.close();
chrome.kill();
process.exit(0);
