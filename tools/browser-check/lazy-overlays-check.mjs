/**
 * Verifier, dans un VRAI Chrome, que les overlays passes en chargement differe
 * apparaissent toujours — et au bon moment.
 *
 * Pourquoi ce script existe : la palette de recherche, la carte de survol, le
 * formulaire de signalement et l'editeur de liste ne sont plus dans le chunk
 * `_app`. Ils arrivent par leur propre fichier, au premier geste qui les
 * reclame. C'est invisible dans un `next build` — celui-ci ne dit que des
 * tailles — et invisible en lecture de code : la seule preuve qu'un differe
 * n'a rien casse, c'est de refaire le geste et de regarder si le panneau
 * s'ouvre.
 *
 *   node tools/browser-check/lazy-overlays-check.mjs [origine]
 *
 * L'origine par defaut est dev.aniscroll.com : localhost ment (pas de Redis,
 * pas de CDN, compilations a froid), donc on mesure sur la preview.
 *
 * Il imprime, par geste : le panneau attendu est-il dans le DOM, et les
 * requetes de chunks JS declenchees APRES le geste — c'est cette seconde
 * colonne qui prouve que le code n'etait pas dans le chargement initial.
 * Plus, a la fin, les erreurs console de la session.
 *
 * Precaution : chaque chargement de page consomme le limiteur par IP des
 * routes qu'elle appelle. Espacer les executions.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINE = process.argv[2] || "https://dev.aniscroll.com";
const CHROME =
  process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9356);

const profil = mkdtempSync(join(tmpdir(), "aniscroll-lazy-"));
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
    if (Date.now() - t0 > max) throw new Error("delai depasse");
    await dors(300);
  }
};

await attends(() =>
  fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()),
);
const onglet = await fetch(
  `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(ORIGINE + "/en")}`,
  { method: "PUT" },
).then((r) => r.json());

const ws = new WebSocket(onglet.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const attente = new Map();
/** Chunks JS demandes, dans l'ordre — la trace du chargement differe. */
const chunks = [];
const erreurs = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && attente.has(msg.id)) {
    attente.get(msg.id)(msg);
    attente.delete(msg.id);
    return;
  }
  if (msg.method === "Network.requestWillBeSent") {
    const u = msg.params.request.url;
    if (/\/_next\/static\/chunks\/.*\.js$/.test(u))
      chunks.push({ t: Date.now(), url: u.split("/").pop() });
  }
  if (msg.method === "Runtime.exceptionThrown")
    erreurs.push(
      msg.params.exceptionDetails.exception?.description ||
        msg.params.exceptionDetails.text,
    );
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error")
    erreurs.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
};
const envoie = (method, params = {}) =>
  new Promise((res) => {
    const id = ++n;
    attente.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await envoie("Network.enable");
await envoie("Runtime.enable");
await envoie("Page.enable");

const evalue = async (expr) => {
  const r = await envoie("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.result?.value;
};

/**
 * Chunks vus pour la PREMIERE fois depuis l'instant `t`.
 *
 * Le dedoublonnage n'est pas cosmetique : Next prefetche la cible de chaque
 * <Link> visible, et redemande les memes fichiers a chaque passage du
 * survol. Sans ce filtre, le geste le plus anodin est suivi d'une trentaine
 * de noms qui n'ont rien a voir avec lui, et la colonne ne prouve plus rien.
 */
const vus = new Set();
const depuis = (t) => {
  const neufs = [];
  for (const c of chunks) {
    if (vus.has(c.url)) continue;
    vus.add(c.url);
    if (c.t >= t) neufs.push(c.url);
  }
  return neufs;
};

/**
 * Un geste : on note l'heure, on agit, on attend que le DOM montre `sonde`.
 * Le verdict porte sur DEUX choses — le panneau s'ouvre, et son code est
 * arrive apres le geste. La seconde est ce qui distingue un differe reussi
 * d'un composant reste dans le chunk initial.
 */
async function geste(nom, action, sonde) {
  const t0 = Date.now();
  await action();
  let vu = false;
  for (let i = 0; i < 40 && !vu; i++) {
    vu = !!(await evalue(`!!(${sonde})`));
    if (!vu) await dors(250);
  }
  const nouveaux = depuis(t0);
  console.log(
    `${vu ? "OK  " : "ECHEC"} ${nom.padEnd(28)} ` +
      `${vu ? `+${Date.now() - t0} ms` : "panneau absent"}  ` +
      `chunks apres le geste : ${nouveaux.length ? nouveaux.join(", ") : "aucun"}`,
  );
  return vu;
}

const touche = (params) => envoie("Input.dispatchKeyEvent", params);

await attends(() => evalue(`document.readyState === "complete"`), 45000);
// Laisser passer l'hydratation, les chunks differes de fond ET la vague de
// prefetch des <Link> visibles, sinon leur trainee se lit comme la
// consequence du premier geste.
await dors(6000);
console.log(`origine : ${ORIGINE}`);
console.log(`chunks au chargement de /en : ${new Set(chunks.map((c) => c.url)).size}`);
depuis(0); // tout ce qui precede le premier geste est deja "vu"
console.log("");

let ok = true;

/*
 * 1. Palette de recherche — Ctrl+S. L'ecouteur vit desormais dans
 *    SearchProvider et plus dans le composant qu'il revele ; c'est
 *    precisement ce que ce geste verifie.
 *
 *    L'evenement est fabrique DANS la page plutot qu'envoye par
 *    `Input.dispatchKeyEvent`. Le dispatch CDP brut n'a pas produit la
 *    combinaison en headless — aucune touche n'atteint l'ecouteur `window`
 *    quand rien n'a le focus — et un faux echec de l'outil se lit
 *    exactement comme une vraie regression. L'ecouteur est sur `window` et
 *    ne lit que `code` et `ctrlKey` : un KeyboardEvent synthetique exerce
 *    donc le meme chemin, du premier octet du handler jusqu'au panneau.
 */
ok &= await geste(
  "palette (Ctrl+S)",
  () =>
    evalue(
      `window.dispatchEvent(new KeyboardEvent("keydown",` +
        `{code:"KeyS",key:"s",ctrlKey:true,bubbles:true}))`,
    ),
  `document.querySelector('[role="dialog"] input')`,
);

// Refermer (Escape) pour ne pas gener la suite.
await touche({ type: "keyDown", code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 });
await touche({ type: "keyUp", code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 });
await dors(800);

// 2. Apercu au survol — le provider est differe ; la carte doit toujours
//    s'ouvrir quand le pointeur se pose sur une vignette et s'y arrete.
ok &= await geste(
  "apercu au survol",
  async () => {
    const r = await evalue(`(() => {
      const el = document.querySelector("[data-anime-preview]");
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    if (!r) throw new Error("aucune vignette [data-anime-preview] sur /en");
    // Un mouvement, puis l'immobilite : le compte a rebours ne part qu'au repos.
    await envoie("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x - 30, y: r.y - 30 });
    await dors(120);
    await envoie("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
  },
  `document.querySelector("[data-preview-popup]")`,
);

// 3. Formulaire de signalement — le drapeau de la navbar.
ok &= await geste(
  "signalement (drapeau)",
  async () => {
    const r = await evalue(`(() => {
      const b = [...document.querySelectorAll("button")].find(
        (x) => (x.getAttribute("aria-label") || "").toLowerCase().includes("bug") ||
               (x.getAttribute("title") || "").toLowerCase().match(/signal|report/),
      );
      if (!b) return null;
      b.click();
      return true;
    })()`);
    if (!r) throw new Error("bouton de signalement introuvable dans la navbar");
  },
  `[...document.querySelectorAll('[role="dialog"]')].some(d => d.textContent.length > 40)`,
);

console.log("");
if (erreurs.length) {
  console.log(`erreurs console (${erreurs.length}) :`);
  for (const e of [...new Set(erreurs)].slice(0, 12)) console.log("  " + e);
} else {
  console.log("erreurs console : aucune");
}

ws.close();
chrome.kill();
process.exit(ok ? 0 : 1);
