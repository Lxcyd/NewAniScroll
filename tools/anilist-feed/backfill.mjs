/**
 * L'IMPORT DU FIL D'ACTIVITÉ ANILIST, HORS DU SITE (25/11/2026, Luc).
 *
 *   node tools/anilist-feed/backfill.mjs [--user=<pseudo>] [--dry] [--fixture=<json>] [--gap=2500]
 *
 * Le fil (les dates : heatmap, calendrier, objectif, bingo, binge, séries) n'est
 * importé que par le NAVIGATEUR du membre, quand il se connecte
 * (lib/anilist/feedImport.ts). Un compte lié qui ne revient pas n'en a donc
 * jamais : Kuraryn, inscrit le 03/10, avant l'import (03/11) — beaucoup
 * d'animés sur AniList, heatmap vide.
 *
 * Ce script fait la même lecture depuis une machine (pas Vercel : le serveur ne
 * doit pas lire le fil de tout le monde, cf. feedImport.ts) pour les comptes
 * liés dont le fil manque ou n'est pas lu jusqu'au bout, et l'écrit par la même
 * fusion que la route (lib/anilist/feedMerge.ts). Ensuite, un membre qui se
 * connecte reprend l'import habituel au-dessus du `last` posé ici.
 *
 * Coût : Turso, une ligne lue et quelques écritures par compte. AniList, une
 * page de 50 activités toutes les 2,5 s (~24/min, sous la limite de 30), et
 * jamais d'alias (facturés, cf. la mémoire anilist-limite-alias).
 *
 * --fixture : un fichier { "<anilistId>": [activités…] } remplace AniList
 * (compte de test au faux nom AniList, qui n'existe pas là-bas).
 * Un profil AniList privé ne montre rien sans le jeton de son propriétaire :
 * signalé, et laissé à sa prochaine connexion.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "../turso/lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  }),
);
const DRY = !!args.dry;
const GAP = Number(args.gap) || 2500;
const MAX_PAGES = 400;
const SAVE_EVERY = 10;
const FEED_MAX_EVENTS = 40_000; // = lib/auth/userData.ts

/* La fusion de la route, transpilée comme tools/badges/check-catalog.mjs le
   fait pour les badges : un seul code pour le site et pour ce script. */
const ts = (await import(pathToFileURL(join(ROOT, "node_modules", "typescript", "lib", "typescript.js")).href)).default;
const CACHE = join(ROOT, "node_modules", ".cache", "anilist-feed");
mkdirSync(CACHE, { recursive: true });
for (const f of ["feedFins", "feedMerge"]) {
  const src = readFileSync(join(ROOT, "lib", "anilist", `${f}.ts`), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from\s*(["'])\.\/(\w+)\1/g, "from $1./$2.mjs$1");
  writeFileSync(join(CACHE, `${f}.mjs`), js);
}
const { mergeFeed, validEvent } = await import(pathToFileURL(join(CACHE, "feedMerge.mjs")).href);

loadEnv();
const { createClient } = createRequire(join(ROOT, "package.json"))("@libsql/client");
const db = createClient({ url: process.env.TURSO_USERS_URL, authToken: process.env.TURSO_USERS_TOKEN });

const fixture = args.fixture ? JSON.parse(readFileSync(String(args.fixture), "utf8")) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUERY = `query($id:Int,$p:Int,$before:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage}
activities(userId:$id,type:ANIME_LIST,sort:ID_DESC,createdAt_lesser:$before){... on ListActivity{id createdAt status progress media{id}}}}}`;
const tomorrow = () => Math.floor(Date.now() / 1000) + 86_400;

/** Une page du fil, de la plus récente à la plus ancienne, sous `before`. */
async function page(id, p, before) {
  if (fixture) {
    const all = (fixture[String(id)] ?? [])
      .filter((a) => a.createdAt < before)
      .sort((a, b) => b.id - a.id);
    return { activities: all.slice((p - 1) * 50, p * 50), pageInfo: { hasNextPage: all.length > p * 50 } };
  }
  for (let tries = 0; tries < 6; tries++) {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { id, p, before } }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!r) {
      await sleep(5000);
      continue;
    }
    if (r.status === 429) {
      const wait = (Number(r.headers.get("retry-after")) || 60) * 1000;
      console.log(`  429, pause ${wait / 1000} s`);
      await sleep(wait);
      continue;
    }
    if (!r.ok) {
      console.log(`  AniList HTTP ${r.status}`);
      return null;
    }
    const j = await r.json().catch(() => null);
    return j?.data?.Page ?? null;
  }
  return null;
}

/** « 4 » ou « 1 - 3 » → les épisodes (même règle que feedImport.ts). */
function episodes(progress) {
  const m = String(progress ?? "").split("-").map((s) => Number(s.trim()));
  if (m.length === 1 && Number.isInteger(m[0]) && m[0] > 0) return [m[0]];
  if (m.length === 2 && Number.isInteger(m[0]) && Number.isInteger(m[1]) && m[0] > 0 && m[1] >= m[0] && m[1] - m[0] < 500) {
    return Array.from({ length: m[1] - m[0] + 1 }, (_, i) => m[0] + i);
  }
  return [];
}
const isFin = (a) => /^completed/i.test(String(a?.status ?? "")) && !!a?.media?.id;

async function write(userId, feed) {
  if (DRY) return;
  await db.execute({
    sql: `INSERT INTO user_data (user_id, kind, payload, rev, updated_at)
          VALUES (?, 'anilist_feed', ?, 1, ?)
          ON CONFLICT(user_id, kind) DO UPDATE
            SET payload = excluded.payload, rev = user_data.rev + 1, updated_at = excluded.updated_at
          WHERE user_data.payload IS NOT excluded.payload`,
    args: [userId, JSON.stringify(feed), Date.now()],
  });
}

const rows = (
  await db.execute({
    sql: `SELECT u.id, u.username, u.anilist_id, u.anilist_name, d.payload
            FROM users u LEFT JOIN user_data d ON d.user_id = u.id AND d.kind = 'anilist_feed'
           WHERE u.anilist_id IS NOT NULL ${args.user ? "AND lower(u.username) = ?" : ""}`,
    args: args.user ? [String(args.user).toLowerCase()] : [],
  })
).rows;
if (!rows.length) console.log(args.user ? "compte introuvable ou non lié à AniList" : "aucun compte lié");

for (const r of rows) {
  let feed = null;
  try {
    feed = r.payload ? JSON.parse(String(r.payload)) : null;
  } catch {}
  const id = Number(r.anilist_id);
  const label = `${r.username} (AniList ${r.anilist_name ?? "?"} #${id})`;
  if (feed?.done && feed?.cDone && !args.user) {
    console.log(`ok     ${label} : fil complet (${feed.e.length} épisodes)`);
    continue;
  }
  console.log(`import ${label} : ${feed ? `${feed.e.length} épisodes déjà rangés` : "aucun fil"}`);
  const now = Date.now();
  let pages = 0;
  let newEp = 0;
  let newC = 0;
  const take = (a, e, c) => {
    if (/episode/i.test(String(a.status)) && a.media?.id) for (const ep of episodes(a.progress)) e.push([a.createdAt, a.media.id, ep]);
    if (isFin(a)) c[a.media.id] = Math.min(c[a.media.id] ?? Infinity, a.createdAt);
  };
  const save = async (patch) => {
    patch.e = patch.e.filter((x) => validEvent(x, now));
    newEp += patch.e.length;
    newC += Object.keys(patch.c ?? {}).length;
    feed = mergeFeed(feed, patch, now, FEED_MAX_EVENTS);
    await write(r.id, feed);
  };

  /* 1. Les lignes plus récentes que la dernière rangée. */
  if (feed?.last > 0) {
    const e = [];
    const c = {};
    let top = feed.last;
    for (let p = 1; p <= MAX_PAGES; p++) {
      const d = await page(id, p, tomorrow());
      pages++;
      if (!d) break;
      let reached = false;
      for (const a of d.activities ?? []) {
        if (!a?.id) continue;
        if (a.id <= feed.last) {
          reached = true;
          break;
        }
        top = Math.max(top, a.id);
        take(a, e, c);
      }
      if (reached || !d.pageInfo?.hasNextPage) break;
      if (!fixture) await sleep(GAP);
    }
    if (top > feed.last) await save({ e, c, last: top });
  }

  /* 2. Le passé, épisodes ET lignes « completed » en une passe, sous la plus
     haute des deux reprises (les doublons s'éliminent à la fusion). */
  if (!feed?.done || !feed?.cDone) {
    const before = Math.max(
      feed?.done ? 0 : Number(feed?.oldest) || tomorrow(),
      feed?.cDone ? 0 : Number(feed?.cOldest) || tomorrow(),
    );
    let e = [];
    let c = {};
    let top = feed?.last ?? 0;
    let low = before;
    let seen = 0;
    for (let p = 1; p <= MAX_PAGES; p++) {
      const d = await page(id, p, before);
      pages++;
      if (!d) {
        console.log("  AniList n'a pas répondu : reprise au prochain passage");
        break;
      }
      for (const a of d.activities ?? []) {
        if (!a?.id) continue;
        seen++;
        top = Math.max(top, a.id);
        low = Math.min(low, a.createdAt);
        take(a, e, c);
      }
      const end = !d.pageInfo?.hasNextPage;
      if (end || p % SAVE_EVERY === 0) {
        await save({ e, c, last: top, oldest: low, cOldest: low, done: end, cDone: end });
        e = [];
        c = {};
      }
      if (end) break;
      if (!fixture) await sleep(GAP);
    }
    if (p1Empty(seen, feed)) console.log("  rien de lisible : profil AniList privé ou fil vide");
  }
  const span = feed?.e?.length
    ? `${new Date(feed.e[feed.e.length - 1][0] * 1000).toISOString().slice(0, 10)} → ${new Date(feed.e[0][0] * 1000).toISOString().slice(0, 10)}`
    : "-";
  console.log(
    `  ${pages} page(s), +${newEp} épisodes, +${newC} fins ; fil : ${feed?.e?.length ?? 0} épisodes (${span}), done=${!!feed?.done} cDone=${!!feed?.cDone}${DRY ? " [DRY : rien écrit]" : ""}`,
  );
}

function p1Empty(seen, feed) {
  return seen === 0 && !(feed?.e?.length > 0);
}
