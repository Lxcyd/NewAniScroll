#!/usr/bin/env node
/**
 * Recopie les DECORATIONS D'AVATAR de la boutique Discord dans `avatar_frames`.
 *
 * La source est itemshop.gg/discord, et pas l'API de Discord : celle-ci
 * (`/api/v10/collectibles-categories`) exige le jeton d'un compte connecte, et
 * l'automatiser enfreint les conditions de Discord. itemshop.gg republie la
 * boutique ENTIERE chaque jour (« refreshed daily and updates itself when the
 * catalogue changes ») : au 08/10/2026, 688 decorations rangees en 90
 * collections, anciennes comprises. Les images restent celles du CDN public de
 * Discord (`cdn.discordapp.com/avatar-decoration-presets/<asset>.png`), qui
 * repond sans authentification ; on ne stocke que l'identifiant.
 *
 * La page est une app Next.js : les donnees voyagent dans les morceaux
 * `self.__next_f.push([1,"..."])`. Chaque collection y est un objet
 * `{"title":"<collection>","cards":[...]}` et chaque carte
 * `{"id":"<sku>","name":"<nom>","subtitle":"Avatar Decoration",…,"image":"…/avatar-decoration-presets/<asset>.png…"}`.
 * L'ordre de la page est celui de la boutique, le plus recent en tete : il
 * devient `rank`, ce qui range les nouveautes en premier dans le studio.
 *
 * AJOUT SEUL, jamais de suppression : une collection retiree de la boutique
 * disparait d'itemshop, mais celui qui porte deja un de ses cadres doit le
 * garder, et le studio peut continuer de le proposer. `last_seen` dit depuis
 * quand elle n'est plus en vente.
 *
 * Garde-fou : moins de 300 decorations lues = la page a change de forme, on
 * n'ecrit rien et le job echoue (une ALERTE a lire, pas une panne a ignorer).
 *
 *   node scripts/discord-frames/sync-frames.mjs [--dry]
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const DRY = process.argv.includes("--dry");
const PLANCHER = 300;
const SOURCE = process.env.FRAMES_SOURCE || "https://itemshop.gg/discord";

const res = await fetch(SOURCE, {
  headers: {
    "User-Agent": "AniScroll-frames/1.0 (+https://aniscroll.com) une lecture par jour",
    Accept: "text/html",
  },
});
if (!res.ok) throw new Error(`${SOURCE} -> HTTP ${res.status}`);
const html = await res.text();

/* Les morceaux sont des litteraux de chaine JS : JSON.parse les decode
   (echappements \" \\ \uXXXX) sans eval. */
let flux = "";
for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
  try {
    flux += JSON.parse(`"${m[1]}"`);
  } catch {
    /* un morceau illisible ne contient pas de carte qu'on saurait lire */
  }
}

const sections = [...flux.matchAll(/"title":"([^"]{1,80})","cards":\[/g)].map((m) => ({
  title: m[1],
  start: m.index + m[0].length,
}));
const CARTE =
  /\{"id":"(\d+)","name":"((?:[^"\\]|\\.)*)","subtitle":"Avatar Decoration","bakedCard":[^,]*,"image":"https:\/\/cdn\.discordapp\.com\/avatar-decoration-presets\/((?:a_)?[0-9a-f]{32})\.png/g;

const frames = new Map();
let rank = 0;
sections.forEach((s, i) => {
  const fin = i + 1 < sections.length ? sections[i + 1].start : flux.length;
  const corps = flux.slice(s.start, fin);
  for (const m of corps.matchAll(CARTE)) {
    if (frames.has(m[3])) continue;
    let name = m[2];
    try {
      name = JSON.parse(`"${name}"`);
    } catch {}
    frames.set(m[3], { asset: m[3], sku: m[1], name, collection: s.title, rank: rank++ });
  }
});

const collections = new Set([...frames.values()].map((f) => f.collection));
console.log(`[frames] ${frames.size} decorations, ${collections.size} collections (${SOURCE})`);
if (frames.size < PLANCHER) {
  console.error(`[frames] moins de ${PLANCHER} decorations lues : la page a change de forme, rien n'est ecrit`);
  process.exit(1);
}
if (DRY) {
  console.log([...frames.values()].slice(0, 5));
  process.exit(0);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
await db.execute(`
CREATE TABLE IF NOT EXISTS avatar_frames (
  asset       TEXT    PRIMARY KEY,
  sku         TEXT,
  name        TEXT    NOT NULL,
  collection  TEXT    NOT NULL,
  rank        INTEGER NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);`);

const avant = Number((await db.execute("SELECT COUNT(*) AS n FROM avatar_frames")).rows[0]?.n ?? 0);
const now = Math.floor(Date.now() / 1000);
const liste = [...frames.values()];
const tx = await db.transaction("write");
try {
  for (let i = 0; i < liste.length; i += 200) {
    const lot = liste.slice(i, i + 200);
    await tx.execute({
      sql:
        `INSERT INTO avatar_frames (asset, sku, name, collection, rank, first_seen, last_seen) VALUES ` +
        lot.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ") +
        ` ON CONFLICT(asset) DO UPDATE SET sku = excluded.sku, name = excluded.name,
            collection = excluded.collection, rank = excluded.rank, last_seen = excluded.last_seen`,
      args: lot.flatMap((f) => [f.asset, f.sku, f.name, f.collection, f.rank, now, now]),
    });
  }
  await tx.commit();
} catch (e) {
  await tx.rollback().catch(() => {});
  throw e;
}
const apres = Number((await db.execute("SELECT COUNT(*) AS n FROM avatar_frames")).rows[0]?.n ?? 0);
console.log(`[frames] table : ${avant} -> ${apres} (${apres - avant} nouvelles)`);
