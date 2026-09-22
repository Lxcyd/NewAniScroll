/**
 * Mesurer, dans un VRAI Chrome francais, ce que coute une page APRES sa reponse
 * serveur — et si React jette le HTML du serveur pour tout re-rendre.
 *
 * Pourquoi ce script existe. Le 02/09/2026, rapport « le chargement est tres
 * long entre les pages, pareil ou pire au reload ». Le curl disait l'inverse :
 * une page deja au cache d'edge repond en 70 ms. Le cout etait donc du cote
 * client, et la console montrait trois erreurs React minifiees — #425, #418,
 * #423. Ce sont des erreurs d'HYDRATATION : quand le texte rendu par le
 * navigateur ne correspond pas a celui que le serveur a envoye, React jette
 * l'arbre entier et refait la page. Une page rendue deux fois est exactement ce
 * que l'on ressent comme « tres long » alors que le reseau va bien.
 *
 *   node tools/browser-check/hydration-check.mjs [origine] [chemin...]
 *
 * L'origine par defaut est dev.aniscroll.com : localhost ment (pas de Redis,
 * pas de CDN, compilations a froid), donc on mesure sur la preview.
 *
 * EN FRANCAIS, ET C'EST TOUT L'INTERET. Le serveur rend l'anglais quoi qu'il
 * arrive (i18next est un singleton, cf. lib/i18n/I18nProvider) ; c'est la
 * bascule vers le francais, cote client, qui peut arriver au milieu de
 * l'hydratation. Un Chrome en `en-US` ne verrait donc jamais le defaut qu'on
 * cherche. Le profil est neuf a chaque run — pas de service worker installe,
 * pas de langue memorisee — donc `navigator.language` decide, et il vaut
 * `fr-FR` par les deux drapeaux ci-dessous.
 *
 * Ce qu'il imprime, par page :
 *   - erreurs React d'hydratation (#418/#423/#425), nommees ;
 *   - autres erreurs console et requetes en echec (le `400` de banner-tone, une
 *     navigation que le service worker fait echouer…) ;
 *   - `domContentLoaded` / `load`, et surtout le TEMPS DE TACHES LONGUES apres
 *     la reponse : c'est la mesure directe du travail client, celle qui double
 *     quand la page est rendue deux fois.
 *
 * Precaution : chaque chargement consomme le limiteur par IP des routes que la
 * page appelle. Espacer les executions.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINE = process.argv[2] || "https://dev.aniscroll.com";
const CHEMINS = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["/fr", "/fr/anime/21", "/fr/profile/Lucyd-952364"];

const CHROME =
  process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9357);

const profil = mkdtempSync(join(tmpdir(), "aniscroll-hydra-"));
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
    // Les deux, et pas un seul : `--lang` fixe l'interface, `--accept-lang` fixe
    // `navigator.language` et l'en-tete Accept-Language. C'est le second que lit
    // la detection de langue du site.
    "--lang=fr-FR",
    "--accept-lang=fr-FR,fr",
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
  `http://127.0.0.1:${PORT}/json/new?about:blank`,
  { method: "PUT" },
).then((r) => r.json());

const ws = new WebSocket(onglet.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const attente = new Map();

/** Ce qui est collecte pour la page en cours ; remis a zero avant chaque page. */
let sac = { react: [], erreurs: [], echecs: [], http: [] };

/**
 * Les trois codes qui nous interessent, et ce qu'ils disent.
 *
 * React minifie ses messages en production : seul le numero reste. Les traduire
 * ici evite d'avoir a ouvrir le decodeur a chaque lecture du rapport — et
 * surtout, les trois vont ensemble : #425 constate la difference, #418 dit que
 * l'hydratation a echoue, #423 dit ce que ca coute (bascule en rendu client de
 * la racine entiere).
 */
const CODES = {
  418: "#418 hydratation echouee — le HTML du serveur ne correspond pas",
  423: "#423 erreur pendant l'hydratation — TOUTE la racine repasse en rendu client",
  425: "#425 texte different entre le serveur et le navigateur",
};

ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && attente.has(msg.id)) {
    attente.get(msg.id)(msg);
    attente.delete(msg.id);
    return;
  }
  const range = (t) => {
    const code = /Minified React error #(\d+)/.exec(t)?.[1];
    if (code) sac.react.push(CODES[code] || `#${code}`);
    else sac.erreurs.push(t.split("\n")[0].slice(0, 200));
  };
  if (msg.method === "Runtime.exceptionThrown")
    range(
      msg.params.exceptionDetails.exception?.description ||
        msg.params.exceptionDetails.text ||
        "",
    );
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error")
    range(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  if (msg.method === "Network.loadingFailed")
    sac.echecs.push(`${msg.params.errorText} (${msg.params.type})`);
  if (msg.method === "Network.responseReceived") {
    const { status, url } = msg.params.response;
    if (status >= 400) sac.http.push(`${status} ${url.slice(0, 120)}`);
  }
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

/*
 * LE COMPTEUR DE TACHES LONGUES, POSE AVANT QUE LA PAGE N'EXISTE.
 *
 * `longtask` ne se mesure pas apres coup : l'observateur doit tourner pendant
 * que le travail a lieu. `addScriptToEvaluateOnNewDocument` l'installe au tout
 * debut de chaque document, avant le moindre script de l'application — donc
 * l'hydratation, et le re-rendu qui la suit quand elle echoue, tombent dedans.
 *
 * C'est la mesure qui compte ici : une page rendue deux fois double son temps
 * de taches longues sans rien changer au reseau, et c'est precisement le cas ou
 * « le serveur repond en 70 ms » et « la page met des plombes » sont vrais tous
 * les deux.
 */
await envoie("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__long = { total: 0, n: 0 };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          window.__long.total += e.duration;
          window.__long.n += 1;
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {}
  `,
});

const evalue = async (expr) => {
  const r = await envoie("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.result?.value;
};

const ms = (v) => (v == null ? "?" : `${Math.round(v)} ms`);

console.log(`origine : ${ORIGINE}   (Chrome en fr-FR, profil neuf)\n`);

let verdict = 0;
for (const chemin of CHEMINS) {
  sac = { react: [], erreurs: [], echecs: [], http: [] };
  const t0 = Date.now();
  await envoie("Page.navigate", { url: ORIGINE + chemin });
  try {
    await attends(() => evalue(`document.readyState === "complete"`), 45000);
  } catch {
    console.log(`${chemin} — la page n'a jamais fini de charger (45 s)`);
  }
  // Laisser l'hydratation, la bascule de langue et le re-rendu eventuel se
  // produire : ils arrivent APRES `load`, ce qui est tout le sujet.
  await dors(5000);

  const t = await evalue(`(() => {
    const nav = performance.getEntriesByType("navigation")[0] || {};
    return {
      ttfb: nav.responseStart,
      dcl: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      lourd: window.__long ? window.__long.total : null,
      taches: window.__long ? window.__long.n : null,
      langue: document.documentElement.lang,
    };
  })()`);

  const dedup = (a) => [...new Set(a)];
  console.log(`── ${chemin}`);
  console.log(
    `   ttfb ${ms(t?.ttfb)} · DOM pret ${ms(t?.dcl)} · load ${ms(t?.load)} · ` +
      `taches longues ${ms(t?.lourd)} en ${t?.taches ?? "?"} · ` +
      `mur ${Date.now() - t0} ms · lang="${t?.langue}"`,
  );
  if (sac.react.length) {
    verdict = 1;
    console.log(`   HYDRATATION CASSEE :`);
    for (const e of dedup(sac.react)) console.log(`     - ${e}`);
  } else {
    console.log(`   hydratation : propre`);
  }
  for (const e of dedup(sac.http)) console.log(`   http  ${e}`);
  for (const e of dedup(sac.echecs)) console.log(`   echec ${e}`);
  for (const e of dedup(sac.erreurs)) console.log(`   err   ${e}`);
  console.log("");
}

ws.close();
chrome.kill();
process.exit(verdict);
