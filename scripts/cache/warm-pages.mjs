#!/usr/bin/env node
/**
 * Rechauffe le cache d'edge des quelques pages qui comptent, apres un deploiement.
 *
 * POURQUOI. Un nouveau deploiement Vercel repart avec un cache d'edge VIDE.
 * Les pages SSR portent pourtant de bons en-tetes — `s-maxage=21600` sur la
 * fiche anime, `7200` sur l'accueil, plus un jour de `stale-while-revalidate` —
 * mais `stale-while-revalidate` ne sert que s'il existe deja une copie a servir.
 * Sur un site a faible trafic, la premiere entree de chaque URL est donc payee
 * PLEIN TARIF par un visiteur, et il attend.
 *
 * Mesure du 20/09/2026, une heure apres un deploiement de prod :
 *
 *   /en                          MISS  2,33 s
 *   /en/anime/watch/154587/…     MISS  2,09 s
 *   /en/anime/154587/frieren     MISS  1,11 s
 *   /en/anime/21/one-piece       MISS  0,80 s
 *
 * Les memes URL, une fois l'entree posee : 75 a 120 ms. C'est exactement l'ecart
 * que ce script supprime.
 *
 * CE QUE CE SCRIPT N'EST PAS. La marche complete du catalogue
 * (scripts/cache/warm-anime-pages, declenchee a la main) chauffe des milliers de
 * fiches et a ete, de l'aveu du workflow qui la porte, « le plus gros cout
 * Vercel auto-infflige du site ». Ici on chauffe quelques dizaines d'URL, une
 * fois par deploiement. Le budget est le `--limit`, et rien d'autre ne s'y
 * ajoute : ce n'est pas une boucle de sondage, c'est une passe unique et bornee.
 *
 * ORDRE DE PRIORITE. `last_accessed_at` d'abord — ce que NOS visiteurs ouvrent
 * reellement — et la popularite AniList seulement en secours, pour une base
 * fraichement deployee qui n'a pas encore d'historique.
 *
 * Usage :
 *   node scripts/cache/warm-pages.mjs [--site=https://aniscroll.com]
 *                                     [--limit=40] [--concurrency=3] [--dry]
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const SITE = (args.site || process.env.SITE_URL || "https://aniscroll.com").replace(/\/$/, "");
const LIMIT = Number(args.limit || 40);
/* UNE a la fois, par defaut. Mesure du 20/09/2026 sur la prod, a concurrence 3 :
   les premieres pages froides repondent en 0,4 a 2 s, puis le temps grimpe a
   5, 6, puis 12 s, avec un depassement de delai sur la derniere. Le rendu froid
   ne supporte pas d'etre concurrent de lui-meme — et pendant ce temps il
   degrade aussi les vrais visiteurs, c'est-a-dire exactement ce que cette passe
   est censee eviter. Une seule requete en vol tient largement dans le timeout du
   workflow (40 pages a ~1,5 s) et ne se remarque nulle part. */
const CONCURRENCY = Number(args.concurrency || 1);
const DRY = !!args.dry;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/* Les pages fixes, celles que tout le monde traverse. */
const FIXES = ["/en", "/en/schedule"];

const r = await db.execute({
  sql: `SELECT id FROM anime
         WHERE popularity IS NOT NULL
         ORDER BY COALESCE(last_accessed_at, 0) DESC, popularity DESC
         LIMIT ?`,
  args: [LIMIT],
});
/* `/en/anime/{id}` sans slug : c'est l'URL que le site fabrique lui-meme
   (lib/prefs/clickTarget → animeHref), donc la cle de cache que les visiteurs
   demanderont. Chauffer une variante avec slug remplirait une autre entree et
   ne servirait a personne. */
const urls = [...FIXES, ...r.rows.map((x) => `/en/anime/${Number(x.id)}`)];

console.log(`[warm-pages] ${urls.length} URL a chauffer sur ${SITE}`);
if (DRY) {
  urls.forEach((u) => console.log("  ", u));
  process.exit(0);
}

const bilan = { HIT: 0, MISS: 0, erreur: 0 };
let plusLent = { url: null, ms: 0 };

async function chauffe(chemin) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${SITE}${chemin}`, {
      headers: { "User-Agent": "aniscroll-warm-pages" },
      signal: AbortSignal.timeout(30000),
    });
    const ms = Date.now() - t0;
    /* Le corps DOIT etre consomme : sans ca la connexion reste ouverte et,
       surtout, Vercel peut ne pas finir de remplir l'entree de cache. */
    await res.arrayBuffer();
    const etat = res.headers.get("x-vercel-cache") || "?";
    bilan[etat] = (bilan[etat] || 0) + 1;
    if (ms > plusLent.ms) plusLent = { url: chemin, ms };
    return `${etat.padEnd(6)} ${String(ms).padStart(5)}ms  ${chemin}`;
  } catch (e) {
    bilan.erreur++;
    return `ERREUR       ${chemin} — ${e.message}`;
  }
}

const file = [...urls];
async function ouvrier() {
  for (;;) {
    const u = file.shift();
    if (!u) return;
    console.log("  " + (await chauffe(u)));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, ouvrier));

console.log(`\n[warm-pages] ${JSON.stringify(bilan)}`);
console.log(`[warm-pages] la plus lente : ${plusLent.url} (${plusLent.ms} ms)`);
/* Un MISS ici est une BONNE nouvelle : c'est une entree qu'un visiteur n'aura
   pas a payer. Beaucoup de HIT veut dire que le cache tenait deja, donc que la
   passe n'etait pas necessaire — ce qui est aussi une information. */
