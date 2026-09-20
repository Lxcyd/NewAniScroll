#!/usr/bin/env node
/**
 * Recopie le catalogue anime de frembed dans la table `frembed_catalog`.
 *
 * Frembed publie sa liste (`/api/public/v1/anime`, 20 par page) avec, pour
 * chaque titre, son id TMDB — la cle meme sur laquelle notre resolveur
 * l'interroge. On la traduit en fiches AniList via `fribb_map`, et la table
 * repond ensuite a une seule question : « frembed peut-il avoir cet anime ? ».
 *
 * Pourquoi ca valait le detour. Au 20/09/2026 frembed a **146 entrees**
 * (104 series, 42 films) = **340 fiches AniList**. Le site essayait frembed sur
 * tout le catalogue : pour l'immense majorite des animes on payait une lecture
 * Fribb, un appel a l'API frembed et une sonde du CDN — 1,66 s mesurees — pour
 * apprendre « absent », et le chip s'allumait avant de s'eteindre. La liste
 * rend cette reponse gratuite et instantanee.
 *
 * Idempotent, sans etat entre deux executions — fait pour GitHub Actions.
 *
 * Usage :
 *   node scripts/frembed/sync-catalog.mjs
 *   node scripts/frembed/sync-catalog.mjs --dry     # n'ecrit rien
 *   node scripts/frembed/sync-catalog.mjs --force   # passe outre le garde-fou
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");
/** En deca de cette part de l'effectif precedent, on refuse d'ecrire. */
const CHUTE_MAX = 0.4;
const BASE = process.env.FREMBED_BASE || "https://frembed.surf";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function page(n) {
  /* Le domaine de frembed demenage (casa -> surf le 19/09). On SUIT la
     redirection et on repart de l'origine d'arrivee, comme le fait la route
     /api/v2/source : un demenagement ne doit pas faire echouer la synchro. */
  const res = await fetch(`${BASE}/api/public/v1/anime?page=${n}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`frembed /anime?page=${n} → HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.result;
  if (!r || !Array.isArray(r.items)) throw new Error(`page ${n} : reponse inattendue`);
  return r;
}

const items = [];
const premiere = await page(1);
items.push(...premiere.items);
const total = Number(premiere.totalPages) || 1;
for (let n = 2; n <= total; n++) {
  items.push(...(await page(n)).items);
}

const parType = items.reduce((a, i) => ((a[i.type] = (a[i.type] || 0) + 1), a), {});
console.log(
  `[frembed] ${items.length} entrees sur ${total} pages (${JSON.stringify(parType)})`,
);
/* Un catalogue vide ou ridiculement petit est un SYMPTOME (site en panne, API
   changee), pas une nouvelle : on refuse d'ecraser la table avec ca. Elle
   continuerait de servir l'ancienne liste, ce qui est exactement ce qu'on veut
   en attendant que quelqu'un regarde. */
if (items.length < 20) {
  console.error(`[frembed] trop peu d'entrees (${items.length}) — on n'ecrase rien`);
  process.exit(1);
}

const tv = [...new Set(items.filter((i) => i.type !== "movie").map((i) => Number(i.tmdb)))]
  .filter(Boolean);
const films = [...new Set(items.filter((i) => i.type === "movie").map((i) => Number(i.tmdb)))]
  .filter(Boolean);

/** Les fiches AniList portant l'un de ces ids TMDB (par paquets : SQLite borne
 *  le nombre de parametres d'une requete). */
async function anilistPour(colonne, ids) {
  const out = [];
  const PAQUET = 200;
  for (let i = 0; i < ids.length; i += PAQUET) {
    const lot = ids.slice(i, i + PAQUET);
    const r = await db.execute({
      sql: `SELECT anilist_id, ${colonne} AS tmdb FROM fribb_map
            WHERE ${colonne} IN (${lot.map(() => "?").join(",")})`,
      args: lot,
    });
    out.push(...r.rows);
  }
  return out;
}

const rows = new Map(); // anilistId -> {tmdbId, kind}
for (const r of await anilistPour("tmdb_tv_id", tv)) {
  rows.set(Number(r.anilist_id), { tmdbId: Number(r.tmdb), kind: "tv" });
}
for (const r of await anilistPour("tmdb_movie_id", films)) {
  // Un film n'ecrase pas une entree serie deja posee : les deux sont valables,
  // et la serie couvre plus d'episodes.
  if (!rows.has(Number(r.anilist_id))) {
    rows.set(Number(r.anilist_id), { tmdbId: Number(r.tmdb), kind: "movie" });
  }
}

console.log(
  `[frembed] ${tv.length} series + ${films.length} films → ${rows.size} fiches AniList`,
);
if (rows.size === 0) {
  console.error("[frembed] aucune correspondance Fribb — on n'ecrase rien");
  process.exit(1);
}

await db.execute(`
CREATE TABLE IF NOT EXISTS frembed_catalog (
  anilist_id  INTEGER PRIMARY KEY,
  tmdb_id     INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);`);

/* Le plancher a 20 entrees ci-dessus ne voit qu'une panne FRANCHE. Il laisse
   passer le cas qui fait vraiment mal : une liste qui repond, bien formee, mais
   amputee — une pagination qui s'arrete tot, un `type` renomme, une moitie de
   catalogue derriere un nouveau parametre. 340 fiches qui tombent a 120 passent
   le plancher et purgent 220 animes de frembed pour la journee, sans un mot.
   D'ou une seconde mesure, RELATIVE a ce qui est deja en base : en dessous de
   CHUTE_MAX de l'effectif precedent, on garde la liste d'hier et on sort en
   erreur pour que GitHub previenne. Une vraie coupe franche chez frembed se
   debloque a la main (`--force`) ; c'est le bon niveau de friction pour un
   evenement qui arrive une fois par an. */
const avant = Number(
  (await db.execute("SELECT COUNT(*) AS n FROM frembed_catalog")).rows[0]?.n ?? 0,
);
const seuil = Math.floor(avant * CHUTE_MAX);
if (avant > 0) {
  const delta = rows.size - avant;
  console.log(
    `[frembed] effectif precedent : ${avant} (${delta >= 0 ? "+" : ""}${delta})`,
  );
}
if (avant > 0 && rows.size < seuil && !FORCE) {
  console.error(
    `[frembed] chute suspecte : ${rows.size} fiches contre ${avant} en base ` +
      `(seuil ${seuil}) — on n'ecrase rien. Relancer avec --force si la coupe ` +
      `est reelle.`,
  );
  process.exit(1);
}

if (DRY) {
  console.log("[frembed] --dry : rien n'est ecrit");
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
const tx = await db.transaction("write");
try {
  // Remplacement, pas fusion : un titre retire de frembed doit disparaitre.
  await tx.execute("DELETE FROM frembed_catalog");
  for (const [anilistId, { tmdbId, kind }] of rows) {
    await tx.execute({
      sql: `INSERT OR REPLACE INTO frembed_catalog (anilist_id, tmdb_id, kind, updated_at)
            VALUES (?, ?, ?, ?)`,
      args: [anilistId, tmdbId, kind, now],
    });
  }
  await tx.commit();
} catch (e) {
  await tx.rollback().catch(() => {});
  throw e;
}

console.log(`[frembed] table remplacee : ${rows.size} lignes`);
