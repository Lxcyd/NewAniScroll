#!/usr/bin/env node
/**
 * Copie de ce qu'anime-sama sait, pour les SEULS lecteurs valides (ansembed,
 * famille vidmoly — cf. lib/lecteurs.json et la decision de Luc du 30/10/2026).
 *
 * Pour chaque fiche : l'id AniList qu'elle affiche, ses saisons, et pour chaque
 * saison x langue, quels episodes ont un lien vidmoly — en VERIFIANT que le
 * lien est vivant (embed 200 avec un master.m3u8 = vivant ; 404 = mort).
 *
 * Tout passe par le Worker (anime-sama refuse les IP de datacenter) : aucun
 * appel a Vercel, aucune boucle contre aniscroll.com.
 *
 *   node tools/anime-sama/copie.mjs --mesure=10            echantillon : couts et resultats
 *   node tools/anime-sama/copie.mjs --slugs=frieren,…      fiches donnees
 *   node tools/anime-sama/copie.mjs --toutes [--json=F]    tout le catalogue
 *   options : --sans-vie (ne pas controler les liens), --concurrence=4,
 *             --ecrire (table Turso `as_panneau`, seulement ce qui change)
 *
 * CONTROLES : trois liens temoins par saison x langue chaque nuit, les autres
 * a tour de role (JOURS_VIE jours, budget --budget-vie par nuit), lentement et
 * en direct — cf. le commentaire de `vie`.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";

const JOURS_VIE = 14;

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "1"];
}));
const WORKER = process.env.PROXY_BASE || "https://proxy.aniscroll.com";
const AS = "https://anime-sama.to";
const CONC = Number(args.concurrence || 12); // fiches en cours a la fois
// Liens hors temoins controles par nuit (le reste attend son tour).
let budgetVie = Number(args["budget-vie"] || 4000);
const LANGUES = ["vostfr", "vf", "vf1", "vf2"];

const compteur = { requetes: 0, erreurs: 0 };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

/* UN SEUL PLAFOND pour toute la copie : au plus PARALLELES requetes en vol,
   qu'elles lisent une fiche, une saison ou controlent un lien. Les etages
   (fiches, saisons, liens) lancent tout ce qu'ils ont ; c'est ce plafond qui
   regle le debit. Avant, chaque etage avait son propre « 4 a la fois » et une
   longue serie bloquait son paquet entier : 200 fiches en 19 minutes. */
const PARALLELES = Number(args.paralleles || 24);
let enVol = 0;
const attente = [];
async function jeton() {
  if (enVol < PARALLELES) { enVol++; return; }
  await new Promise((r) => attente.push(r));
}
function rendre() {
  const suivant = attente.shift();
  if (suivant) suivant(); else enVol--;
}

/** Une requete par le Worker. `referer` : anime-sama exige d'etre « sur le site ». */
async function viaWorker(url, referer = `${AS}/`) {
  await jeton();
  try { return await viaWorkerLibre(url, referer); } finally { rendre(); }
}
async function viaWorkerLibre(url, referer) {
  compteur.requetes++;
  const u = `${WORKER}/?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`;
  for (let essai = 0; essai < 3; essai++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) { await dors(2000 * (essai + 1)); continue; }
      // Le corps meme en erreur : le Worker y met le code amont (`upstream`).
      return { status: r.status, texte: await r.text().catch(() => "") };
    } catch {
      await dors(2000 * (essai + 1));
    }
  }
  compteur.erreurs++;
  return { status: 0, texte: "" };
}

/** Execute `fn` sur chaque element, `CONC` a la fois. */
async function parLots(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** Toutes les fiches anime (hors scans seuls) du catalogue. */
async function catalogue() {
  const slugs = new Map();
  for (let page = 1; page < 200; page++) {
    const { texte } = await viaWorker(`${AS}/catalogue/?page=${page}`);
    const avant = slugs.size;
    for (const m of texte.matchAll(/data-url="\/catalogue\/([a-z0-9-]+)\/"[\s\S]*?<\/a>/g)) {
      const types = [...m[0].matchAll(/as-badge-anime">([^<]+)</g)].map((x) => x[1]);
      // Le drapeau VF de la carte : sans lui, inutile de sonder vf/vf1/vf2.
      if (types.length) slugs.set(m[1], { types, vf: /alt="VF"/.test(m[0]) });
    }
    if (slugs.size === avant) break;
  }
  return slugs;
}

/** Les domaines de la famille vidmoly, d'apres LEUR table (`nom: "Vidmoly"`). */
function domainesVidmoly(html) {
  const m = html.match(/var lecteursInfos = (\{[\s\S]*?\});/);
  const base = ["ansembed.net", "vidmoly.to", "vidmoly.net", "vidmoly.biz"];
  if (!m) return { domaines: base, depuisLeurTable: false };
  try {
    const t = JSON.parse(m[1]);
    const d = Object.keys(t).filter((k) => /vidmoly/i.test(t[k]?.nom || ""));
    return { domaines: d.length ? d : base, depuisLeurTable: true };
  } catch {
    return { domaines: base, depuisLeurTable: false };
  }
}

/** Fiche : id AniList / MAL et saisons (`panneauAnime("Saison 1", "saison1/vostfr")`). */
async function fiche(slug) {
  const { status, texte } = await viaWorker(`${AS}/catalogue/${slug}/`);
  if (status !== 200) return { slug, erreur: `fiche ${status}` };
  const sansCommentaires = texte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
  const saisons = [...sansCommentaires.matchAll(/panneauAnime\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)]
    .map((m) => ({ libelle: m[1], dossier: m[2].split("/")[0] }))
    .filter((s) => s.libelle !== "nom" && /^(saison|film|oav|special|kai)/i.test(s.dossier));
  const vus = new Set();
  return {
    slug,
    anilist: Number(texte.match(/anilist\.co\/anime\/(\d+)/)?.[1]) || null,
    mal: Number(texte.match(/myanimelist\.net\/anime\/(\d+)/)?.[1]) || null,
    saisons: saisons.filter((s) => !vus.has(s.dossier) && vus.add(s.dossier)),
  };
}

/** Les listes `epsN` d'un panneau, ou null si le panneau n'existe pas. */
async function panneau(slug, dossier, langue) {
  const ref = `${AS}/catalogue/${slug}/${dossier}/${langue}/`;
  const { status, texte } = await viaWorker(`${ref}episodes.js`, ref);
  if (status !== 200 || !/var\s+eps\d+/.test(texte)) return null;
  return [...texte.matchAll(/var\s+(eps\d+)\s*=\s*\[([\s\S]*?)\];/g)].map((m) => ({
    liste: m[1],
    liens: [...m[2].matchAll(/['"]([^'"]*)['"]/g)].map((x) => x[1].trim()),
  }));
}

/** Vivant / mort / inconnu. Un parametre du jour contourne le cache 24 h du Worker. */
/* ── Controle d'un lien : LENT, DIRECT, et « mort » seulement sur un 404 ──────
   Lecon du 30/10/2026 : a 24 controles en parallele par le Worker, ansembed a
   refuse (403 puis 503) — et le Worker rend tout refus 401/403/404/410 en
   « 410 », que la premiere version lisait « mort ». 820 liens vivants sont
   ainsi sortis morts sur un echantillon de 5 fiches. Desormais :
     - au plus VIE_PARALLELES controles a la fois, VIE_ECART_MS entre deux ;
     - en DIRECT d'abord (le visiteur aussi va chercher ansembed en direct) ;
     - « mort » = 404 direct confirme deux fois, ou `upstream: 404` du Worker ;
     - tout refus (403, 429, 5xx, reseau) = « inconnu », recontrole plus tard ;
     - trois refus de suite = pause generale d'une minute. */
const VIE_PARALLELES = Number(args["vie-paralleles"] || 3);
const VIE_ECART_MS = Number(args["vie-ecart"] || 300);
const UA_NAV = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
let vieEnVol = 0, prochainDepart = 0, refusDeSuite = 0, pauseJusqua = 0;
const vieAttente = [];
async function vieJeton() {
  if (vieEnVol < VIE_PARALLELES) vieEnVol++;
  else await new Promise((r) => vieAttente.push(r));
  // Espacement global des departs, et pause apres des refus en serie.
  const depart = Math.max(Date.now(), prochainDepart, pauseJusqua);
  prochainDepart = depart + VIE_ECART_MS;
  if (depart > Date.now()) await dors(depart - Date.now());
}
function vieRendre() {
  const s = vieAttente.shift();
  if (s) s(); else vieEnVol--;
}
async function direct(url) {
  compteur.requetes++;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA_NAV, Referer: `${AS}/` }, signal: AbortSignal.timeout(15000) });
    return { status: r.status, texte: r.ok ? await r.text() : "" };
  } catch {
    return { status: 0, texte: "" };
  }
}
const flux = (t) => /master\.m3u8|sources\s*:/.test(t);
async function vie(url) {
  await vieJeton();
  try {
    let r = await direct(url);
    if (r.status === 200 && flux(r.texte)) { refusDeSuite = 0; return "vivant"; }
    if (r.status === 404) {
      await dors(2000);
      r = await direct(url);
      if (r.status === 404) { refusDeSuite = 0; return "mort"; }
      if (r.status === 200 && flux(r.texte)) return "vivant";
    }
    // Refus ou reseau : un essai par le Worker, en lisant le VRAI code amont.
    const w = await viaWorker(url);
    if (w.status === 200 && flux(w.texte)) { refusDeSuite = 0; return "vivant"; }
    if (Number(w.texte.match(/"upstream"\s*:\s*(\d+)/)?.[1]) === 404) { refusDeSuite = 0; return "mort"; }
    if (++refusDeSuite >= 3) { pauseJusqua = Date.now() + 60000; refusDeSuite = 0; }
    return `inconnu:${r.status}/${w.status}`;
  } finally {
    vieRendre();
  }
}

async function copierFiche(slug, domaines, carte = null, connus = new Map()) {
  const f = await fiche(slug);
  if (f.erreur) return f;
  const estVidmoly = (u) => { try { return domaines.includes(new URL(u).hostname.replace(/^www\./, "")); } catch { return false; } };
  f.panneaux = [];
  const langues = carte && !carte.vf ? ["vostfr"] : LANGUES;
  // Toutes les saisons x langues en parallele (le plafond global regle le debit).
  const combinaisons = f.saisons.flatMap((s) => langues.map((langue) => ({ s, langue })));
  const lus = await Promise.all(combinaisons.map(({ s, langue }) => panneau(slug, s.dossier, langue)));
  combinaisons.forEach(({ s, langue }, k) => {
    const listes = lus[k];
    if (!listes) return;
    const nbEp = Math.max(...listes.map((l) => l.liens.length));
    const episodes = [];
    for (let i = 0; i < nbEp; i++) {
      const liens = listes.map((l) => l.liens[i]).filter((u) => u && estVidmoly(u));
      episodes.push({ ep: i + 1, liens });
    }
    f.panneaux.push({ dossier: s.dossier, libelle: s.libelle, langue, nbEp, episodes });
  });
  if (!args["sans-vie"]) {
    /* QUOI CONTROLER CETTE NUIT.
       - Trois TEMOINS par saison x langue (premier, milieu, dernier episode
         qui a un lien) : recontroles s'ils ont plus de deux jours. Ils suffisent a
         dire « cette saison a un lien vivant », ce que la parite demande.
       - Les autres liens : a tour de role, s'ils ont plus de JOURS_VIE jours,
         dans la limite du BUDGET de la nuit — tout est revu en ~2 semaines.
       Un lien jamais controle reste « non-controle », jamais « mort ». */
    const maintenant0 = Date.now();
    const aControler = [];
    for (const p of f.panneaux) {
      const avecLien = p.episodes.filter((e) => e.liens.length);
      const temoins = new Set([avecLien[0], avecLien[Math.floor(avecLien.length / 2)], avecLien.at(-1)].filter(Boolean));
      for (const e of avecLien) {
        for (const u of e.liens) {
          const c = connus.get(u);
          const age = c ? maintenant0 - c.vu : Infinity;
          const sur = c && !String(c.etat).startsWith("inconnu") && c.etat !== "non-controle";
          const temoin = temoins.has(e) && u === e.liens[0];
          const aRevoir = temoin ? age > 2 * 864e5 || !sur : age > JOURS_VIE * 864e5 || !sur;
          if (aRevoir && (temoin || budgetVie > 0)) {
            if (!temoin) budgetVie--;
            aControler.push({ e, u });
          } else {
            (e.etats ||= {})[u] = c?.etat || "non-controle";
            (e.vus ||= {})[u] = c?.vu || 0;
          }
        }
      }
    }
    const etats = await Promise.all(aControler.map(({ u }) => vie(u)));
    const maintenant = Date.now();
    aControler.forEach(({ e, u }, k) => {
      (e.etats ||= {})[u] = etats[k];
      (e.vus ||= {})[u] = maintenant;
    });
  }
  return f;
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
const SCHEMA = `CREATE TABLE IF NOT EXISTS as_panneau (
  slug TEXT NOT NULL, dossier TEXT NOT NULL, langue TEXT NOT NULL,
  libelle TEXT, anilist_fiche INTEGER, nb_ep INTEGER NOT NULL,
  nb_vivants INTEGER NOT NULL, nb_morts INTEGER NOT NULL,
  liens TEXT NOT NULL,          -- {"ep":[[url, etat, vu_ms], …]}
  empreinte TEXT NOT NULL, maj_le INTEGER NOT NULL,
  PRIMARY KEY (slug, dossier, langue))`;

/** L'etat connu de chaque lien (url -> {etat, vu}) et l'empreinte de chaque panneau. */
async function lireConnus() {
  const liens = new Map(), empreintes = new Map();
  if (!db) return { liens, empreintes };
  await db.execute(SCHEMA);
  const r = await db.execute("SELECT slug, dossier, langue, liens, empreinte FROM as_panneau");
  for (const x of r.rows) {
    empreintes.set(`${x.slug}/${x.dossier}/${x.langue}`, x.empreinte);
    try {
      for (const lst of Object.values(JSON.parse(x.liens))) for (const [u, etat, vu] of lst) liens.set(u, { etat, vu });
    } catch { /* ligne illisible : tout sera recontrole */ }
  }
  return { liens, empreintes };
}

/** Une ligne par panneau ; n'ecrit que si le CONTENU a change (empreinte sans les dates). */
async function ecrire(fiches, empreintes) {
  if (!db) return 0;
  const ops = [];
  for (const f of fiches) {
    for (const p of f.panneaux || []) {
      const liens = {};
      let vivants = 0, morts = 0;
      for (const e of p.episodes) {
        if (!e.liens.length) continue;
        liens[e.ep] = e.liens.map((u) => [u, e.etats?.[u] || "inconnu", e.vus?.[u] || 0]);
        if (e.liens.some((u) => e.etats?.[u] === "vivant")) vivants++;
        else if (e.liens.every((u) => e.etats?.[u] === "mort")) morts++;
      }
      const contenu = JSON.stringify([f.anilist, p.libelle, p.nbEp, Object.entries(liens).map(([ep, l]) => [ep, l.map((x) => [x[0], x[1]])])]);
      const empreinte = createHash("sha1").update(contenu).digest("hex").slice(0, 16);
      const cle = `${f.slug}/${p.dossier}/${p.langue}`;
      /* Meme contenu ET aucun lien recontrole pendant ce passage : rien a
         ecrire. Un lien recontrole doit l'etre, sinon sa date de controle ne
         bougerait jamais et la rotation le reverifierait chaque nuit. */
      if (empreintes.get(cle) === empreinte && !Object.values(liens).flat().some((x) => x[2] >= DEBUT)) continue;
      ops.push({
        sql: `INSERT INTO as_panneau (slug, dossier, langue, libelle, anilist_fiche, nb_ep, nb_vivants, nb_morts, liens, empreinte, maj_le)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(slug, dossier, langue) DO UPDATE SET libelle=excluded.libelle, anilist_fiche=excluded.anilist_fiche,
                nb_ep=excluded.nb_ep, nb_vivants=excluded.nb_vivants, nb_morts=excluded.nb_morts, liens=excluded.liens,
                empreinte=excluded.empreinte, maj_le=excluded.maj_le`,
        args: [f.slug, p.dossier, p.langue, p.libelle, f.anilist, p.nbEp, vivants, morts, JSON.stringify(liens), empreinte, Date.now()],
      });
    }
  }
  for (let i = 0; i < ops.length; i += 100) await db.batch(ops.slice(i, i + 100), "write");
  return ops.length;
}

/* ── Programme ───────────────────────────────────────────────────────────── */
const t0 = Date.now();
const DEBUT = t0;
const connus = await lireConnus();
// La table des lecteurs vit sur les pages d'episodes : on la lit sur une saison connue.
const { texte: pageRef } = await viaWorker(`${AS}/catalogue/frieren/saison1/vostfr/`);
const { domaines, depuisLeurTable } = domainesVidmoly(pageRef);
console.log(`famille vidmoly (${depuisLeurTable ? "leur table" : "liste par defaut"}) : ${domaines.join(", ")}`);

let slugs;
let cat = new Map();
if (args.slugs) slugs = args.slugs.split(",");
else {
  cat = await catalogue();
  console.log(`catalogue : ${cat.size} fiches anime (${compteur.requetes} requetes)`);
  /* Contrat avec leur site : un catalogue presque vide veut dire que la page a
     change de forme, pas qu'anime-sama a tout retire. On s'arrete sans rien
     ecrire, et le code de sortie le signale. */
  if (cat.size < 500) {
    console.error(`CONTRAT ROMPU : ${cat.size} fiches lues (attendu > 1 500) — rien n'est ecrit`);
    process.exit(3);
  }
  slugs = [...cat.keys()];
  if (args.mesure) slugs = slugs.sort(() => Math.random() - 0.5).slice(0, Number(args.mesure));
}

const bilan = { fiches: 0, erreurs: 0, nonControles: 0, sansAnilist: 0, panneaux: 0, episodes: 0, avecVidmoly: 0, liens: 0, vivants: 0, morts: 0, inconnus: 0 };
const toutes = [];
let ecrites = 0, avecId = 0, lisibles = 0;
/* EN CONTINU : CONC fiches en cours a tout moment, chacune ecrite des qu'elle
   est finie. Une longue serie n'arrete plus les autres. */
async function traiter(slug) {
  const f = await copierFiche(slug, domaines, cat.get(slug), connus.liens);
  bilan.fiches++;
  if (f.erreur) { bilan.erreurs++; console.log(`  ${f.slug} : ${f.erreur}`); return; }
  lisibles++;
  if (f.anilist) avecId++; else bilan.sansAnilist++;
  /* Contrat : passe 30 fiches lisibles, une majorite sans id AniList veut
     dire que leur format de fiche a change. On s'arrete. */
  if (lisibles >= 30 && avecId < lisibles / 2) {
    console.error("CONTRAT ROMPU : moins de la moitie des fiches portent un id AniList — arret");
    process.exit(3);
  }
  for (const pn of f.panneaux || []) {
    bilan.panneaux++;
    bilan.episodes += pn.nbEp;
    for (const e of pn.episodes) {
      if (e.liens.length) bilan.avecVidmoly++;
      for (const u of e.liens) {
        bilan.liens++;
        const st = e.etats?.[u];
        if (st === "vivant") bilan.vivants++; else if (st === "mort") bilan.morts++; else if (st === "non-controle") bilan.nonControles++; else if (st) bilan.inconnus++;
      }
    }
  }
  if (slugs.length <= 20) {
    const resume = (f.panneaux || []).map((pn) => {
      const v = pn.episodes.filter((e) => Object.values(e.etats || {}).includes("vivant")).length;
      return `${pn.dossier}/${pn.langue} ${v}/${pn.nbEp}`;
    }).join(" · ");
    console.log(`  ${f.slug} (AniList ${f.anilist ?? "?"}) : ${resume || "aucun panneau"}`);
  }
  if (db) ecrites += await ecrire([f], connus.empreintes);
  if (args.json) toutes.push(f);
  if (slugs.length > 20 && bilan.fiches % 50 === 0) {
    console.log(`[${bilan.fiches}/${slugs.length}] ${compteur.requetes} requetes, ${ecrites} ligne(s) ecrite(s), ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}
await parLots(slugs, traiter);
const duree = Math.round((Date.now() - t0) / 1000);
console.log(`
bilan ${JSON.stringify(bilan)}`);
console.log(`requetes Worker : ${compteur.requetes} (erreurs ${compteur.erreurs}) en ${duree} s`);
if (args.json) fs.writeFileSync(args.json, JSON.stringify({ le: new Date().toISOString(), domaines, fiches: toutes }, null, 1));
if (db) console.log(`as_panneau : ${ecrites} ligne(s) ecrite(s)`);
