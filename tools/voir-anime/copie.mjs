#!/usr/bin/env node
/**
 * Copie de ce que voir-anime sait, pour le SEUL lecteur valide qu'il porte :
 * « LECTEUR myTV » (voembed.net, famille vidmoly — chip `vidmoly-va`, decision
 * de Luc du 31/10/2026). Meme chaine que tools/anime-sama/copie.mjs.
 *
 * Pour chaque page /anime/<slug>/ (une page = une langue, `-vf` pour la VF) :
 *   - ce qu'elle affiche d'AniList (titre natif, romaji, type, date de debut),
 *     d'ou son ANCRE : l'entree AniList de meme titre ET de meme date de debut
 *     (voir-anime n'affiche pas d'id) ;
 *   - ses episodes, numerotes COMME LE SITE LES LIT (buildVoiranimeEpRegex de
 *     pages/api/v2/source/index.js : les fichiers groupes « 29x30x31 » y sont
 *     invisibles, ils le sont donc ici aussi) ;
 *   - pour chaque episode, le lien myTV de sa page, CONTROLE (embed 200 avec un
 *     flux = vivant ; 404 confirme par un temoin = mort).
 *
 * Tout en direct (voir-anime et voembed repondent aux IP ordinaires ; le Worker
 * du site n'est pas sollicite). Chaque nuit : seules les pages dont le sitemap
 * annonce un changement sont relues, seules les pages d'episode nouvelles (ou
 * dont le lien est mort) sont relues, les liens a tour de role.
 *
 *   node tools/voir-anime/copie.mjs --slugs=sousou-no-frieren,…   pages donnees
 *   node tools/voir-anime/copie.mjs --toutes [--tranche=i/n] [--ecrire] [--md=F]
 *   options : --mesure=N, --sans-vie, --budget-vie=N, --paralleles=N,
 *             --vie-paralleles=N, --attente-max=MIN, --json=F
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";

const JOURS_VIE = 14;
const JOURS_ANCRE = 7; // une page sans ancre est recherchee a nouveau apres ce delai
const VA = "https://voir-anime.to";
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.length ? v.join("=") : "1"];
}));
let budgetVie = Number(args["budget-vie"] || 4000);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const compteur = { va: 0, vaErreurs: 0, vie: 0, anilist: 0 };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
// Les domaines du lecteur myTV (et ses anciens noms sur le fond de catalogue).
const MYTV = /^https?:\/\/(www\.)?(voembed\.net|ansembed\.net|vidmoly\.(to|biz|net))\//i;

/* ── voir-anime : un plafond de requetes en vol ─────────────────────────── */
const PARALLELES = Number(args.paralleles || 4);
let enVol = 0;
const attente = [];
async function va(chemin) {
  if (enVol < PARALLELES) enVol++; else await new Promise((r) => attente.push(r));
  try {
    for (let essai = 0; essai < 3; essai++) {
      compteur.va++;
      try {
        const r = await fetch(chemin.startsWith("http") ? chemin : `${VA}${chemin}`, {
          headers: { "User-Agent": UA, Referer: `${VA}/` }, signal: AbortSignal.timeout(20000),
        });
        if (r.status === 429 || r.status >= 500) { await dors(3000 * (essai + 1)); continue; }
        return { status: r.status, texte: r.ok ? await r.text() : "" };
      } catch { await dors(3000 * (essai + 1)); }
    }
    compteur.vaErreurs++;
    return { status: 0, texte: "" };
  } finally {
    const s = attente.shift(); if (s) s(); else enVol--;
  }
}

/** Les pages anime des sitemaps : slug -> lastmod. */
async function catalogue() {
  const { texte: index } = await va("/sitemap_index.xml");
  const cartes = [...index.matchAll(/<loc>([^<]*wp-manga-sitemap\d*\.xml)<\/loc>/g)].map((m) => m[1]);
  const pages = new Map();
  for (const c of cartes) {
    const { texte } = await va(c);
    for (const m of texte.matchAll(/<loc>https:\/\/voir-anime\.to\/anime\/([^/<]+)\/<\/loc>\s*<lastmod>([^<]+)</g)) {
      pages.set(decodeURIComponent(m[1]), m[2]);
    }
  }
  return pages;
}

const MOIS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
/** « Start date Sep 29, 2023 » -> "2023-09-29" (null si incomplet). */
function dateDebut(t) {
  const m = String(t || "").match(/([A-Z][a-z]{2})\w*\s+(\d{1,2}),\s*(\d{4})/);
  if (!m || !MOIS[m[1]]) return null;
  return `${m[3]}-${String(MOIS[m[1]]).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** La page d'un anime : ce qu'elle dit d'AniList, et ses episodes numerotes comme le site les lit. */
async function lirePage(slug) {
  const { status, texte } = await va(`/anime/${encodeURI(slug)}/`);
  if (status !== 200) return { erreur: `page ${status}` };
  const meta = {};
  for (const m of texte.matchAll(/<div class="post-content_item[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g)) {
    const t = m[1].replace(/<[^>]*>/g, " ").replace(/&#0?39;|&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const k = t.split(" ")[0];
    meta[k] = t.slice(k.length).trim();
  }
  const esc = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  // = buildVoiranimeEpRegex (pages/api/v2/source/index.js) : a garder identique.
  const re = new RegExp(`href=["']${VA.replace(/\./g, "\\.")}/anime/(${esc}(?:-[a-z0-9]{1,3})?/[^"']+?-(\\d+)(?:-(?:vf|vostfr))?/)["']`, "gi");
  const episodes = {};
  for (const m of texte.matchAll(re)) {
    const n = parseInt(m[2], 10);
    if (!(n in episodes)) episodes[n] = m[1];
  }
  // Film : une seule page enfant sans numero (`film-vf-one-piece-red/`), lue par le site comme l'episode 1.
  if (!Object.keys(episodes).length) {
    const f = texte.match(new RegExp(`href=["']${VA.replace(/\./g, "\\.")}/anime/(${esc}(?:-[a-z0-9]{1,3})?/(?:film|movie|ova|oav|special)[^"']*/)["']`, "i"));
    if (f) episodes[1] = f[1];
  }
  return {
    romaji: meta.Romaji || null, natif: meta.Native || null, anglais: meta.English || null,
    type: meta.Type || null, statut: meta.Status || null, debut: dateDebut(meta.Start), episodes,
    // Contrat : une page anime porte toujours ces blocs. Sans eux, le theme a change.
    lisible: "Romaji" in meta || "Native" in meta || /thisChapterSources|wp-manga-chapter/.test(texte),
  };
}

/** Le lien myTV d'une page d'episode (null : pas de myTV ; undefined : page illisible). */
async function lienMyTV(chemin) {
  const { status, texte } = await va(`/anime/${chemin}`);
  if (status === 404) return null;
  if (status !== 200) return undefined;
  const m = texte.match(/thisChapterSources\s*=\s*({[\s\S]*?});/);
  if (!m) return undefined;
  let sources;
  try { sources = JSON.parse(m[1]); } catch { return undefined; }
  for (const html of Object.values(sources)) {
    const src = String(html).match(/<iframe\s+src=["']([^"']+)["']/i)?.[1];
    if (src && MYTV.test(src)) return src;
  }
  return null;
}

/* ── Ancre AniList : meme titre ET meme date de debut ─────────────────────── */
const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const dateAni = (d) => (d?.year && d?.month && d?.day ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null);
async function rechercherLot(termes) {
  const vars = {}, defs = [], corps = [];
  termes.forEach((t, i) => {
    vars[`s${i}`] = t; defs.push(`$s${i}:String`);
    corps.push(`a${i}:Page(perPage:10){media(search:$s${i},type:ANIME){id startDate{year month day} title{romaji native english} synonyms}}`);
  });
  for (let essai = 0; essai < 4; essai++) {
    compteur.anilist++;
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query(${defs.join(",")}){${corps.join(" ")}}`, variables: vars }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    if (!r || r.status === 429 || r.status >= 500) { await dors(30000); continue; }
    const j = await r.json().catch(() => null);
    await dors(2200); // AniList : ~30 requetes / minute
    return termes.map((_, i) => j?.data?.[`a${i}`]?.media || []);
  }
  return null; // AniList injoignable : on ne conclut rien
}
/** pages: [{slug, romaji, natif, anglais, debut}] -> Map slug -> {id|null, note} */
async function ancrer(pages) {
  const out = new Map();
  const choisir = (p, candidats) => {
    const titres = new Set([p.romaji, p.natif, p.anglais].filter(Boolean).map(norm));
    /* Un jour d'ecart tolere : voir-anime date parfois a la veille (fuseau) —
       SNK The Final Season, 2020-12-06 chez eux, 2020-12-07 sur AniList. */
    const ok = candidats.filter((m) => dateAni(m.startDate) && Math.abs(Date.parse(dateAni(m.startDate)) - Date.parse(p.debut)) <= 864e5 &&
      [m.title?.romaji, m.title?.native, m.title?.english, ...(m.synonyms || [])].some((t) => t && titres.has(norm(t))));
    const ids = [...new Set(ok.map((m) => m.id))];
    return ids.length === 1 ? ids[0] : ids.length > 1 ? "ambigu" : null;
  };
  let reste = pages.filter((p) => {
    if (!p.debut) { out.set(p.slug, { id: null, note: "sans-date" }); return false; }
    if (!p.romaji && !p.natif) { out.set(p.slug, { id: null, note: "sans-titre" }); return false; }
    return true;
  });
  // Deux passes : par le romaji, puis par le titre natif pour ce qui reste.
  for (const champ of ["romaji", "natif"]) {
    const aChercher = reste.filter((p) => p[champ]);
    const suivants = reste.filter((p) => !p[champ]);
    for (let i = 0; i < aChercher.length; i += 10) {
      const lot = aChercher.slice(i, i + 10);
      const res = await rechercherLot(lot.map((p) => p[champ]));
      lot.forEach((p, k) => {
        if (!res) { out.set(p.slug, { id: null, note: "anilist-injoignable" }); return; }
        const c = choisir(p, res[k]);
        if (typeof c === "number") out.set(p.slug, { id: c, note: `titre+date (${champ})` });
        else if (c === "ambigu") out.set(p.slug, { id: null, note: "ambigu" });
        else suivants.push(p);
      });
    }
    reste = suivants;
  }
  for (const p of reste) if (!out.has(p.slug)) out.set(p.slug, { id: null, note: "aucune-entree-meme-titre-et-date" });
  return out;
}

/* ── Controle d'un lien myTV : meme doctrine qu'anime-sama (cf. son copie.mjs) ─
   LENT, DIRECT, « mort » seulement sur un 404 confirme pendant qu'un lien
   TEMOIN repond encore : voembed est le meme reseau qu'ansembed, qui rend un
   faux 404 a une IP qui a trop demande (30/10/2026). */
const VIE_PARALLELES = Number(args["vie-paralleles"] || 3);
const VIE_ECART_MS = Number(args["vie-ecart"] || 300);
let vieEnVol = 0, prochainDepart = 0;
const vieAttente = [];
async function vieJeton() {
  if (vieEnVol < VIE_PARALLELES) vieEnVol++;
  else await new Promise((r) => vieAttente.push(r));
  const depart = Math.max(Date.now(), prochainDepart);
  prochainDepart = depart + VIE_ECART_MS;
  if (depart > Date.now()) await dors(depart - Date.now());
}
function vieRendre() { const s = vieAttente.shift(); if (s) s(); else vieEnVol--; }
async function direct(url) {
  compteur.vie++;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Referer: `${VA}/` }, signal: AbortSignal.timeout(15000) });
    return { status: r.status, texte: r.ok ? await r.text() : "" };
  } catch { return { status: 0, texte: "" }; }
}
const flux = (t) => /master\.m3u8|sources\s*:/.test(t);
// Frieren 1 et One Piece 1 (vostfr), lus sur leurs pages le 31/10/2026.
const TEMOINS_DEFAUT = ["https://voembed.net/embed-oqqsbnualojj.html", "https://voembed.net/embed-symfsv4m2h5a.html"];
let temoin = null, bloque = false;
let temoinCache = [0, false];
async function temoinVivant() {
  if (Date.now() - temoinCache[0] < 20000) return temoinCache[1];
  const r = await direct(temoin);
  temoinCache = [Date.now(), r.status === 200 && flux(r.texte)];
  return temoinCache[1];
}
async function choisirTemoin(candidats) {
  for (const u of candidats) {
    const r = await direct(u);
    if (r.status === 200 && flux(r.texte)) { temoin = u; return true; }
  }
  return false;
}
const ATTENTE_MAX = Number(args["attente-max"] || 45) * 60000;
let attenteTotale = 0, deblocage = null, nbBlocages = 0;
async function attendreDeblocage() {
  if (bloque) return false;
  deblocage ||= (async () => {
    nbBlocages++;
    console.error(`pause : voembed bloque (blocage ${nbBlocages}), attente du temoin…`);
    while (attenteTotale < ATTENTE_MAX) {
      await dors(60000); attenteTotale += 60000;
      temoinCache = [0, false];
      if (await temoinVivant()) { console.error(`reprise apres ${Math.round(attenteTotale / 60000)} min d'attente cumulee`); return true; }
    }
    console.error(`BLOQUE : ${ATTENTE_MAX / 60000} min d'attente sans deblocage — controles arretes, etats connus gardes`);
    bloque = true;
    return false;
  })().finally(() => { deblocage = null; });
  return deblocage;
}
async function vie(url) {
  for (;;) {
    if (bloque) return "inconnu:bloque";
    if (deblocage) await deblocage;
    const r = await vieUneFois(url);
    if (r !== "bloque") return r;
    if (!(await attendreDeblocage())) return "inconnu:bloque";
  }
}
async function vieUneFois(url) {
  await vieJeton();
  try {
    if (bloque) return "inconnu:bloque";
    let r = await direct(url);
    if (r.status === 200 && flux(r.texte)) return "vivant";
    if (r.status === 200 && /<title>\s*Video Processing/i.test(r.texte)) return "traitement";
    if (r.status === 404) {
      await dors(2000);
      r = await direct(url);
      if (r.status === 404) { temoinCache = [0, false]; return (await temoinVivant()) ? "mort" : "bloque"; }
      if (r.status === 200 && flux(r.texte)) return "vivant";
    }
    temoinCache = [0, false];
    if (!(await temoinVivant())) return "bloque";
    return `inconnu:${r.status}`;
  } finally { vieRendre(); }
}

/* ── Base (Turso) ────────────────────────────────────────────────────────── */
function env(nom) {
  if (process.env[nom]) return process.env[nom];
  try {
    const l = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/).find((x) => x.startsWith(`${nom}=`));
    return l ? l.slice(nom.length + 1).replace(/^"|"$/g, "") : undefined;
  } catch { return undefined; }
}
const db = args.ecrire ? createClient({ url: env("TURSO_DATABASE_URL"), authToken: env("TURSO_AUTH_TOKEN") }) : null;
/* Une ligne par page. `episodes` : {"num": [chemin_page_episode, lien_mytv|null, etat, vu_ms, lu_ms]}
   (lu = derniere lecture de la page d'episode). `h` : empreinte du slug, pour les tranches. */
const SCHEMA = `CREATE TABLE IF NOT EXISTS va_page (
  slug TEXT PRIMARY KEY, langue TEXT NOT NULL, h INTEGER NOT NULL,
  lastmod TEXT, romaji TEXT, natif TEXT, anglais TEXT, type TEXT, statut TEXT, debut TEXT,
  anilist INTEGER, ancre TEXT, ancre_le INTEGER,
  num_min INTEGER, num_max INTEGER, nb_ep INTEGER NOT NULL,
  nb_vivants INTEGER NOT NULL, nb_morts INTEGER NOT NULL,
  episodes TEXT NOT NULL, empreinte TEXT NOT NULL, maj_le INTEGER NOT NULL)`;
const hash = (s) => createHash("sha1").update(s).digest().readUInt32BE(0);
const langueDe = (slug) => (/-vf(-[a-z0-9]{1,3})?$/.test(slug) ? "vf" : "vostfr");

async function lireConnus(tranche) {
  const pages = new Map();
  if (!db) return pages;
  await db.execute(SCHEMA);
  // Lu par le site (lib/db/vaPage.ts) quand player_map n'a pas de ligne.
  await db.execute("CREATE INDEX IF NOT EXISTS va_page_ancre ON va_page(anilist, langue)");
  const r = tranche
    ? await db.execute({ sql: "SELECT * FROM va_page WHERE h % ? = ?", args: [tranche[1], tranche[0]] })
    : await db.execute("SELECT * FROM va_page");
  for (const x of r.rows) {
    let episodes = {};
    try { episodes = JSON.parse(x.episodes); } catch { /* illisible : tout sera relu */ }
    pages.set(x.slug, { ...x, episodes });
  }
  return pages;
}

const changements = { nouvelles: [], perdues: [], revenues: [], plus: 0, moins: 0 };
async function ecrire(p, avant) {
  let vivants = 0, morts = 0;
  for (const e of Object.values(p.episodes)) {
    if (e[2] === "vivant") vivants++; else if (e[2] === "mort") morts++;
  }
  const nums = Object.keys(p.episodes).map(Number);
  const contenu = JSON.stringify([p.lastmod, p.romaji, p.natif, p.type, p.debut, p.anilist, p.ancre,
    Object.entries(p.episodes).map(([n, e]) => [n, e[0], e[1], e[2]])]);
  const empreinte = createHash("sha1").update(contenu).digest("hex").slice(0, 16);
  // Rien de change et aucun controle pendant ce passage : rien a ecrire.
  if (avant?.empreinte === empreinte && !Object.values(p.episodes).some((e) => e[3] >= DEBUT || e[4] >= DEBUT)) return 0;
  const vAvant = avant ? Number(avant.nb_vivants) : undefined;
  if (avant?.empreinte !== empreinte) {
    if (vAvant === undefined) { if (vivants) changements.nouvelles.push(`${p.slug} (${vivants} ep.)`); }
    else if (vAvant > 0 && vivants === 0) changements.perdues.push(`${p.slug} (${vAvant} ep. avant)`);
    else if (vAvant === 0 && vivants > 0) changements.revenues.push(`${p.slug} (${vivants} ep.)`);
    const d = vivants - (vAvant || 0);
    if (d > 0) changements.plus += d; else changements.moins -= d;
  }
  if (!db) return 0;
  await db.execute({
    sql: `INSERT INTO va_page (slug, langue, h, lastmod, romaji, natif, anglais, type, statut, debut, anilist, ancre, ancre_le,
            num_min, num_max, nb_ep, nb_vivants, nb_morts, episodes, empreinte, maj_le)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(slug) DO UPDATE SET langue=excluded.langue, h=excluded.h, lastmod=excluded.lastmod,
            romaji=excluded.romaji, natif=excluded.natif, anglais=excluded.anglais, type=excluded.type,
            statut=excluded.statut, debut=excluded.debut, anilist=excluded.anilist, ancre=excluded.ancre,
            ancre_le=excluded.ancre_le, num_min=excluded.num_min, num_max=excluded.num_max, nb_ep=excluded.nb_ep,
            nb_vivants=excluded.nb_vivants, nb_morts=excluded.nb_morts, episodes=excluded.episodes,
            empreinte=excluded.empreinte, maj_le=excluded.maj_le`,
    args: [p.slug, langueDe(p.slug), hash(p.slug), p.lastmod, p.romaji, p.natif, p.anglais, p.type, p.statut, p.debut,
      p.anilist, p.ancre, p.ancre_le, nums.length ? Math.min(...nums) : null, nums.length ? Math.max(...nums) : null,
      nums.length, vivants, morts, JSON.stringify(p.episodes), empreinte, Date.now()],
  });
  return 1;
}

/* ── Programme ───────────────────────────────────────────────────────────── */
const t0 = Date.now();
const DEBUT = t0;
const tranche = args.tranche ? args.tranche.split("/").map(Number) : null;
const connus = await lireConnus(tranche);

let cibles; // slug -> lastmod
if (args.slugs) cibles = new Map(args.slugs.split(",").map((s) => [s, null]));
else {
  cibles = await catalogue();
  cibles.delete("");
  console.log(`catalogue : ${cibles.size} pages (${compteur.va} requetes)`);
  if (cibles.size < 3000) {
    console.error(`CONTRAT ROMPU : ${cibles.size} pages dans les sitemaps (attendu > 6 000) — rien n'est ecrit`);
    process.exit(3);
  }
  if (tranche) {
    for (const s of [...cibles.keys()]) if (hash(s) % tranche[1] !== tranche[0]) cibles.delete(s);
    console.log(`tranche ${tranche[0]}/${tranche[1]} : ${cibles.size} pages`);
  }
  if (args.mesure) cibles = new Map([...cibles].sort(() => Math.random() - 0.5).slice(0, Number(args.mesure)));
}

if (!args["sans-vie"]) {
  const vivantsConnus = [...connus.values()].flatMap((p) => Object.values(p.episodes))
    .filter((e) => e[2] === "vivant" && e[1]).sort((a, b) => b[3] - a[3]).slice(0, 4).map((e) => e[1]);
  if (await choisirTemoin([...TEMOINS_DEFAUT, ...vivantsConnus])) console.log(`temoin : ${temoin}`);
  else {
    temoin = TEMOINS_DEFAUT[0];
    if (await attendreDeblocage()) console.log(`temoin : ${temoin} (apres attente)`);
    else console.error("BLOQUE : aucun temoin ne repond — copie SANS controle, etats connus gardes");
  }
}

/* 1. Pages a relire : nouvelles, ou annoncees modifiees par le sitemap. */
const bilan = { pages: 0, relues: 0, erreurs: 0, sansAncre: 0, episodes: 0, avecMyTV: 0, liens: 0, vivants: 0, morts: 0, traitement: 0, inconnus: 0, nonControles: 0, pagesEpisodeLues: 0 };
const pages = new Map();
let illisibles = 0, lues = 0;
await Promise.all([...cibles].map(async ([slug, lastmod]) => {
  const avant = connus.get(slug);
  if (avant && lastmod && avant.lastmod === lastmod && !args.slugs) {
    pages.set(slug, { ...avant, lastmod, relue: false });
    return;
  }
  const p = await lirePage(slug);
  if (p.erreur) { bilan.erreurs++; if (avant) pages.set(slug, { ...avant, relue: false }); return; }
  lues++;
  if (!p.lisible) illisibles++;
  if (lues >= 30 && illisibles > lues / 2) {
    console.error("CONTRAT ROMPU : plus de la moitie des pages sans titres AniList — format change, arret");
    process.exit(3);
  }
  // Episodes : on garde ce qu'on savait de chaque numero toujours present a la meme adresse.
  const episodes = {};
  for (const [n, chemin] of Object.entries(p.episodes)) {
    const e = avant?.episodes?.[n];
    episodes[n] = e && e[0] === chemin ? e : [chemin, null, "non-lu", 0, 0];
  }
  pages.set(slug, {
    slug, lastmod, romaji: p.romaji, natif: p.natif, anglais: p.anglais, type: p.type, statut: p.statut, debut: p.debut,
    anilist: avant?.anilist ?? null, ancre: avant?.ancre ?? null, ancre_le: avant?.ancre_le ?? 0,
    metaChangee: !avant || avant.romaji !== p.romaji || avant.natif !== p.natif || avant.debut !== p.debut,
    episodes, relue: true,
  });
}));
bilan.relues = lues;
console.log(`${pages.size} pages, ${lues} relues (${compteur.va} requetes voir-anime)`);

/* 2. Ancres : pages nouvelles ou changees, et sans ancre depuis JOURS_ANCRE jours. */
const aAncrer = [...pages.values()].filter((p) => p.metaChangee || (!p.anilist && Date.now() - Number(p.ancre_le || 0) > JOURS_ANCRE * 864e5));
if (aAncrer.length) {
  // Reutilise les titres connus pour les pages non relues.
  const ancres = await ancrer(aAncrer);
  for (const p of aAncrer) {
    const a = ancres.get(p.slug);
    if (a.note === "anilist-injoignable") continue;
    p.anilist = a.id; p.ancre = a.note; p.ancre_le = Date.now();
  }
  console.log(`${aAncrer.length} page(s) ancree(s) sur AniList (${compteur.anilist} requetes)`);
}

/* 3. Pages d'episode (lien myTV) et controles. */
let ecrites = 0;
const tPages = [...pages.values()];
let faites = 0;
const PAGES_EP_MAX = Number(args["pages-episode-max"] || 1e9);
let pagesEpisode = 0;
async function traiter(p) {
  const maintenant0 = Date.now();
  const nums = Object.keys(p.episodes);
  const avecLien = nums.filter((n) => p.episodes[n][1]);
  const temoins = new Set([avecLien[0], avecLien[Math.floor(avecLien.length / 2)], avecLien.at(-1)].filter(Boolean));
  await Promise.all(nums.map(async (n) => {
    const e = p.episodes[n];
    /* La page d'episode : jamais lue, ou lien mort / absent depuis plus de deux
       jours (voir-anime remplace parfois un fichier), ou a tour de role. */
    const relire = e[2] === "non-lu" ||
      ((e[2] === "mort" || !e[1]) && maintenant0 - e[4] > 2 * 864e5) ||
      maintenant0 - e[4] > 4 * JOURS_VIE * 864e5;
    if (relire && pagesEpisode < PAGES_EP_MAX) {
      pagesEpisode++;
      const lien = await lienMyTV(e[0]);
      if (lien !== undefined) {
        bilan.pagesEpisodeLues++;
        if (lien !== e[1]) { e[1] = lien; e[2] = lien ? "non-controle" : "sans-mytv"; e[3] = 0; }
        e[4] = Date.now();
      }
    }
    if (!e[1] || args["sans-vie"]) return;
    const age = maintenant0 - e[3];
    const sur = e[2] === "vivant" || e[2] === "mort";
    const estTemoin = temoins.has(n);
    const aRevoir = estTemoin ? age > 2 * 864e5 || !sur : age > JOURS_VIE * 864e5 || !sur;
    if (!aRevoir || (!estTemoin && budgetVie <= 0)) return;
    if (!estTemoin) budgetVie--;
    const etat = await vie(e[1]);
    // L'inconnu n'efface rien : etat et date d'avant gardes.
    if (String(etat).startsWith("inconnu")) { if (!sur) e[2] = "non-controle"; return; }
    e[2] = etat; e[3] = Date.now();
  }));
  bilan.pages++;
  if (!p.anilist) bilan.sansAncre++;
  for (const e of Object.values(p.episodes)) {
    bilan.episodes++;
    if (!e[1]) continue;
    bilan.avecMyTV++; bilan.liens++;
    if (e[2] === "vivant") bilan.vivants++; else if (e[2] === "mort") bilan.morts++;
    else if (e[2] === "traitement") bilan.traitement++; else if (e[2] === "non-controle") bilan.nonControles++;
    else bilan.inconnus++;
  }
  if (cibles.size <= 20) {
    const v = Object.values(p.episodes).filter((e) => e[2] === "vivant").length;
    console.log(`  ${p.slug} (AniList ${p.anilist ?? "?"} : ${p.ancre}) ${p.type || "?"} ${p.debut || "?"} : ${v}/${nums.length} vivants`);
  }
  const n = await ecrire(p, connus.get(p.slug));
  ecrites += n;
  if (++faites % 100 === 0) {
    const s = Math.round((Date.now() - t0) / 1000);
    console.log(`[${faites}/${tPages.length}] liens ${bilan.vivants} vivants, ${bilan.morts} morts · ${bilan.pagesEpisodeLues} pages d'episode lues · ${Math.round(s / 60)} min`);
  }
}
let k = 0;
await Promise.all(Array.from({ length: Number(args.concurrence || 6) }, async () => {
  while (k < tPages.length) await traiter(tPages[k++]);
}));
const duree = Math.round((Date.now() - t0) / 1000);
console.log(`\nbilan ${JSON.stringify(bilan)}`);
console.log(`requetes : voir-anime ${compteur.va} (erreurs ${compteur.vaErreurs}), voembed ${compteur.vie}, AniList ${compteur.anilist} — ${duree} s`);
if (args.json) fs.writeFileSync(args.json, JSON.stringify([...pages.values()], null, 1));
if (db) console.log(`va_page : ${ecrites} ligne(s) ecrite(s)`);

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : "—");
const liste = (titre, l) => (l.length ? [`**${titre} (${l.length})**`, ...l.slice(0, 25).map((x) => `- ${x}`), ...(l.length > 25 ? [`- … et ${l.length - 25} autres`] : []), ""] : []);
const recap = [
  `## Copie voir-anime (myTV) — ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`, "",
  ...(bloque ? ["> ⚠️ **Controles suspendus** : voembed repond « introuvable » meme au lien temoin — notre adresse est bloquee, pas les videos. Etats d'avant gardes.", ""] : []),
  ...(nbBlocages ? [`Voembed a bloque ${nbBlocages} fois ; ${Math.round(attenteTotale / 60000)} min d'attente au total.`, ""] : []),
  `Duree ${Math.round(duree / 60)} min${args.tranche ? ` (tranche ${args.tranche})` : ""} · ${bilan.pages} pages (${bilan.relues} relues, ${bilan.erreurs} en erreur, ${bilan.sansAncre} sans ancre AniList) · ${compteur.va} requetes voir-anime`, "",
  "| | |", "| --- | --: |",
  `| Episodes avec un lien myTV | ${bilan.avecMyTV} / ${bilan.episodes} |`,
  `| Pages d'episode lues cette nuit | ${bilan.pagesEpisodeLues} |`,
  `| Liens vivants | ${bilan.vivants} (${pct(bilan.vivants, bilan.liens)}) |`,
  `| Liens morts (404 confirme) | ${bilan.morts} (${pct(bilan.morts, bilan.liens)}) |`,
  `| Liens en traitement chez eux | ${bilan.traitement} |`,
  `| Liens pas encore controles | ${bilan.nonControles} |`,
  `| Liens inconnus (refus, a revoir) | ${bilan.inconnus} |`,
  `| Lignes ecrites | ${ecrites} |`, "",
  ...(db ? [
    `Depuis le passage precedent : +${changements.plus} episode(s) jouable(s), −${changements.moins}.`, "",
    ...liste("Nouvelles pages jouables", changements.nouvelles),
    ...liste("Pages qui n'ont plus aucun lien vivant", changements.perdues),
    ...liste("Pages revenues", changements.revenues),
  ] : []),
].join("\n");
console.log(`\n${recap}`);
if (args.md) fs.appendFileSync(args.md, `${recap}\n`);
if (bloque) process.exit(4);
