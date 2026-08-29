/**
 * Point 0 du plan — le plafond adressable du détecteur.
 *
 * Question : combien des titres que le site sait servir (player_map) ont une
 * entrée AnimeThemes EXPLOITABLE, c'est-à-dire au moins un thème avec une vidéo
 * à partir de laquelle on peut construire une référence ?
 *
 * C'est l'hypothèse jamais vérifiée qui est en amont de tout le reste. Si la
 * réponse est 40 %, le détecteur ne dépassera jamais 40 % de couverture quoi
 * qu'on fasse, le chemin participatif reste porteur pour toujours, et une partie
 * du plan est bâtie sur du sable. Quelques minutes de mesure évitent des
 * semaines de calcul mal orientées (le chapitre Réalisme du DEVLOG chiffre une
 * passe complète à 9-26 jours).
 *
 * Méthode : on aspire une fois l'index AnimeThemes (~130 pages de 100), avec les
 * thèmes, leurs entrées et leurs vidéos, plus les ressources externes qui
 * portent les identifiants AniList et MAL. Tout est mis en cache disque, donc
 * une deuxième exécution ne coûte aucun réseau. On croise ensuite avec les
 * `ani_id` distincts de player_map.
 *
 * Trois classes en sortie, parce que « pas d'entrée » et « entrée sans vidéo »
 * n'appellent pas le même correctif : la première relève du repli auto-dérivé
 * (SELF-OP/SELF-ED), la seconde d'un manque côté catalogue qu'on ne peut pas
 * combler nous-mêmes.
 *
 * LECTURE SEULE : aucune écriture en base, aucun effet sur ce qui est servi.
 *
 * Usage : node --env-file=.env.local tools/opening-detector/scratch/_measure_ceiling.mjs [--refresh]
 */
import { createClient } from "@libsql/client";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(HERE, "cache/animethemes-index.json");
const OUT = join(HERE, "out/ceiling.json");
const UA = "aniscroll-oped/1.0 (+https://aniscroll.com)";
const REFRESH = process.argv.includes("--refresh");

// ── 1. Index AnimeThemes, aspiré une fois ────────────────────────────────────
async function crawlIndex() {
  const byAniList = new Map();
  const byMal = new Map();
  let url =
    "https://api.animethemes.moe/anime?page[size]=100" +
    "&include=animethemes.animethemeentries.videos,resources";
  let page = 0;
  while (url) {
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, { headers: { "User-Agent": UA } });
      // 429 = throttle côté AnimeThemes. On respecte, on ne martèle pas : ce
      // projet a déjà été aveuglé par un quota (Anime-Skip, 186 paires sur 239).
      if (res.status !== 429 || attempt >= 5) break;
      const wait = 2000 * (attempt + 1);
      process.stderr.write(`  429, pause ${wait / 1000}s\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!res.ok) throw new Error(`animethemes ${res.status} sur ${url}`);
    const json = await res.json();
    for (const a of json.anime || []) {
      const themes = a.animethemes || [];
      // « Exploitable » = au moins un thème dont une entrée porte une vidéo.
      // C'est exactement ce dont build_references a besoin ; un thème sans
      // vidéo ne produit aucune empreinte de référence.
      let withVideo = 0;
      for (const t of themes) {
        const has = (t.animethemeentries || []).some(
          (e) => (e.videos || []).length > 0,
        );
        if (has) withVideo++;
      }
      const rec = { slug: a.slug, themes: themes.length, usable: withVideo };
      for (const r of a.resources || []) {
        if (r.site === "AniList") byAniList.set(Number(r.external_id), rec);
        else if (r.site === "MyAnimeList") byMal.set(Number(r.external_id), rec);
      }
    }
    url = json.links?.next || null;
    if (++page % 10 === 0) process.stderr.write(`  ${page} pages\n`);
    await new Promise((r) => setTimeout(r, 250)); // politesse
  }
  return {
    anilist: Object.fromEntries(byAniList),
    mal: Object.fromEntries(byMal),
    pages: page,
  };
}

let index;
if (!REFRESH && existsSync(CACHE)) {
  index = JSON.parse(readFileSync(CACHE, "utf8"));
  console.log(`index AnimeThemes lu du cache (${index.pages} pages)`);
} else {
  console.log("aspiration de l'index AnimeThemes…");
  index = await crawlIndex();
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(index), "utf8");
  console.log(`index aspiré : ${index.pages} pages`);
}
const nAni = Object.keys(index.anilist).length;
const nMal = Object.keys(index.mal).length;
console.log(`  ${nAni} titres avec identifiant AniList, ${nMal} avec MAL\n`);

// ── 2. Ce que le site sait servir ────────────────────────────────────────────
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const rows = await db.execute(
  "select ani_id, status, count(*) n from player_map where status in ('verified','heuristic') group by ani_id, status",
);
const titles = new Map(); // ani_id -> meilleur statut
for (const r of rows.rows) {
  const id = Number(r.ani_id);
  const prev = titles.get(id);
  // `verified` prime : un titre vérifié sur au moins une source est servi.
  if (!prev || r.status === "verified") titles.set(id, String(r.status));
}
console.log(`player_map : ${titles.size} titres distincts servables`);

// ── 3. Croisement ────────────────────────────────────────────────────────────
const classes = { usable: [], noVideo: [], absent: [] };
for (const [aniId, status] of titles) {
  const rec = index.anilist[aniId];
  if (!rec) classes.absent.push({ aniId, status });
  else if (rec.usable > 0)
    classes.usable.push({ aniId, status, slug: rec.slug, themes: rec.usable });
  else classes.noVideo.push({ aniId, status, slug: rec.slug, themes: rec.themes });
}
const tot = titles.size;
const pct = (n) => ((100 * n) / Math.max(1, tot)).toFixed(1) + " %";

console.log("\n=== PLAFOND ADRESSABLE DU DETECTEUR ===");
console.log(
  `  entree AnimeThemes exploitable : ${String(classes.usable.length).padStart(5)}  ${pct(classes.usable.length)}`,
);
console.log(
  `  entree sans aucune video       : ${String(classes.noVideo.length).padStart(5)}  ${pct(classes.noVideo.length)}`,
);
console.log(
  `  aucune entree AnimeThemes      : ${String(classes.absent.length).padStart(5)}  ${pct(classes.absent.length)}`,
);
console.log(
  `\n  -> plafond du chemin par reference : ${pct(classes.usable.length)}`,
);
console.log(
  `  -> le reste (${pct(classes.noVideo.length + classes.absent.length)}) ne peut venir QUE du repli auto-derive (SELF-OP/SELF-ED)`,
);
console.log(
  `     ou du participatif — aujourd'hui aucune cellule auto-derivee n'est servie.`,
);

// Ventilation par statut : un titre `heuristic` a un slug non verifie, donc le
// plafond utile a court terme est celui des `verified`.
const byStatus = (cls, st) => cls.filter((x) => x.status === st).length;
console.log("\n  ventilation par statut player_map :");
for (const st of ["verified", "heuristic"]) {
  const t = [...titles.values()].filter((x) => x === st).length;
  const u = byStatus(classes.usable, st);
  console.log(
    `    ${st.padEnd(10)} ${String(u).padStart(5)} / ${String(t).padStart(5)} exploitables  (${((100 * u) / Math.max(1, t)).toFixed(1)} %)`,
  );
}

// ── 4. Le chiffre qui décide vraiment : le plafond PONDERE ───────────────────
// Compter les titres met sur le même plan un blockbuster et une obscurité que
// personne n'ouvre. Or le plan sert des visiteurs, pas un catalogue, et son
// point 4 prioritise par le trafic. La popularité AniList est le proxy dont on
// dispose ici (le trafic réel viendra des logs Vercel au point 4).
const meta = new Map();
const allIds = [...titles.keys()];
for (let i = 0; i < allIds.length; i += 300) {
  const chunk = allIds.slice(i, i + 300);
  const r = await db
    .execute({
      sql: `select id, season_year, popularity from anime where id in (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    })
    .catch(() => null);
  if (r) {
    for (const row of r.rows) {
      meta.set(Number(row.id), {
        year: row.season_year ? Number(row.season_year) : null,
        pop: row.popularity ? Number(row.popularity) : 0,
      });
    }
  }
}
const describe = (cls, label) => {
  const m = cls.map((x) => meta.get(x.aniId)).filter(Boolean);
  const years = m.map((x) => x.year).filter(Boolean).sort((a, b) => a - b);
  const pops = m.map((x) => x.pop).sort((a, b) => a - b);
  const sum = m.reduce((s, x) => s + x.pop, 0);
  const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : 0);
  console.log(
    `    ${label.padEnd(26)} n=${String(m.length).padStart(4)}` +
      `  annee med.=${String(med(years) || "?").padStart(4)}` +
      `  popularite med.=${String(med(pops)).padStart(6)}`,
  );
  return sum;
};
console.log("\n  profil des trois classes :");
const sUsable = describe(classes.usable, "exploitables");
const sAbsent = describe(classes.absent, "sans entree");
const sNoVid = describe(classes.noVideo, "entree sans video");
const totalPop = sUsable + sAbsent + sNoVid;
console.log(
  `\n  => PLAFOND PONDERE PAR LA POPULARITE : ${((100 * sUsable) / Math.max(1, totalPop)).toFixed(1)} %`,
);
console.log(
  "     Les titres hors de portee sont surtout des obscurites : c'est ce qui",
);
console.log(
  "     separe un plafond par titre d'un plafond vu par un visiteur.",
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      measured_at: new Date().toISOString(),
      total_titles: tot,
      usable: classes.usable.length,
      no_video: classes.noVideo.length,
      absent: classes.absent.length,
      detail: classes,
    },
    null,
    1,
  ),
  "utf8",
);
console.log(`\n-> ${OUT}`);
