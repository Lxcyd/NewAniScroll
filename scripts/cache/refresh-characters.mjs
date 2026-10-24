#!/usr/bin/env node
/**
 * LES PERSONNAGES DE TOUT LE CATALOGUE, dans Turso (24/10/2026, Luc).
 *
 * Même rôle que refresh-cache.mjs pour la fiche des animes : quand AniList est
 * en panne, le site continue de servir ce qu'on a gardé. La fiche (`anime.data`)
 * n'a que les 25 premiers personnages — AniList ne rend jamais plus de 25 par
 * page, et la requête Tier-1 n'en demande qu'une. Ici : TOUS, une ligne par
 * anime dans `anime_characters`, pour l'onglet Personnages de la page anime et
 * le menu Avatar du studio (compteurs de toute une liste en une requête).
 *
 * LA FILE, C'EST L'ÉTAT DE LA TABLE (comme le TTL de refresh-cache) : un anime
 * sans ligne, ou dont la ligne a expiré. Pas de curseur, donc une exécution
 * ratée ne coûte qu'un jour de fraîcheur, et un anime découvert par
 * refresh-cache entre dans la file tout seul.
 *
 * UN PERSONNAGE AJOUTÉ À UN ANIME DÉJÀ RELEVÉ : chaque relevé REMPLACE la liste
 * entière (ajouts, retraits, ordre). Il revient donc à l'échéance :
 *   RELEASING        → 1 jour  (les personnages arrivent avec les épisodes)
 *   NOT_YET_RELEASED → 3 jours
 *   FINISHED         → 14 jours (les éditeurs d'AniList complètent aussi les vieux)
 *   autres           → 7 jours
 * avec ±20 % de hasard, pour que le premier remplissage n'expire pas d'un bloc.
 *
 * LE COÛT CÔTÉ ANILIST (mesuré le 24/10/2026) : dans `Page(media(id_in))`, la
 * « complexité » ne dépend pas du nombre d'animes — 50 animes × 1 page = une
 * requête de ~1 s. Les animes qui ont une suite repartent ensuite par paquets,
 * 10 pages à la fois. Tout le catalogue ≈ 550 requêtes.
 *
 * Usage :
 *   node scripts/cache/refresh-characters.mjs
 *   node scripts/cache/refresh-characters.mjs --max-minutes=60 --max-rows=30000
 *   node scripts/cache/refresh-characters.mjs --ids=21,205909   (test)
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { createClient } from "@libsql/client";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : dflt;
};
const MAX_MINUTES = parseFloat(opt("max-minutes", "20"));
const MAX_ROWS = parseInt(opt("max-rows", "25000"), 10);
const ONLY_IDS = opt("ids", "")
  .split(",")
  .map(Number)
  .filter((n) => n > 0);

const PER_REQUEST = 50; /* id_in : le plafond de Page.perPage */
const FOLLOW_CHUNK = 25; /* les animes à suite : réponses plus lourdes */
const WINDOW = 10; /* pages par requête de suite (10 × ~10 de complexité) */
const MAX_PAGES = 60; /* 1 500 personnages — One Piece en a ~820 */
const REQUEST_DELAY_MS = 2100;

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("✘ TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  process.exit(1);
}
const db = createClient({ url, authToken });

const DAY = 86400;
function ttlForStatus(s) {
  switch (s) {
    case "RELEASING":        return 1 * DAY;
    case "NOT_YET_RELEASED": return 3 * DAY;
    case "FINISHED":         return 14 * DAY;
    default:                 return 7 * DAY;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Même politesse que refresh-cache : un 429 n'est pas un échec, un 5xx ou une
   coupure se réessaient deux fois. */
async function aniRequest(query, variables, attempt = 1) {
  const retry = async (why) => {
    if (attempt >= 3) throw new Error(`${why} (after ${attempt} attempts)`);
    console.warn(`  ↳ ${why} — retrying in ${attempt * 5}s`);
    await sleep(attempt * 5000);
    return aniRequest(query, variables, attempt + 1);
  };
  let res;
  try {
    res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    return retry(`AniList unreachable: ${e.message}`);
  }
  if (res.status === 429) {
    const wait = (Number(res.headers.get("retry-after")) || 30) * 1000;
    console.warn(`  ↳ 429, sleeping ${wait}ms`);
    await sleep(wait);
    return aniRequest(query, variables, attempt);
  }
  if (res.status >= 500) return retry(`AniList HTTP ${res.status}`);
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`AniList errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

const EDGES = "pageInfo { hasNextPage } edges { role node { id name { full } image { large medium } } }";
const pages = (first, n) =>
  Array.from({ length: n }, (_, i) => {
    const p = first + i;
    return `p${p}: characters(sort: [ROLE, FAVOURITES_DESC], perPage: 25, page: ${p}) { ${EDGES} }`;
  }).join(" ");
const query = (first, n) =>
  `query ($ids: [Int]) { Page(perPage: ${PER_REQUEST}) { media(id_in: $ids, type: ANIME) { id status ${pages(first, n)} } } }`;

/* LE FORMAT GARDÉ, compact : ~60 octets par personnage au lieu de ~250.
   { i: id, n: nom, r: "M"|"S"|"B" (rôle), f: fichier } — `f` quand les deux
   tailles d'AniList ont le même nom de fichier (le cas normal), sinon les deux
   URL entières `l` et `m`. Relu par lib/db/animeCharacters.ts. */
const CDN = "https://s4.anilist.co/file/anilistcdn/character/";
const ROLE = { MAIN: "M", SUPPORTING: "S", BACKGROUND: "B" };
function compact(e) {
  const n = e?.node;
  if (!n?.id) return null;
  const l = n.image?.large || "";
  const m = n.image?.medium || "";
  const out = { i: n.id, n: n.name?.full || "?", r: ROLE[e.role] || "S" };
  const fl = l.startsWith(CDN + "large/") ? l.slice(CDN.length + 6) : null;
  const fm = m.startsWith(CDN + "medium/") ? m.slice(CDN.length + 7) : null;
  if (fl && fl === fm) out.f = fl;
  else {
    if (l) out.l = l;
    if (m) out.m = m;
  }
  return out;
}
const isDefault = (c) => /(^|\/)default\.(jpg|png)$/.test(c.f || c.l || "");

/** Lit les pages `first`…`first+n-1` d'un media reçu : personnages, et s'il en reste. */
function readPages(m, first, n) {
  const list = [];
  let more = false;
  for (let i = 0; i < n; i++) {
    const c = m[`p${first + i}`];
    for (const e of c?.edges ?? []) {
      const x = compact(e);
      if (x) list.push(x);
    }
    more = !!c?.pageInfo?.hasNextPage;
    if (!more) break;
  }
  return { list, more };
}

async function ensureTable() {
  await db.execute(`CREATE TABLE IF NOT EXISTS anime_characters (
    ani_id      INTEGER PRIMARY KEY,
    total       INTEGER NOT NULL,
    with_image  INTEGER NOT NULL,
    complete    INTEGER NOT NULL,
    data        TEXT    NOT NULL,
    fetched_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_anime_characters_expires ON anime_characters(expires_at)`);
}

async function save(rows) {
  if (!rows.length) return;
  const now = Math.floor(Date.now() / 1000);
  await db.batch(
    rows.map(({ id, status, list, complete }) => {
      /* Doublons possibles d'une page à l'autre (tri instable d'AniList). */
      const seen = new Set();
      const clean = list.filter((c) => (seen.has(c.i) ? false : (seen.add(c.i), true)));
      const ttl = Math.round(ttlForStatus(status) * (0.8 + Math.random() * 0.4));
      return {
        sql: `INSERT INTO anime_characters (ani_id, total, with_image, complete, data, fetched_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(ani_id) DO UPDATE SET
                total = excluded.total, with_image = excluded.with_image, complete = excluded.complete,
                data = excluded.data, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
        args: [
          id,
          clean.length,
          clean.filter((c) => !isDefault(c)).length,
          complete ? 1 : 0,
          JSON.stringify(clean),
          now,
          now + ttl,
        ],
      };
    }),
    "write",
  );
}

/** Un paquet d'animes : la page 1 de tous, puis la suite de ceux qui en ont. */
async function harvest(ids) {
  const data = await aniRequest(query(1, 1), { ids });
  const got = new Map();
  for (const m of data?.Page?.media ?? []) {
    const r = readPages(m, 1, 1);
    got.set(m.id, { id: m.id, status: m.status, list: r.list, more: r.more, next: 2 });
  }
  let follow = [...got.values()].filter((x) => x.more);
  while (follow.length) {
    const first = follow[0].next;
    for (let i = 0; i < follow.length; i += FOLLOW_CHUNK) {
      const part = follow.slice(i, i + FOLLOW_CHUNK);
      await sleep(REQUEST_DELAY_MS);
      const d = await aniRequest(query(first, WINDOW), { ids: part.map((x) => x.id) });
      const byId = new Map((d?.Page?.media ?? []).map((m) => [m.id, m]));
      for (const x of part) {
        const m = byId.get(x.id);
        if (!m) {
          x.more = false; /* disparu entre deux requêtes : on garde le début */
          continue;
        }
        const r = readPages(m, first, WINDOW);
        x.list.push(...r.list);
        x.more = r.more;
        x.next = first + WINDOW;
      }
    }
    follow = follow.filter((x) => x.more && x.next <= MAX_PAGES);
  }
  const rows = [...got.values()].map((x) => ({ ...x, complete: !x.more }));
  await save(rows);
  return { rows, missing: ids.filter((id) => !got.has(id)) };
}

async function main() {
  const t0 = Date.now();
  await ensureTable();
  const now = Math.floor(Date.now() / 1000);

  let queue;
  if (ONLY_IDS.length) {
    queue = ONLY_IDS;
  } else {
    /* Les jamais relevés d'abord, puis les expirés ; les plus populaires en tête
       de chaque groupe — un relevé coupé par le temps a fait ceux qu'on regarde. */
    const r = await db.execute({
      sql: `SELECT a.id FROM anime a
              LEFT JOIN anime_characters c ON c.ani_id = a.id
             WHERE (a.type IS NULL OR a.type = 'ANIME')
               AND (c.ani_id IS NULL OR c.expires_at < ?)
             ORDER BY (c.ani_id IS NULL) DESC, a.popularity DESC NULLS LAST
             LIMIT ?`,
      args: [now, MAX_ROWS],
    });
    queue = r.rows.map((row) => Number(row.id));
  }
  console.log(`┌─ Personnages : ${queue.length} anime(s) à relever (budget ${MAX_MINUTES} min)`);

  const deadline = Date.now() + MAX_MINUTES * 60_000;
  let done = 0;
  let chars = 0;
  let missing = 0;
  let capped = 0;
  for (let i = 0; i < queue.length; i += PER_REQUEST) {
    if (Date.now() > deadline) {
      console.log(`│  ↳ ${MAX_MINUTES} min écoulées — la suite au prochain passage`);
      break;
    }
    const ids = queue.slice(i, i + PER_REQUEST);
    const r = await harvest(ids);
    done += r.rows.length;
    chars += r.rows.reduce((s, x) => s + x.list.length, 0);
    capped += r.rows.filter((x) => !x.complete).length;
    /* Inconnus d'AniList (supprimés, fusionnés, ou pas des animes) : garés
       7 jours avec une ligne vide marquée incomplète — l'API la lit comme
       « on ne sait pas », jamais comme « zéro personnage ». */
    if (r.missing.length && !ONLY_IDS.length) {
      missing += r.missing.length;
      await db.batch(
        r.missing.map((id) => ({
          sql: `INSERT INTO anime_characters (ani_id, total, with_image, complete, data, fetched_at, expires_at)
                VALUES (?, 0, 0, 0, '[]', ?, ?)
                ON CONFLICT(ani_id) DO UPDATE SET expires_at = excluded.expires_at`,
          args: [id, now, now + 7 * DAY],
        })),
        "write",
      );
    }
    const step = i / PER_REQUEST;
    if (step % 10 === 0 || i + PER_REQUEST >= queue.length) {
      const min = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`│  ↳ ${Math.min(i + PER_REQUEST, queue.length)}/${queue.length} — ${chars} personnages, ${min} min`);
    }
    if (i + PER_REQUEST < queue.length) await sleep(REQUEST_DELAY_MS);
  }

  const total = await db.execute("SELECT COUNT(*) AS n, SUM(total) AS c FROM anime_characters WHERE complete = 1 OR total > 0");
  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`└─ ${done} relevés (${chars} personnages), ${missing} inconnus garés, ${capped} plafonnés à ${MAX_PAGES} pages`);
  console.log(`   en ${Math.floor(dt / 60)}m${dt % 60}s — table : ${total.rows[0].n} animes, ${total.rows[0].c} personnages`);
}

main().catch((e) => {
  console.error("✘ refresh-characters crashed:", e);
  process.exit(1);
});
