/**
 * Fluidite des changements d'onglet dans les menus du studio de profil.
 *
 *   node tools/browser-check/menu-switch.mjs <sortie.json> [origine]
 *   node tools/browser-check/menu-switch.mjs --compare avant.json apres.json
 *
 * Pourquoi (21/11/2026). perf-measure.mjs ne mesure que des chargements a
 * froid : rien ne disait ce que coute un clic sur Image / Banniere / Mur.
 *
 * Le studio est ouvert sur /fr/my-list, avec une liste locale FICTIVE de 700
 * titres (jaquette d'un pixel, pour monter les vraies images). AniList et /api/v2 sont BLOQUES : aucune lecture
 * Turso, aucun appel a une API externe, et le meme contenu a chaque passage.
 * Les chiffres en local servent a comparer avant / apres, pas dans l'absolu.
 *
 * Par clic : temps jusqu'a la peinture suivante, plus longue tache, temps
 * bloquant (au-dela de 50 ms), et plus grand trou entre deux images.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLES = ["peinture", "tache", "bloquant", "trou"];

if (process.argv[2] === "--compare") {
  const a = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const b = JSON.parse(readFileSync(process.argv[4], "utf8"));
  for (const profil of Object.keys(b)) {
    console.log(`\n=== ${profil} (ms, avant>apres) ===`);
    console.log(["onglet".padEnd(26), ...CLES.map((k) => k.padStart(13))].join(""));
    for (const nom of Object.keys(b[profil])) {
      const cell = (k) => `${Math.round(a[profil]?.[nom]?.[k] ?? NaN)}>${Math.round(b[profil][nom][k])}`.padStart(13);
      console.log([nom.padEnd(26), ...CLES.map(cell)].join(""));
    }
  }
  process.exit(0);
}

const SORTIE = process.argv[2];
if (!SORTIE) {
  console.error("usage : menu-switch.mjs <sortie.json> [origine]");
  process.exit(2);
}
const ORIGINE = process.argv[3] || "http://localhost:3123";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9374);
const PROFILS = { bureau: 1, "cpu x4": 4 };
const PARCOURS = ["Bannière", "Mur d'animés", "Image", "Bannière", "Image", "Mur d'animés", "Image"];

const profilDir = mkdtempSync(join(tmpdir(), "aniscroll-menus-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profilDir}`,
  "--no-first-run", "--no-default-browser-check", "--mute-audio", "--window-size=1600,900", "--lang=fr-FR",
], { stdio: "ignore" });
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const attends = async (fn, quoi, max = 90000) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > max) throw new Error(`delai depasse : ${quoi}`);
    await dors(250);
  }
};

let ws;
try {
  await attends(() => fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()), "Chrome");
  const onglet = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  ws = new WebSocket(onglet.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const attente = new Map();
  ws.onmessage = (m) => {
    const x = JSON.parse(m.data);
    if (x.id && attente.has(x.id)) { attente.get(x.id)(x); attente.delete(x.id); }
  };
  const envoie = (method, params = {}) => new Promise((res) => {
    const id = ++n;
    attente.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalue = async (expression) => {
    const r = await envoie("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "erreur page");
    return r.result?.result?.value;
  };
  const clique = async (x, y) => {
    await envoie("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await envoie("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await envoie("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };

  await envoie("Page.enable");
  await envoie("Runtime.enable");
  await envoie("Network.enable");
  await envoie("Network.setBlockedURLs", { urls: ["*anilist.co*", "*/api/v2/*", "*/api/auth/*"] });
  const ua = (await evalue("navigator.userAgent")).replace("HeadlessChrome", "Chrome");
  await envoie("Network.setUserAgentOverride", { userAgent: ua, acceptLanguage: "fr-FR,fr" });
  await envoie("Page.addScriptToEvaluateOnNewDocument", { source: `
    try {
      if (!localStorage.getItem("aniscroll:localList")) {
        const m = {}, now = Date.now();
        for (let i = 1; i <= 700; i++) m[i] = { mediaId: i, status: i % 5 ? "COMPLETED" : "CURRENT", score: i % 10, progress: 12, total: 12,
          title: { english: "Titre de test " + i, romaji: "Test " + i }, coverImage: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", startedAt: null, completedAt: null, notes: null, updatedAt: now - i * 1000 };
        localStorage.setItem("aniscroll:localList", JSON.stringify(m));
      }
      localStorage.setItem("as-studio-scope", "image");
      // Le tour guide verrouille les onglets : marque comme deja vu (cle locale et cle du site).
      localStorage.setItem("aniscroll:studioTour:7:local-1511", "1");
      localStorage.setItem("aniscroll:studioTour:7", "1");
    } catch {}
    window.__m = { taches: [] };
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__m.taches.push([e.startTime, e.duration]))).observe({ type: "longtask", buffered: true }); } catch {}
  ` });

  await envoie("Page.navigate", { url: `${ORIGINE}/fr/my-list` });
  const coords = (js) => attends(() => evalue(`(() => { const el = ${js}; if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`), js);
  const bouton = await coords(`[...document.querySelectorAll("button[aria-label]")].find((b) => /Changer la banni|change.*banner/i.test(b.getAttribute("aria-label")))`);
  await dors(2500);
  await clique(bouton.x, bouton.y);
  await attends(() => evalue(`[...document.querySelectorAll('[role=tab]')].some((b) => b.textContent.trim() === "Bannière")`), "onglets du studio");
  await dors(3000);

  const resultat = {};
  for (const [profil, cpu] of Object.entries(PROFILS)) {
    await envoie("Emulation.setCPUThrottlingRate", { rate: cpu });
    await dors(800);
    const parOnglet = {};
    for (let i = 0; i < PARCOURS.length; i++) {
      const nom = PARCOURS[i];
      const p = await coords(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === ${JSON.stringify(nom)})`);
      await evalue(`(() => {
        const s = window.__s = { t0: Infinity, peinture: null, trou: 0, fin: false };
        addEventListener("pointerdown", () => {
          s.t0 = performance.now();
          let prev = s.t0;
          const f = () => {
            const now = performance.now();
            // Le 1er rAF precede la peinture : celle-ci est acquise au 2e.
            if (s.vu && s.peinture == null) s.peinture = now - s.t0;
            s.vu = true;
            s.trou = Math.max(s.trou, now - prev);
            prev = now;
            if (!s.fin) requestAnimationFrame(f);
          };
          requestAnimationFrame(f);
        }, { once: true, capture: true });
      })()`);
      await clique(p.x, p.y);
      await dors(cpu > 1 ? 2200 : 1200);
      const m = await evalue(`(() => { const s = window.__s; s.fin = true;
        const t = window.__m.taches.filter(([d, l]) => d + l >= s.t0);
        const actif = document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim();
        return { actif, lignes: document.querySelectorAll('[data-studio-row], button[style*="content-visibility"]').length, peinture: s.peinture ?? 0, tache: Math.max(0, ...t.map((x) => x[1])), bloquant: t.reduce((a, x) => a + Math.max(0, x[1] - 50), 0), trou: s.trou };
      })()`);
      if (m.actif !== nom) throw new Error(`clic sans effet : « ${nom} » demande, « ${m.actif} » actif`);
      if (i === 0) console.log(`${profil} : ${m.lignes} lignes montees sur ${nom}`);
      (parOnglet[`${nom}`] ||= []).push(m);
      await dors(250);
    }
    resultat[profil] = {};
    for (const [nom, l] of Object.entries(parOnglet)) {
      const med = (k) => { const v = l.map((x) => x[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
      resultat[profil][nom] = Object.fromEntries(CLES.map((k) => [k, Math.round(med(k))]));
    }
    console.log(`\n${profil}`);
    console.table(resultat[profil]);
  }
  await envoie("Emulation.setCPUThrottlingRate", { rate: 1 });
  writeFileSync(SORTIE, JSON.stringify(resultat, null, 2));
  console.log(`ecrit : ${SORTIE}`);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
}
process.exit(0);
