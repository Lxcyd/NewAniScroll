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

/* ── Ce que la liste publique OUBLIE ───────────────────────────────────────────
   Mesure du 28/09/2026 : la liste ne dit pas tout. Railgun S (tmdb 30977) ou
   Hajime no Ippo (42705) n'y figurent pas — `/api/public/v1/tv/<id>` repond
   meme « 0 episode » — et pourtant l'API du lecteur rend leur master.m3u8. Sur
   40 animes verifies tires hors liste, 13 etaient heberges : ~1/3, soit de
   l'ordre de 500 fiches AniList que le site cachait a frembed.
   On interroge donc l'API du LECTEUR (la meme que la route /api/v2/source) pour
   chaque id TMDB de Fribb : S1E1 pour une serie, le film sinon. Heberge = une
   vraie source m3u8 ; 404 = inconnu de frembed ; tout le reste (5xx, reseau)
   ne tranche rien et laisse l'etat precedent en place.
   Par lots (PROBE_MAX par nuit) : une premiere passe complete prend quelques
   nuits, ensuite on ne revoit que ce qui a vieilli — un heberge chaque semaine
   (il peut disparaitre), un absent chaque mois (il peut arriver). */
const PROBE_MAX = Number(
  process.argv.find((a) => a.startsWith("--probe-max="))?.split("=")[1] ?? 1500,
);
const PROBE_PAR = 3; // requetes simultanees : on reste un visiteur poli
const REVOIR_HEBERGE_S = 7 * 86400;
const REVOIR_ABSENT_S = 30 * 86400;

await db.execute(`
CREATE TABLE IF NOT EXISTS frembed_probe (
  tmdb_id     INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  hosted      INTEGER NOT NULL,
  checked_at  INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, kind)
);`);

async function sonde(tmdbId, kind) {
  const q =
    kind === "movie"
      ? `?tmdb=${tmdbId}&type=movie`
      : `?tmdb=${tmdbId}&type=serie&sa=1&ep=1`;
  try {
    const res = await fetch(`${BASE}/api/streaming/player${q}`, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: `${BASE}/streaming/player` },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return false;
    if (!res.ok) return null;
    const j = await res.json();
    const url = j?.sources?.[0]?.url;
    return typeof url === "string" && /\.m3u8/i.test(url);
  } catch {
    return null;
  }
}

{
  const now = Math.floor(Date.now() / 1000);
  const listes = new Set([...tv.map((t) => `tv:${t}`), ...films.map((t) => `movie:${t}`)]);
  const a = await db.execute({
    sql: `SELECT c.tmdb_id, c.kind FROM (
            SELECT DISTINCT tmdb_tv_id AS tmdb_id, 'tv' AS kind FROM fribb_map WHERE tmdb_tv_id IS NOT NULL
            UNION
            SELECT DISTINCT tmdb_movie_id, 'movie' FROM fribb_map WHERE tmdb_movie_id IS NOT NULL
          ) c
          LEFT JOIN frembed_probe p ON p.tmdb_id = c.tmdb_id AND p.kind = c.kind
          WHERE p.tmdb_id IS NULL
             OR (p.hosted = 1 AND p.checked_at < ?)
             OR (p.hosted = 0 AND p.checked_at < ?)
          ORDER BY COALESCE(p.checked_at, 0)`,
    args: [now - REVOIR_HEBERGE_S, now - REVOIR_ABSENT_S],
  });
  const aVoir = a.rows
    .map((r) => ({ tmdbId: Number(r.tmdb_id), kind: String(r.kind) }))
    .filter((c) => c.tmdbId && !listes.has(`${c.kind}:${c.tmdbId}`))
    .slice(0, DRY ? 0 : PROBE_MAX);

  /* Ceux qu'on savait heberges : c'est sur eux qu'une panne se voit. */
  const etaientHeberges = new Set(
    (await db.execute("SELECT tmdb_id, kind FROM frembed_probe WHERE hosted = 1")).rows.map(
      (r) => `${r.kind}:${r.tmdb_id}`,
    ),
  );
  let oui = 0, non = 0, flou = 0, revus = 0, perdus = 0;
  const resultats = [];
  for (let i = 0; i < aVoir.length; i += PROBE_PAR) {
    const lot = aVoir.slice(i, i + PROBE_PAR);
    const r = await Promise.all(lot.map((c) => sonde(c.tmdbId, c.kind)));
    lot.forEach((c, k) => {
      if (r[k] === null) return flou++;
      r[k] ? oui++ : non++;
      if (etaientHeberges.has(`${c.kind}:${c.tmdbId}`)) {
        revus++;
        if (!r[k]) perdus++;
      }
      resultats.push([c.tmdbId, c.kind, r[k] ? 1 : 0, now]);
    });
  }
  /* Meme logique que CHUTE_MAX pour la liste : frembed qui demenage vers une
     page 404, ou qui renomme `sources`, ferait passer TOUS les titres en
     « absent » en une nuit et effacerait la sonde. Des titres heberges qui
     disparaissent, il y en a — quelques-uns par semaine, pas la majorite. */
  if (revus >= 20 && perdus / revus > 0.5 && !FORCE) {
    console.error(
      `[frembed] sonde suspecte : ${perdus}/${revus} titres heberges seraient perdus — ` +
        `rien n'est ecrit. Relancer avec --force si c'est reel.`,
    );
    process.exit(1);
  }
  if (aVoir.length >= 50 && oui + non === 0) {
    console.error(`[frembed] sonde : aucune reponse exploitable sur ${aVoir.length} — frembed injoignable ?`);
    process.exit(1);
  }
  for (let i = 0; i < resultats.length; i += 100) {
    await db.batch(
      resultats.slice(i, i + 100).map((args) => ({
        sql: `INSERT OR REPLACE INTO frembed_probe (tmdb_id, kind, hosted, checked_at) VALUES (?, ?, ?, ?)`,
        args,
      })),
      "write",
    );
  }
  console.log(
    `[frembed] sonde : ${aVoir.length} ids (${a.rows.length} en attente) → ${oui} heberges, ${non} absents, ${flou} sans reponse`,
  );

  /* Rapport seulement : les heberges restent dans `frembed_probe`, que
     lib/db/frembedCatalog.ts reunit a la liste. `frembed_catalog` ne contient
     que la liste publique — la base est partagee entre dev et prod, et c'est le
     code du lecteur, pas cette table, qui decide qui voit les titres sondes. */
  const h = await db.execute(`
    SELECT f.anilist_id, p.tmdb_id, p.kind FROM frembed_probe p
    JOIN fribb_map f ON f.tmdb_tv_id = p.tmdb_id
    WHERE p.hosted = 1 AND p.kind = 'tv'
    UNION ALL
    SELECT f.anilist_id, p.tmdb_id, p.kind FROM frembed_probe p
    JOIN fribb_map f ON f.tmdb_movie_id = p.tmdb_id
    WHERE p.hosted = 1 AND p.kind = 'movie'`);
  const hors = new Set(h.rows.map((r) => Number(r.anilist_id)).filter((id) => !rows.has(id)));
  console.log(`[frembed] sonde : +${hors.size} fiches AniList hors liste (union ${rows.size + hors.size})`);
}
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
