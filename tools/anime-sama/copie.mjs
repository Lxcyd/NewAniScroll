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
 * ROTATION DES CONTROLES (avec --ecrire) : un lien deja connu n'est recontrole
 * que s'il ne l'a pas ete depuis JOURS_VIE jours ; un lien nouveau l'est tout
 * de suite. Mesure du 30/10/2026 : 1 585 fiches, ~24 requetes Worker par
 * fiche en controlant tout ; le Worker sert 3 000 a 6 000 requetes par jour
 * pour 100 000 permises.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";

const JOURS_VIE = 3;

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "1"];
}));
const WORKER = process.env.PROXY_BASE || "https://proxy.aniscroll.com";
const AS = "https://anime-sama.to";
const CONC = Number(args.concurrence || 4);
const LANGUES = ["vostfr", "vf", "vf1", "vf2"];

const compteur = { requetes: 0, erreurs: 0 };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

/** Une requete par le Worker. `referer` : anime-sama exige d'etre « sur le site ». */
async function viaWorker(url, referer = `${AS}/`) {
  compteur.requetes++;
  const u = `${WORKER}/?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`;
  for (let essai = 0; essai < 3; essai++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) { await dors(2000 * (essai + 1)); continue; }
      return { status: r.status, texte: r.ok ? await r.text() : "" };
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
async function vie(url) {
  const jour = new Date().toISOString().slice(0, 10);
  const { status, texte } = await viaWorker(`${url}${url.includes("?") ? "&" : "?"}_=${jour}`);
  if (status === 200 && /master\.m3u8|sources\s*:/.test(texte)) return "vivant";
  if (status === 404 || status === 410) return "mort";
  return `inconnu:${status}`;
}

async function copierFiche(slug, domaines, carte = null, connus = new Map()) {
  const f = await fiche(slug);
  if (f.erreur) return f;
  const estVidmoly = (u) => { try { return domaines.includes(new URL(u).hostname.replace(/^www\./, "")); } catch { return false; } };
  f.panneaux = [];
  const langues = carte && !carte.vf ? ["vostfr"] : LANGUES;
  for (const s of f.saisons) {
    for (const langue of langues) {
      const listes = await panneau(slug, s.dossier, langue);
      if (!listes) continue;
      const nbEp = Math.max(...listes.map((l) => l.liens.length));
      const episodes = [];
      for (let i = 0; i < nbEp; i++) {
        const liens = listes.map((l) => l.liens[i]).filter((u) => u && estVidmoly(u));
        episodes.push({ ep: i + 1, liens });
      }
      f.panneaux.push({ dossier: s.dossier, libelle: s.libelle, langue, nbEp, episodes });
    }
  }
  if (!args["sans-vie"]) {
    const limite = Date.now() - JOURS_VIE * 864e5;
    const tous = f.panneaux.flatMap((p) => p.episodes.flatMap((e) => e.liens.map((u) => ({ e, u }))));
    // Deja controle recemment : on reprend l'etat connu, sans requete.
    const aControler = [];
    for (const x of tous) {
      const c = connus.get(x.u);
      if (c && c.vu > limite && !String(c.etat).startsWith("inconnu")) {
        (x.e.etats ||= {})[x.u] = c.etat;
        (x.e.vus ||= {})[x.u] = c.vu;
      } else aControler.push(x);
    }
    const etats = await parLots(aControler, ({ u }) => vie(u));
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

const fiches = await parLots(slugs, (s) => copierFiche(s, domaines, cat.get(s), connus.liens));
const bilan = { fiches: fiches.length, sansAnilist: 0, panneaux: 0, episodes: 0, avecVidmoly: 0, liens: 0, vivants: 0, morts: 0, inconnus: 0 };
for (const f of fiches) {
  if (f.erreur) { console.log(`  ${f.slug} : ${f.erreur}`); continue; }
  if (!f.anilist) bilan.sansAnilist++;
  for (const p of f.panneaux || []) {
    bilan.panneaux++;
    bilan.episodes += p.nbEp;
    for (const e of p.episodes) {
      if (e.liens.length) bilan.avecVidmoly++;
      for (const u of e.liens) {
        bilan.liens++;
        const s = e.etats?.[u];
        if (s === "vivant") bilan.vivants++; else if (s === "mort") bilan.morts++; else if (s) bilan.inconnus++;
      }
    }
  }
  const resume = (f.panneaux || []).map((p) => {
    const v = p.episodes.filter((e) => Object.values(e.etats || {}).includes("vivant")).length;
    return `${p.dossier}/${p.langue} ${v}/${p.nbEp}`;
  }).join(" · ");
  console.log(`  ${f.slug} (AniList ${f.anilist ?? "?"}) : ${resume || "aucun panneau"}`);
}
const duree = Math.round((Date.now() - t0) / 1000);
console.log(`\nbilan ${JSON.stringify(bilan)}`);
console.log(`requetes Worker : ${compteur.requetes} (erreurs ${compteur.erreurs}) en ${duree} s`);
if (args.json) fs.writeFileSync(args.json, JSON.stringify({ le: new Date().toISOString(), domaines, fiches }, null, 1));
/* Contrat, suite : des fiches lues mais aucune saison ni aucun id AniList,
   c'est leur format de fiche qui a change. */
const lisibles = fiches.filter((f) => !f.erreur);
if (lisibles.length >= 20 && lisibles.filter((f) => f.anilist).length < lisibles.length / 2) {
  console.error("CONTRAT ROMPU : moins de la moitie des fiches portent un id AniList — rien n'est ecrit");
  process.exit(3);
}
if (db) console.log(`as_panneau : ${await ecrire(fiches, connus.empreintes)} ligne(s) ecrite(s)`);
