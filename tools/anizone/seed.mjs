#!/usr/bin/env node
/**
 * Remplit anizone_ep / anizone_sub (base cache) depuis une IP qu'anizone
 * ACCEPTE. Vercel et le Worker sont refuses (403) : sans ce remplissage, le
 * site ne peut servir aucun episode anizone. Pourquoi et quoi :
 * lib/anizone/core.mjs.
 *
 *   node tools/anizone/seed.mjs --auto --budget 45   ce que fait le cron horaire
 *   node tools/anizone/seed.mjs --ids 154587,182255  titres AniList precis
 *   node tools/anizone/seed.mjs --top 50             les 50 plus populaires
 *   node tools/anizone/seed.mjs --map                tous les titres connus
 *   node tools/anizone/seed.mjs --sonde              anizone joignable d'ici ?
 *   options : --force (relit les episodes deja ranges), --dry (n'ecrit rien),
 *             --budget N (minutes, arret propre avant)
 *
 * L'acces passe par tools/anizone/transport.mjs : direct avec des en-tetes de
 * Chrome, sinon un vrai Chrome (test anti-robot de Cloudflare).
 *
 * --auto, dans l'ordre, jusqu'a epuisement du budget :
 *   1. la file `anizone_demande` (episodes ouverts par un visiteur, absents) :
 *      le titre ENTIER est range, pas seulement l'episode ;
 *   2. les SUITES : l'episode d'apres le dernier range, pour les titres en
 *      cours (AniList) ou incomplets (serie coupee par un budget precedent) ;
 *   3. la DECOUVERTE : les animes AniList par popularite, jamais cherches sur
 *      anizone — tout leur catalogue finit par y passer.
 *
 * Rythme : une page toutes les 4 s (cf. PAUSE_MS), une minute de pause sur un
 * 429. Turso : l'etape 2 lit anizone_ep en entier (1 ligne par
 * episode range, ~10 000 a terme) ; le reste lit par cle primaire.
 */

import { createClient } from "@libsql/client";
import { loadEnv } from "../turso/lib.mjs";
import { Bloque, capture, ecrisEpisode, lisEpisode, reglages, tables, trouve } from "../../lib/anizone/core.mjs";
import { installe } from "./transport.mjs";

loadEnv();
reglages.ms = 20_000;
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? null : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
};
const FORCE = !!opt("force");
const DRY = !!opt("dry");
const MAX_EP = Number(opt("max-ep")) || 3000;
const FIN = Date.now() + (Number(opt("budget")) || 24 * 60) * 60_000;
/* 4 s entre deux pages (25/11/2026). A 1,2 s (~18 pages/min, toutes hors de
   leur cache, donc rendues par leur serveur PHP), anizone est tombe 20 min
   apres le debut du remplissage et ne s'en est pas remis d'une heure. Rien ne
   prouve que c'etait nous ; on ne prend pas le risque. */
const PAUSE_MS = 4000;
const dort = (ms) => new Promise((r) => setTimeout(r, ms));
const reste = () => Date.now() < FIN;

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// ── AniList ──────────────────────────────────────────────────────────────

const MEDIA = `id format status episodes seasonYear startDate { year } synonyms
  title { romaji english native }`;

async function anilist(query, variables) {
  for (let essai = 0; essai < 3; essai++) {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 429) {
      await dort(65_000);
      continue;
    }
    if (!r.ok) throw new Error(`AniList ${r.status}`);
    await dort(2500); // 30 points/min
    return (await r.json()).data;
  }
  throw new Error("AniList 429 persistant");
}

async function medias(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await anilist(
      `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){${MEDIA}}}}`,
      { ids: ids.slice(i, i + 50) },
    );
    out.push(...d.Page.media);
  }
  return out;
}

// ── Correspondance et episodes ───────────────────────────────────────────

async function ecrisMap(aniId, t) {
  if (DRY) return;
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO anizone_map (ani_id, slug, title, checked_at, expires_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(ani_id) DO UPDATE SET slug = excluded.slug, title = excluded.title,
            checked_at = excluded.checked_at, expires_at = excluded.expires_at`,
    args: [aniId, t?.slug ?? null, t?.title ?? null, now, now + (t ? 60 : 7) * 86400],
  });
}

async function slugDe(media) {
  const r = await db.execute({
    sql: "SELECT slug, expires_at FROM anizone_map WHERE ani_id = ?",
    args: [media.id],
  });
  const row = r.rows[0];
  if (row && Number(row.expires_at) > Date.now() / 1000) return row.slug ?? null;
  const t = await trouve(media);
  await dort(PAUSE_MS);
  await ecrisMap(media.id, t);
  return t?.slug ?? null;
}

let ranges = 0;

/* COUPE-CIRCUIT (25/11/2026). anizone est parfois instable — 502 et pages qui
   ne repondent plus, y compris depuis une connexion domestique, pendant que
   d'autres pages repondent en 0,3 s. Sans ce garde, un passage enchainait les
   delais depasses sur tout le catalogue pendant 45 min pour rien. Six echecs
   d'affilee arretent le passage, proprement : l'heure suivante reprend. */
class Arret extends Error {}
let echecs = 0;
const ECHECS_MAX = 6;
const succes = () => {
  echecs = 0;
};
const echec = async (e) => {
  if (++echecs >= ECHECS_MAX) throw new Arret(`${ECHECS_MAX} echecs d'affilee : anizone instable`);
  // 429 : leur limiteur parle, on lui laisse une minute.
  if (/429/.test(e?.message || "")) await dort(60_000);
};

/** Range les episodes `depuis`.. jusqu'au premier absent (ou au budget). */
async function serie(slug, depuis = 1) {
  let n = 0;
  for (let ep = depuis; ep <= MAX_EP && reste(); ep++) {
    if (!FORCE && (await lisEpisode(db, slug, ep))) continue;
    /* UN ECHEC ARRETE LA SERIE, il ne la saute pas : un trou ne serait jamais
       comble, les suites reprenant apres le dernier episode range. Le passage
       suivant reprend d'ici. Une seconde chance d'abord (anizone met parfois
       10 s a repondre). */
    let cap;
    for (let essai = 0; !cap; essai++) {
      try {
        cap = await capture(slug, ep);
        succes();
      } catch (e) {
        if (e instanceof Bloque) throw e;
        console.log(`  ✗ ${slug}/${ep} : ${e.message}`);
        await echec(e);
        if (essai) return { n, complet: false };
        await dort(10_000);
      }
    }
    await dort(PAUSE_MS);
    if (cap.absent) return { n, complet: true }; // fin de la serie (ou episode pas encore sorti)
    if (!DRY) await ecrisEpisode(db, slug, ep, cap);
    n++;
    ranges++;
  }
  return { n, complet: false }; // budget ou borne atteints
}

async function titre(media) {
  const nom = media.title?.romaji || media.id;
  let slug;
  try {
    slug = await slugDe(media);
    succes();
  } catch (e) {
    // Une recherche ratee ne coute que ce titre ; il reste a chercher.
    if (e instanceof Bloque) throw e;
    console.log(`✗ ${nom} : ${e.message}`);
    await echec(e);
    return false;
  }
  if (!slug) {
    console.log(`· ${nom} : pas sur anizone`);
    return true;
  }
  const { n, complet } = await serie(slug);
  console.log(`${complet ? "✓" : "…"} ${nom} (${slug}) : ${n} episode(s) range(s)${complet ? "" : ", incomplet"}`);
  return complet;
}

// ── Les modes ────────────────────────────────────────────────────────────

async function file() {
  const r = await db.execute("SELECT DISTINCT ani_id FROM anizone_demande LIMIT 100");
  const ids = r.rows.map((x) => Number(x.ani_id));
  if (!ids.length) return;
  console.log(`\n— file : ${ids.length} titre(s) demande(s)`);
  const trouves = await medias(ids);
  for (const m of trouves) {
    if (!reste()) return;
    /* La demande ne quitte la file que si le titre est alle AU BOUT (ou
       n'est pas sur anizone) : un passage coupe par une panne d'anizone la
       supprimait, et les episodes restants n'etaient plus jamais demandes. */
    const fini = await titre(m);
    if (fini && !DRY) await db.execute({ sql: "DELETE FROM anizone_demande WHERE ani_id = ?", args: [m.id] });
  }
  // Ids inconnus d'AniList : rien a en faire.
  const inconnus = ids.filter((id) => !trouves.some((m) => m.id === id));
  if (inconnus.length && !DRY)
    await db.execute({
      sql: `DELETE FROM anizone_demande WHERE ani_id IN (${inconnus.map(() => "?").join(",")})`,
      args: inconnus,
    });
}

/* Pas TOUS les titres ranges : a terme ~2 000, soit 40 min de requetes par
   passage pour des series finies. Seulement ceux qu'AniList dit en cours, et
   ceux dont il manque des episodes (serie coupee par un budget precedent). */
async function suites() {
  const r = await db.execute(
    `SELECT m.ani_id, m.slug, MAX(e.ep) dernier FROM anizone_map m
       JOIN anizone_ep e ON e.slug = m.slug GROUP BY m.ani_id`,
  );
  const parId = new Map(r.rows.map((x) => [Number(x.ani_id), x]));
  const vus = new Set();
  const aSuivre = (await medias([...parId.keys()])).filter((m) => {
    const x = parId.get(m.id);
    if (vus.has(x.slug)) return false; // deux fiches AniList, un slug
    vus.add(x.slug);
    return (
      m.status === "RELEASING" || m.status === "NOT_YET_RELEASED" || (m.episodes && Number(x.dernier) < m.episodes)
    );
  });
  console.log(`\n— suites : ${aSuivre.length} titre(s) en cours ou incomplets sur ${parId.size}`);
  for (const m of aSuivre) {
    if (!reste()) return;
    const x = parId.get(m.id);
    const { n } = await serie(String(x.slug), Number(x.dernier) + 1);
    if (n) console.log(`✓ ${m.title?.romaji} : ${n} nouvel(s) episode(s)`);
  }
}

async function decouverte(max = Infinity) {
  const r = await db.execute("SELECT ani_id, expires_at FROM anizone_map");
  const now = Date.now() / 1000;
  const connus = new Set(r.rows.filter((x) => Number(x.expires_at) > now).map((x) => Number(x.ani_id)));
  console.log(`\n— decouverte (${connus.size} titres deja cherches)`);
  let faits = 0;
  for (let page = 1; reste() && faits < max; page++) {
    const d = await anilist(
      `query($p:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage} media(type:ANIME,sort:POPULARITY_DESC,isAdult:false){${MEDIA}}}}`,
      { p: page },
    );
    for (const m of d.Page.media) {
      if (!reste() || faits >= max) return;
      if (connus.has(m.id)) continue;
      await titre(m);
      faits++;
    }
    if (!d.Page.pageInfo.hasNextPage) return;
  }
}

async function principal() {
  const ids = opt("ids");
  if (typeof ids === "string") {
    for (const m of await medias(ids.split(",").map(Number).filter((n) => n > 0))) await titre(m);
  } else if (Number(opt("top")) > 0) {
    await decouverte(Number(opt("top")));
  } else if (opt("map")) {
    const r = await db.execute("SELECT DISTINCT slug FROM anizone_map WHERE slug IS NOT NULL");
    for (const x of r.rows) {
      if (!reste()) break;
      const { n } = await serie(String(x.slug));
      console.log(`✓ ${x.slug} : ${n} episode(s) range(s)`);
    }
  } else if (opt("auto")) {
    await file();
    if (reste()) await suites();
    if (reste()) await decouverte();
  } else {
    console.error("usage : --auto | --ids a,b | --top N | --map  [--budget min] [--force] [--dry]");
    process.exit(2);
  }
}

console.log("— acces a anizone");
const acces = await installe();
if (!acces) {
  console.error("\n⛔ anizone refuse cette machine par tous les moyens essayes (voir ci-dessus).");
  process.exit(1);
}
console.log(`  → mode ${acces.mode}`);
if (opt("sonde")) {
  await acces.fermer();
  process.exit(0);
}

try {
  await tables(db);
  await principal();
} catch (e) {
  if (e instanceof Bloque) {
    console.error(`\n⛔ ${e.message} en cours de passage (mode ${acces.mode}).`);
    await acces.fermer();
    process.exit(1);
  }
  if (e instanceof Arret) {
    console.log(`\n⏸ ${e.message} — arret du passage, reprise a l'heure suivante.`);
  } else throw e;
} finally {
  await acces.fermer().catch(() => {});
}
console.log(`\n${ranges} episode(s) range(s)${DRY ? " (--dry : rien ecrit)" : ""}${reste() ? "" : " — budget epuise"}`);
