#!/usr/bin/env node
/**
 * Remplit anizone_ep / anizone_sub (base cache) depuis une IP qu'anizone
 * ACCEPTE — la connexion de Luc. Vercel et le Worker sont refuses (403) : sans
 * ce remplissage, le site ne peut servir aucun episode anizone. Pourquoi et
 * quoi : lib/anizone/core.mjs.
 *
 *   node tools/anizone/seed.mjs --ids 154587,182255   titres AniList precis
 *   node tools/anizone/seed.mjs --top 50              les 50 plus populaires
 *   node tools/anizone/seed.mjs --map                 tout anizone_map (suite)
 *   options : --force (relit les episodes deja ranges), --dry (n'ecrit rien),
 *             --max-ep 200 (borne par titre)
 *
 * Rythme : anizone limite a 60 requetes/min (x-ratelimit-limit) : une page
 * toutes les 1,2 s. Ecriture : 1 ligne par episode + 2 a 4 .ass (~30 Ko).
 * Lecture Turso : 1 ligne par episode deja vu (cle primaire).
 */

import { createClient } from "@libsql/client";
import { loadEnv } from "../turso/lib.mjs";
import { Bloque, capture, ecrisEpisode, lisEpisode, trouve } from "../../lib/anizone/core.mjs";

loadEnv();
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? null : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
};
const FORCE = !!opt("force");
const DRY = !!opt("dry");
const MAX_EP = Number(opt("max-ep")) || 200;
const PAUSE_MS = 1200;
const dort = (ms) => new Promise((r) => setTimeout(r, ms));

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

const MEDIA = `id idMal format episodes seasonYear startDate { year } synonyms
  title { romaji english native }`;

async function anilist(query, variables) {
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`AniList ${r.status}`);
  return (await r.json()).data;
}

/** Les titres a traiter : [{ aniId, media?, slug? }]. */
async function cibles() {
  const ids = opt("ids");
  if (typeof ids === "string") {
    const list = ids.split(",").map(Number).filter((n) => n > 0);
    const d = await anilist(
      `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){${MEDIA}}}}`,
      { ids: list },
    );
    return d.Page.media.map((m) => ({ aniId: m.id, media: m }));
  }
  const top = Number(opt("top"));
  if (top > 0) {
    const out = [];
    for (let page = 1; out.length < top; page++) {
      const d = await anilist(
        `query($p:Int){Page(page:$p,perPage:50){media(type:ANIME,sort:POPULARITY_DESC,isAdult:false){${MEDIA}}}}`,
        { p: page },
      );
      out.push(...d.Page.media.map((m) => ({ aniId: m.id, media: m })));
      if (d.Page.media.length < 50) break;
      await dort(2500);
    }
    return out.slice(0, top);
  }
  if (opt("map")) {
    const r = await db.execute("SELECT ani_id, slug FROM anizone_map WHERE slug IS NOT NULL");
    return r.rows.map((x) => ({ aniId: Number(x.ani_id), slug: String(x.slug) }));
  }
  console.error("usage : --ids a,b | --top N | --map  [--force] [--dry] [--max-ep N]");
  process.exit(2);
}

async function slugDe(c) {
  if (c.slug) return c.slug;
  const r = await db.execute({ sql: "SELECT slug, expires_at FROM anizone_map WHERE ani_id = ?", args: [c.aniId] });
  const row = r.rows[0];
  if (row && Number(row.expires_at) > Date.now() / 1000) return row.slug ?? null;
  const t = await trouve(c.media);
  await dort(PAUSE_MS);
  if (!DRY) {
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO anizone_map (ani_id, slug, title, checked_at, expires_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(ani_id) DO UPDATE SET slug = excluded.slug, title = excluded.title,
              checked_at = excluded.checked_at, expires_at = excluded.expires_at`,
      args: [c.aniId, t?.slug ?? null, t?.title ?? null, now, now + (t ? 60 : 7) * 86400],
    });
  }
  return t?.slug ?? null;
}

let ranges = 0;
let deja = 0;
for (const c of await cibles()) {
  const nom = c.media?.title?.romaji || c.aniId;
  let slug;
  try {
    slug = await slugDe(c);
  } catch (e) {
    console.log(`✗ ${nom} : ${e.message}`);
    if (e instanceof Bloque) process.exit(1);
    continue;
  }
  if (!slug) {
    console.log(`· ${nom} : pas sur anizone`);
    continue;
  }
  let n = 0;
  for (let ep = 1; ep <= MAX_EP; ep++) {
    if (!FORCE && (await lisEpisode(db, slug, ep))) {
      deja++;
      continue;
    }
    let cap;
    try {
      cap = await capture(slug, ep);
    } catch (e) {
      console.log(`  ✗ ${slug}/${ep} : ${e.message}`);
      if (e instanceof Bloque) process.exit(1);
      await dort(5000);
      continue;
    }
    await dort(PAUSE_MS);
    if (cap.absent) break; // fin de la serie
    if (!DRY) await ecrisEpisode(db, slug, ep, cap);
    n++;
    ranges++;
  }
  console.log(`✓ ${nom} (${slug}) : ${n} episode(s) range(s)`);
}
console.log(`\n${ranges} episode(s) range(s), ${deja} deja presents${DRY ? " (--dry : rien ecrit)" : ""}`);
