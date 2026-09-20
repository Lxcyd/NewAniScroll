// Poser (et VERIFIER) une correspondance voir-anime dans player_map.
//
//   node scripts/player-map/set-voiranime-map.mjs <aniId> <lang> <slug> [--offset N] [--note "..."] [--dry]
//
//   node scripts/player-map/set-voiranime-map.mjs 142329 vf kimetsu-no-yaiba-2-vf --offset 7
//
// lang = vf | vostfr. `--offset N` : la page fusionne plusieurs saisons et
// l'episode 1 de CETTE entree y porte le numero N+1.
//
// POURQUOI CE SCRIPT EXISTE
//
// Le resolveur devine le slug a partir du titre et d'un numero de saison. Il ne
// peut pas deviner qu'un fournisseur a FUSIONNE deux saisons sur une page :
// « Kimetsu no Yaiba 2 » chez voir-anime, ce sont Mugen Ressha-hen (7 ep) puis
// Yuukaku-hen (11), soit nos saisons 2 et 3 sur une seule page numerotee 2.
// Aucun schema de slug ne mene la, et le garde de coherence de saison rejetait
// meme la bonne reponse. C'est exactement ce que la table est censee porter.
//
// UNE LIGNE `verified` COURT-CIRCUITE CE GARDE (cf. pages/api/v2/source), donc
// elle doit etre MERITEE, pas ecrite de confiance. Le script controle avant
// d'ecrire : la page existe, et elle contient bien les `episodes` de l'entree
// AniList a partir de `offset + 1`. Sans ca, il refuse.
//
// Lit TURSO_DATABASE_URL / TURSO_AUTH_TOKEN dans .env.local.

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

const aniId = Number(positional[0]);
const lang = positional[1];
const slug = positional[2];
const offset = Number(flag("offset", 0));
const note = flag("note", "manuel: page fusionnee / numerotation fournisseur");
const dry = argv.includes("--dry");

if (!aniId || !["vf", "vostfr"].includes(lang) || !slug || !Number.isFinite(offset)) {
  console.error(
    "usage: node scripts/player-map/set-voiranime-map.mjs <aniId> <vf|vostfr> <slug> [--offset N] [--note ...] [--dry]",
  );
  process.exit(2);
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Les numeros d'episode listes sur une page voir-anime. */
async function pageEpisodes(s) {
  const res = await fetch(`https://voir-anime.to/anime/${s}/`, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const html = await res.text();
  const nums = new Set();
  /* Le slug de l'episode n'est PAS celui de l'anime (kimetsu-no-yaiba-3 liste
     des `kimetsu-no-yaiba-3-01-vostfr`, mais kimetsu-no-yaiba-vf liste des
     `kimetsu-no-yaiba-demon-slayer-01-vf`) : on ne filtre donc que sur le
     chemin parent, et on lit le nombre en fin de slug enfant. */
  const re = new RegExp(
    `href="https://voir-anime\\.to/anime/${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^"]+?)/"`,
    "g",
  );
  for (const m of html.matchAll(re)) {
    const tail = m[1].match(/(\d+)(?:-(?:vf|vostfr))?$/);
    if (tail) nums.add(Number(tail[1]));
  }
  return [...nums].sort((a, b) => a - b);
}

async function anilist(id) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($id:Int){Media(id:$id,type:ANIME){episodes status title{romaji english}}}`,
      variables: { id },
    }),
  });
  const json = await res.json();
  return json?.data?.Media ?? null;
}

const media = await anilist(aniId);
if (!media) {
  console.error(`AniList ne connait pas ${aniId}`);
  process.exit(1);
}
const wanted = Number(media.episodes) || 0;
console.log(`${aniId} — ${media.title.romaji} (${wanted || "?"} ep, ${media.status})`);

const eps = await pageEpisodes(slug);
if (!eps) {
  console.error(`voir-anime: /anime/${slug}/ est introuvable`);
  process.exit(1);
}
console.log(`voir-anime /anime/${slug}/ — ${eps.length} ep listes (${eps[0]}…${eps[eps.length - 1]})`);

/* Le controle qui donne droit au statut `verified` : tous les episodes de
   l'entree, decalage applique, sont sur la page. Un compte inconnu cote
   AniList (serie en cours sans total) ne peut pas etre controle — on refuse
   plutot que de promouvoir a l'aveugle. */
if (!wanted) {
  console.error("AniList ne donne pas de nombre d'episodes — controle impossible, rien n'est ecrit");
  process.exit(1);
}
const have = new Set(eps);
const missing = [];
for (let i = 1; i <= wanted; i += 1) if (!have.has(i + offset)) missing.push(i + offset);
if (missing.length) {
  console.error(
    `REFUS : la page n'a pas les episodes ${missing.slice(0, 8).join(", ")}` +
      `${missing.length > 8 ? "…" : ""} (decalage ${offset})`,
  );
  process.exit(1);
}
console.log(`OK : episodes ${1 + offset}…${wanted + offset} presents (decalage ${offset})`);

if (dry) {
  console.log("--dry : rien n'est ecrit");
  process.exit(0);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const now = Math.floor(Date.now() / 1000);
const ttl = (media.status === "RELEASING" ? 7 : 90) * 86400;

await db.execute({
  sql: `INSERT INTO player_map
          (ani_id, source, lang, status, slug, season_dir, ep_offset,
           episode_count, confidence, fail_count, note, algo_version, checked_at, expires_at)
        VALUES (?, 'voiranime', ?, 'verified', ?, NULL, ?, ?, 1, 0, ?, 2, ?, ?)
        ON CONFLICT(ani_id, source, lang) DO UPDATE SET
          status        = 'verified',
          slug          = excluded.slug,
          season_dir    = NULL,
          ep_offset     = excluded.ep_offset,
          episode_count = excluded.episode_count,
          confidence    = 1,
          fail_count    = 0,
          note          = excluded.note,
          algo_version  = excluded.algo_version,
          checked_at    = excluded.checked_at,
          expires_at    = excluded.expires_at`,
  args: [aniId, lang, slug, offset, wanted, note, now, now + ttl],
});

console.log(`ecrit : ${aniId}/voiranime/${lang} → ${slug} (+${offset}) verified`);
