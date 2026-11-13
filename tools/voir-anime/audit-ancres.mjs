#!/usr/bin/env node
/**
 * AUDIT des ancres voir-anime : relit le bloc de metadonnees de chaque page,
 * la rattache par EMPREINTE (tools/voir-anime/empreinte.mjs) et compare a
 * l'ancre actuelle (titre + date, va_page.anilist).
 *
 *   node tools/voir-anime/audit-ancres.mjs [--limite=N] [--cache=F] [--rapport=F]
 *   node tools/voir-anime/audit-ancres.mjs --appliquer --cache=F   ecrit va_page
 *
 * N'ecrit rien sans --appliquer. Les pages lues sont gardees dans --cache (JSON)
 * pour qu'une relance ne relise pas voir-anime.
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";
import { lireMeta, ancrer, choisir } from "./empreinte.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "1"]; }));
const env = (n) => process.env[n] || fs.readFileSync(new URL("../../.env", import.meta.url), "utf8").split(/\r?\n/).find((l) => l.startsWith(`${n}=`))?.slice(n.length + 1).replace(/^"|"$/g, "");
const db = createClient({ url: env("TURSO_DATABASE_URL"), authToken: env("TURSO_AUTH_TOKEN") });
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const VA = "https://voiranime.cx";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CACHE = args.cache || "audit-ancres.json";

const pages = (await db.execute("SELECT slug, langue, anilist, ancre, type, nb_vivants FROM va_page ORDER BY slug")).rows
  .slice(0, Number(args.limite) || undefined);
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch {}

/* 1. Les pages (4 en parallele, polies). */
let lues = 0;
const file = pages.filter((p) => !cache[p.slug]?.meta);
async function ouvrier() {
  for (let p; (p = file.shift());) {
    for (let essai = 0; essai < 3; essai++) {
      const r = await fetch(`${VA}/anime/${encodeURI(p.slug)}/`, { headers: { "User-Agent": UA, Referer: `${VA}/` }, signal: AbortSignal.timeout(20000) }).catch(() => null);
      if (r?.status === 200) { const m = lireMeta(await r.text()); delete m.brut; cache[p.slug] = { meta: m }; break; }
      if (r?.status === 404) { cache[p.slug] = { meta: null, erreur: 404 }; break; }
      await dors(3000 * (essai + 1));
    }
    if (++lues % 200 === 0) { fs.writeFileSync(CACHE, JSON.stringify(cache)); process.stderr.write(`\rpages ${lues}/${pages.length}`); }
    await dors(150);
  }
}
await Promise.all([1, 2, 3, 4].map(ouvrier));
fs.writeFileSync(CACHE, JSON.stringify(cache));
process.stderr.write(`\rpages lues : ${lues} (cache ${Object.keys(cache).length})\n`);

/* 2. Le rattachement par empreinte. Les CANDIDATS AniList sont gardes : une
   regle changee se rejoue sur eux (--rejouer) sans nouvelle recherche. */
if (args.rejouer) {
  for (const p of pages) {
    const x = cache[p.slug];
    if (x?.meta && x.cands) x.choix = choisir({ slug: p.slug, ...x.meta }, x.cands);
  }
}
const aAncrer = pages.filter((p) => cache[p.slug]?.meta && !cache[p.slug].cands).map((p) => ({ slug: p.slug, ...cache[p.slug].meta }));
if (aAncrer.length) {
  const candidats = new Map();
  const choix = await ancrer(aAncrer, { dors, candidats, compteur: { anilist: 0 }, progres: (c, i, n) => process.stderr.write(`\rAniList ${c} ${i}/${n}   `) });
  for (const [slug, c] of choix) cache[slug].choix = c;
  for (const [slug, l] of candidats) cache[slug].cands = [...new Map(l.map((m) => [m.id, m])).values()];
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  process.stderr.write("\n");
}

/* 3. Comparaison avec l'ancre actuelle. */
const cats = { confirmee: [], changee: [], gagnee: [], perdue: [], toujoursSans: [] };
for (const p of pages) {
  const c = cache[p.slug]?.choix;
  if (!c) continue;
  const avant = p.anilist ? Number(p.anilist) : null;
  const k = avant && c.id === avant ? "confirmee" : avant && c.id ? "changee" : !avant && c.id ? "gagnee" : avant ? "perdue" : "toujoursSans";
  cats[k].push({ ...p, choix: c, meta: cache[p.slug].meta });
}
const ligne = (x) => `${x.slug} [${x.langue}, ${x.type || "?"}, ${x.nb_vivants} ep vivants] avant=${x.anilist || "-"} (${x.ancre}) -> ${x.choix.id || "-"} (${x.choix.note})`;
const rapport = [
  `# Audit des ancres voir-anime (${new Date().toISOString().slice(0, 10)})`, "",
  ...Object.entries(cats).map(([k, l]) => `- ${k} : ${l.length}`), "",
  ...["changee", "perdue", "gagnee", "toujoursSans"].flatMap((k) => [`## ${k}`, "", ...cats[k].map(ligne), ""]),
].join("\n");
fs.writeFileSync(args.rapport || "audit-ancres.md", rapport);
console.log(Object.entries(cats).map(([k, l]) => `${k} ${l.length}`).join(" · "));

/* 4. --appliquer : l'empreinte devient l'ancre (gagnees, changees, perdues). */
if (args.appliquer) {
  const t = Date.now();
  const ops = pages.filter((p) => cache[p.slug]?.choix && cache[p.slug].choix.note !== "anilist-injoignable").map((p) => {
    const c = cache[p.slug].choix;
    return { sql: "UPDATE va_page SET anilist = ?, ancre = ?, ancre_le = ? WHERE slug = ?", args: [c.id, c.note, t, p.slug] };
  });
  for (let i = 0; i < ops.length; i += 200) await db.batch(ops.slice(i, i + 200), "write");
  console.log(`${ops.length} ancre(s) ecrite(s)`);
}
