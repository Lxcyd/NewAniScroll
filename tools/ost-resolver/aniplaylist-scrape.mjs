/**
 * Lire la liste des musiques d'un anime sur aniplaylist.com.
 *
 * Pourquoi un navigateur : la page servie est une coquille vide de 191 Ko.
 * Tout le contenu est rendu cote client depuis Algolia, et la cle de recherche
 * du site est restreinte par referer — la requeter directement demanderait de
 * forger cet en-tete, donc de contourner une protection posee volontairement.
 * Charger la page dans un vrai Chrome donne exactement la meme donnee sans
 * rien contourner : c'est ce que fait n'importe quel visiteur.
 *
 * Leur robots.txt ("User-agent: * / Disallow:") autorise le crawl integral.
 * Cela ne dispense pas d'etre econome : AniPlaylist est un projet de fans, pas
 * une API. Le script est sequentiel et temporise volontairement.
 *
 *   node tools/ost-resolver/aniplaylist-scrape.mjs <slug> [--dump]
 *   node tools/ost-resolver/aniplaylist-scrape.mjs chainsaw-man
 *
 * --dump imprime la structure DOM rencontree, pour reajuster les selecteurs
 * quand le site change de gabarit.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [slug, ...flags] = process.argv.slice(2);
if (!slug) {
  console.error("usage : node aniplaylist-scrape.mjs <slug> [--dump]");
  process.exit(1);
}
const DUMP = flags.includes("--dump");

const CHROME =
  process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9366);

const profil = mkdtempSync(join(tmpdir(), "aniplaylist-cdp-"));
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
    "--window-size=1600,2400",
  ],
  { stdio: "ignore" },
);

const dors = (ms) => new Promise((r) => setTimeout(r, ms));

async function cible() {
  // Chrome met un instant a ouvrir son port de debug.
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = (await r.json()).filter((p) => p.type === "page");
      if (pages[0]?.webSocketDebuggerUrl) return pages[0].webSocketDebuggerUrl;
    } catch {}
    await dors(250);
  }
  throw new Error("Chrome n'a pas ouvert son port CDP");
}

function client(ws) {
  let n = 0;
  const attente = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && attente.has(m.id)) {
      attente.get(m.id)(m.result);
      attente.delete(m.id);
    }
  });
  return (method, params = {}) =>
    new Promise((res) => {
      const id = ++n;
      attente.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
}

// Chaque entree est une carte `div.shadow-card`. Le titre vient de l'attribut
// `title` de la vignette, qui porte une chaine structuree :
//   "CD cover for <TITRE> from anime <ANIME> on <PLATEFORMES>"
// C'est plus sur que de decouper le bloc texte, ou le type apparait en double
// ("EndingED") et ou les compteurs de la carte viennent se coller au reste.
const EXTRACTION = String.raw`(() => {
  const nettoie = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const entrees = [];

  for (const carte of document.querySelectorAll('div.shadow-card')) {
    const img = carte.querySelector('img[title]');
    const meta = /^CD cover for (.+?) from anime (.+?) on (.+)$/.exec(
      nettoie(img && img.getAttribute('title')),
    );

    // Le type et l'artiste vivent dans le petit bloc ".../ by ..." de la carte.
    // Ce bloc porte aussi le titre : il sert de repli quand la vignette n'est
    // pas encore chargee (les cartes hors ecran arrivent en differe).
    let type = null, artiste = null, titreTexte = null;
    for (const el of carte.querySelectorAll('div, span, p')) {
      if (el.children.length > 3) continue;
      const t = nettoie(el.textContent);
      // L'abreviation dupliquee ("EndingED") est un jeu ferme : la matcher
      // comme [A-Z]* devorait la premiere lettre du titre suivant
      // ("InsertHawatari" -> type Insert, titre "awatari").
      const m = /^(Opening|Ending|OST|Insert|Theme Song)(?:OP|ED|OST|IN|TS)?\s*(\([^)]*\))?\s*(.*?) by (.+)$/.exec(t);
      if (m) { type = m[1]; titreTexte = m[3]; artiste = m[4]; break; }
    }

    entrees.push({
      titre: (meta ? meta[1] : null) || titreTexte || null,
      anime: meta ? meta[2] : nettoie(img && img.getAttribute('alt')) || null,
      plateformes: meta ? meta[3].split(',').map((x) => x.trim()) : [],
      type,
      artiste,
    });
  }

  return JSON.stringify({
    titrePage: document.title,
    nb: entrees.length,
    entrees,
    apercu: nettoie(document.body.innerText).slice(0, 800),
  });
})()`;

try {
  const ws = new WebSocket(await cible());
  await new Promise((r) => ws.addEventListener("open", r));
  const envoie = client(ws);

  await envoie("Page.enable");
  await envoie("Runtime.enable");
  await envoie("Page.navigate", { url: `https://aniplaylist.com/${slug}` });

  // La liste arrive par XHR apres l'hydratation : attendre le load ne suffit
  // pas. On sonde jusqu'a ce que le nombre d'entrees se stabilise.
  let precedent = -1;
  let donnees = null;
  for (let i = 0; i < 30; i++) {
    await dors(1000);

    // Les vignettes hors ecran sont en chargement differe, et c'est leur
    // attribut `title` qui porte le titre du morceau. Sans defilement, les
    // dernieres cartes ressortent sans titre.
    await envoie("Runtime.evaluate", {
      expression: "window.scrollTo(0, document.body.scrollHeight)",
    });
    await dors(600);

    const r = await envoie("Runtime.evaluate", {
      expression: EXTRACTION,
      returnByValue: true,
    });
    donnees = JSON.parse(r.result.value);
    const complets = donnees.entrees.filter((e) => e.titre).length;
    if (donnees.nb > 0 && donnees.nb === precedent && complets === donnees.nb) break;
    precedent = donnees.nb;
  }

  if (DUMP || donnees.nb === 0) {
    console.log("titre page :", donnees.titrePage);
    console.log("apercu     :", donnees.apercu);
    console.log("---");
  }

  console.log(`${donnees.nb} entree(s) pour « ${slug} »\n`);
  const parType = {};
  for (const e of donnees.entrees) {
    parType[e.type || "?"] = (parType[e.type || "?"] || 0) + 1;
    console.log(
      `  [${(e.type || "?").padEnd(10)}] ${e.titre || "(titre illisible)"}` +
        `${e.artiste ? ` — ${e.artiste}` : ""}`,
    );
    if (e.anime) console.log(`               ${e.anime}`);
  }

  const parAnime = {};
  for (const e of donnees.entrees) {
    parAnime[e.anime || "?"] = (parAnime[e.anime || "?"] || 0) + 1;
  }
  console.log("\nPar type  :", JSON.stringify(parType));
  console.log("Par anime :", JSON.stringify(parAnime, null, 1));

  const sortie = flags.find((f) => f.startsWith("--json="));
  if (sortie) {
    const chemin = sortie.slice("--json=".length);
    writeFileSync(chemin, JSON.stringify(donnees.entrees, null, 1), "utf8");
    console.log(`\nEcrit dans ${chemin}`);
  }

  ws.close();
} finally {
  chrome.kill();
}
