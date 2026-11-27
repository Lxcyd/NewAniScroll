/**
 * Qui deplace la tete de lecture ? Rejoue « lecture 30 s, saut +5 min, saut
 * -2 min » et enregistre CHAQUE ecriture de `currentTime` avec la pile
 * d'appels qui l'a faite, les evenements du <video> et la console du lecteur.
 *
 * Pourquoi (27/11/2026) : sur voiranime-vidmoly, 1 saut -2 min sur 3 ne
 * montrait jamais d'image ; le lecteur annulait seg-11, 9, 7 puis 2 — la tete
 * reculait toute seule — et finissait par basculer sur un autre serveur.
 *
 *   node tools/browser-check/saut-trace.mjs <url> [passages]
 *
 * Une visite par passage (limiteur par IP de /api/v2/source) ; s'arrete au
 * premier passage qui reproduit (saut sans image en 20 s).
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, passages = "3"] = process.argv.slice(2);
if (!url) {
  console.error("usage : node tools/browser-check/saut-trace.mjs <url> [passages]");
  process.exit(1);
}
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

const TEMOIN = `(() => {
  const T = (window.__st = { ecritures: [], evts: [], t0: performance.now() });
  const now = () => Math.round(performance.now() - T.t0);
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get() { return d.get.call(this); },
    set(v) {
      if (this.closest && this.closest("[data-media-player]")) {
        const pile = (new Error().stack || "").split("\\n").slice(2, 9)
          .map((l) => l.trim().replace(/https?:\\/\\/[^/]+\\/_next\\/static\\/chunks\\//, "")).join(" | ");
        T.ecritures.push({ t: now(), de: Math.round(d.get.call(this) * 10) / 10, vers: Math.round(v * 10) / 10, pile });
      }
      d.set.call(this, v);
    },
  });
  /* Les erreurs d'hls.js, telles que Vidstack les relaie (\`hls-error\` sur le
     lecteur) : type, detail, fatale, et le message interne. */
  document.addEventListener("hls-error", (e) => {
    const d = e.detail || {};
    T.evts.push({ t: now(), e: "HLS " + (d.fatal ? "FATALE " : "") + d.type + "/" + d.details,
      ct: d.frag ? d.frag.sn + "@" + Math.round(d.frag.start) : "-", rs: d.response ? d.response.code : "",
      src: String((d.error && d.error.message) || d.reason || d.err?.message || "").slice(0, 160) });
  }, true);
  const vus = new WeakSet();
  setInterval(() => {
    const v = document.querySelector("[data-media-player] video");
    if (!v || vus.has(v)) return;
    vus.add(v);
    for (const e of ["seeking", "seeked", "waiting", "playing", "emptied", "loadstart", "error", "abort", "stalled"])
      v.addEventListener(e, () => T.evts.push({ t: now(), e, ct: Math.round(v.currentTime * 10) / 10, rs: v.readyState, src: (v.currentSrc || "").slice(0, 40) }));
  }, 50);
})()`;

for (let p = 1; p <= Number(passages); p++) {
  const port = 9370 + p;
  const profil = mkdtempSync(join(tmpdir(), "aniscroll-saut-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profil}`,
    "--no-first-run", "--no-default-browser-check", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
    "--window-size=1600,900",
    "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"],
    { stdio: "ignore" });
  for (let i = 0; ; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); break; }
    catch { if (i > 60) throw new Error("Chrome ne repond pas"); await dors(300); }
  }
  const onglet = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  const ws = new WebSocket(onglet.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const att = new Map();
  const consoles = [];
  const t0 = Date.now();
  ws.onmessage = (m) => {
    const x = JSON.parse(m.data);
    if (x.id && att.has(x.id)) { att.get(x.id)(x); att.delete(x.id); return; }
    if (x.method === "Runtime.consoleAPICalled") {
      const txt = x.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 220);
      if (/Universal|doute|resume|seek|saut|hls|erreur|error|bascul|server|diag/i.test(txt)) consoles.push(`${Date.now() - t0} ${x.params.type} ${txt}`);
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++n; att.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalue = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send("Runtime.enable");
  await send("Page.enable");
  /* SEED_LS='{"cle":"valeur"}' : localStorage pose avant d'ouvrir le lien
     (meme convention que player-timeline.mjs). */
  if (process.env.SEED_LS) {
    await send("Page.navigate", { url: new URL(url).origin + "/robots.txt" });
    await dors(1500);
    for (const [k, v] of Object.entries(JSON.parse(process.env.SEED_LS)))
      await evalue(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(String(v))})`);
  }
  await send("Page.addScriptToEvaluateOnNewDocument", { source: TEMOIN });
  await send("Page.navigate", { url });
  for (let i = 0; i < 60; i++) {
    await dors(500);
    if (await evalue(`(() => { const v = document.querySelector("[data-media-player] video"); return !!v && v.readyState >= 2; })()`)) break;
  }
  await evalue(`document.querySelector("[data-media-player] video")?.play().catch(() => {})`);
  await dors(30000);
  const saut = async (delta) => evalue(`(async () => {
    const v = document.querySelector("[data-media-player] video");
    if (!v) return null;
    const cible = Math.max(0, v.currentTime + ${delta});
    const t = performance.now() - window.__st.t0;
    const fin = new Promise((res) => {
      v.addEventListener("seeked", () => v.requestVideoFrameCallback(() => res(Math.round(performance.now() - window.__st.t0 - t))), { once: true });
      setTimeout(() => res(null), 20000);
    });
    v.currentTime = cible;
    return { cible: Math.round(cible), ms: await fin, a: Math.round(t) };
  })()`);
  const s1 = await saut(300);
  await dors(3000);
  const s2 = await saut(-120);
  await dors(2000);
  const st = await evalue(`window.__st`);
  const rate = s2 && s2.ms == null;
  console.log(`\n=== passage ${p} : +5 min ${s1?.ms ?? "RIEN"} ms · -2 min ${s2?.ms ?? "RIEN"} ms${rate ? "  <<< REPRODUIT" : ""}`);
  if (rate || process.env.TOUT) {
    const depuis = (s1?.a ?? 0) - 500;
    console.log("ecritures de currentTime (depuis le 1er saut) :");
    for (const w of st.ecritures.filter((w) => w.t >= depuis)) console.log(`  ${w.t} ms  ${w.de} → ${w.vers}   ${w.pile}`);
    console.log("evenements :");
    for (const e of st.evts.filter((e) => e.t >= depuis)) console.log(`  ${e.t} ms  ${e.e}  ct=${e.ct} rs=${e.rs} ${e.src}`);
    console.log("console :");
    for (const c of consoles.slice(-40)) console.log("  " + c);
  }
  ws.close();
  chrome.kill();
  if (rate && !process.env.COMPTER) process.exit(0);
  await dors(20000);
}
process.exit(0);
