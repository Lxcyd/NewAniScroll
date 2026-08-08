/**
 * POINT 6 DU PLAN — détecteur contre participatif, sur un lot représentatif.
 *
 * Le plan interdit explicitement de trancher sur un COMPTAGE D'ERREURS : sur
 * ~50 titres on comparerait peut-être 2 erreurs contre 3, ce qui ne départage
 * rien et pourrait faire abandonner (ou valider) le détecteur sur du bruit.
 * On mesure donc trois grandeurs qui bougent assez pour être lisibles :
 *
 *   1. COUVERTURE PONDÉRÉE par la popularité — un titre très regardé qui
 *      manque coûte plus qu'un titre confidentiel. (Popularité AniList, faute
 *      de trafic réel : `vercel logs` exige une session interactive et Turso
 *      n'a aucune table de trafic. Substitut assumé, cf. DEVLOG §11.)
 *   2. TAUX D'ABSTENTION — la part des cellules où on a trouvé quelque chose
 *      mais où la porte de service le retient. C'est le prix direct de
 *      « en cas de doute, on s'abstient » ; sans lui, la couverture seule
 *      donnerait l'illusion qu'on sert tout ce qu'on détecte.
 *   3. DÉSACCORDS — les cellules où les deux sources ont une valeur et ne
 *      disent pas la même chose. Chaque désaccord est un cas à trancher, donc
 *      une information ; une erreur rare est du bruit.
 *
 * ⚠️ À N'EXÉCUTER QUE SUR UN LOT REPRÉSENTATIF (`out/top50.jsonl`). Sur les
 * lots d'audit, constitués pour être DIFFICILES, le détecteur perdrait
 * d'avance puisqu'on l'aurait jugé sur ce qu'on lui a donné de plus dur.
 *
 * LECTURE SEULE : aucune écriture en base, rien de servi n'est modifié.
 *
 * Usage :
 *   node tools/opening-detector/_compare_sources.mjs [--in=out/top50.jsonl]
 *                                                    [--tolerance=2] [--limit=N]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviders, makeLookup, pool } from "./_skip_providers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const IN = resolve(HERE, arg("in", "out/top50.jsonl"));
const OUT = join(HERE, "out/compare_sources.jsonl");
// Deux sources indépendantes ne tomberont jamais sur la même décimale : un
// désaccord n'est intéressant qu'au-delà de ce que l'oeil perçoit sur un saut.
const TOL = Number(arg("tolerance", "2"));
const LIMIT = Number(arg("limit", "0"));

if (!existsSync(IN)) {
  console.error(`introuvable : ${IN}`);
  process.exit(1);
}

// ── Le lot ───────────────────────────────────────────────────────────────────
const raw = readFileSync(IN, "utf8").trim().split("\n")
  .filter(Boolean).map((l) => JSON.parse(l));
if (!raw.length) {
  console.error(`${IN} est vide — rien à comparer.`);
  process.exit(1);
}

// DÉDOUBLONNAGE OBLIGATOIRE, et ce n'est pas une précaution de principe.
// `ResultSink` ouvre le JSONL en AJOUT — c'est le bon choix, il rend le lot
// résistant aux plantages — donc une cellule refaite s'AJOUTE au lieu de
// remplacer. Le lot du 08/08 en donne le cas d'école : le run de 01:50 avait
// écrit 14 lignes puis est mort sans écrire son manifeste, la relance a repris
// à zéro, et le fichier portait 39 lignes pour 25 cellules réelles.
// Sans ce filtre, toute statistique compte deux fois la partie refaite — la
// mienne le faisait. On garde la DERNIÈRE occurrence : c'est la plus récente,
// donc celle produite par le code le plus à jour.
const byCell = new Map();
for (const r of raw) byCell.set(`${r.mal_id}:${r.episode}:${r.lang}`, r);
const rows = [...byCell.values()];
if (rows.length !== raw.length) {
  console.error(`  ${raw.length} lignes -> ${rows.length} cellules distinctes `
    + `(${raw.length - rows.length} reecritures d'un run precedent, ignorees)`);
}

// Popularité : le lot d'entrée la porte déjà (l'exporteur trie dessus). On la
// relit depuis le fichier de liste plutôt que de la redemander à AniList.
const listPath = resolve(HERE, arg("list", "anime.top50.json"));
const popularity = new Map();
const anilistOf = new Map();
if (existsSync(listPath)) {
  for (const a of JSON.parse(readFileSync(listPath, "utf8"))) {
    if (a.mal_id != null) {
      popularity.set(a.mal_id, Number(a.popularity ?? a._popularity ?? 0));
      if (a.anilist_id != null) anilistOf.set(a.mal_id, a.anilist_id);
    }
  }
}
// Un titre du lot absent de la table de poids retomberait à 1 — soit 6 ordres
// de grandeur sous ses voisins (les popularités vont de ~440k à ~1M), ce qui
// l'effacerait de la mesure sans rien dire. Les cas sont comptés et affichés.
// Ça arrive pour de bon : la 50ᵉ place a changé entre l'export du lot et celui
// des poids, simple dérive de popularité.
const unweighted = new Set();
const weightOf = (mal) => {
  const p = popularity.get(mal);
  if (!p) { unweighted.add(mal); return 1; }
  return p;
};
// ⚠️ Ce test portait d'abord sur `popularity.size > 0`, et il A MENTI : la
// liste contenait bien 50 entrées, mais aucune n'avait de champ `popularity`
// (l'exporteur le supprimait), donc tous les poids valaient 1 et la ligne
// « pondérée » sortait égale à la brute, estampillée « [popularite AniList] ».
// Une pondération n'existe pas parce qu'on a une table de poids : elle existe
// quand les poids DIFFÈRENT. C'est ça qu'il faut tester.
const weightsKnown = [...popularity.values()].some((p) => p > 0);

// ── Interroger le participatif ───────────────────────────────────────────────
const lookup = makeLookup(await loadProviders());
const pairs = new Map();
for (const r of rows) {
  const key = `${r.mal_id}:${r.episode}`;
  if (!pairs.has(key)) {
    pairs.set(key, {
      mal_id: r.mal_id, anilist_id: anilistOf.get(r.mal_id) ?? null,
      episode: r.episode,
      // AniSkip refuse une durée nulle ; on prend la plus longue vue.
      episode_length: 0,
    });
  }
  const p = pairs.get(key);
  const dur = r.op?.canonical_duration || r.ed?.canonical_duration || 0;
  p.episode_length = Math.max(p.episode_length, dur);
}
let work = [...pairs.values()];
if (LIMIT > 0) work = work.slice(0, LIMIT);
process.stderr.write(`interrogation de ${work.length} paires (anime, episode)...\n`);
const third = new Map();
await pool(work, async (p) => {
  third.set(`${p.mal_id}:${p.episode}`, await lookup(p));
}, { concurrency: 3 });

// ── Dépouillement ────────────────────────────────────────────────────────────
const KINDS = ["op", "ed"];
const stat = {
  cells: 0,
  served: 0, held: 0, empty: 0,
  wSeen: 0, wServed: 0,
  thirdHas: 0,
  bothHave: 0, agree: 0, disagree: 0,
  onlyUs: 0, onlyThem: 0, neither: 0,
};
const disagreements = [];
const lines = [];

for (const r of rows) {
  const t = third.get(`${r.mal_id}:${r.episode}`);
  if (!t) continue;
  const w = weightOf(r.mal_id);
  for (const kind of KINDS) {
    const hit = r[kind];
    // Une absence que la source déclare ATTENDUE n'est pas une cellule qu'on
    // aurait ratée : la compter en dénominateur ferait chuter la couverture
    // pour des épisodes qui n'ont légitimement pas de générique.
    if (!hit && r.expected_absent?.[kind] === true) continue;
    stat.cells += 1;
    stat.wSeen += w;

    const ours = hit && hit.serve ? hit : null;
    if (hit && hit.serve) { stat.served += 1; stat.wServed += w; }
    else if (hit) stat.held += 1;
    else stat.empty += 1;

    const theirs = [...t.aniskip, ...t.animeskip].find((s) => s.type === kind);
    if (theirs) stat.thirdHas += 1;

    if (ours && theirs) {
      stat.bothHave += 1;
      const d = Math.abs(Number(theirs.start) - ours.start);
      if (d <= TOL) stat.agree += 1;
      else {
        stat.disagree += 1;
        // GÉOMÉTRIE DU DÉSACCORD, et ce n'est pas un raffinement cosmétique :
        // sans elle, « 39 % de désaccord » se lit comme 39 % d'erreurs. Or
        // quand leur marqueur commence APRÈS la fin du nôtre, les deux
        // sources ne parlent pas du même objet. Cas constaté sur mal 31964
        // ep2 : notre ED fait 1350,2→1439,8 (89,5 s, l'ED entier, 3 hôtes sur
        // 3 à 1,06 s près contre la référence AnimeThemes) et ils annoncent
        // 1443 sur un épisode de 1470 — 27 s, soit l'aperçu final. Ce n'est
        // pas un desaccord sur la position de l'ED, c'est un autre segment.
        const forme = Number(theirs.start) >= ours.end ? "apres"
          : Number(theirs.start) + 5 <= ours.start ? "avant"
          : "chevauche";
        stat[`d_${forme}`] = (stat[`d_${forme}`] || 0) + 1;
        disagreements.push({
          mal_id: r.mal_id, episode: r.episode, lang: r.lang, kind, forme,
          nous: ours.start, eux: Number(theirs.start), ecart: +d.toFixed(2),
          hosts_agree: ours.hosts_agree, spread: ours.spread,
        });
      }
    } else if (ours) stat.onlyUs += 1;
    else if (theirs) stat.onlyThem += 1;
    else stat.neither += 1;

    lines.push(JSON.stringify({
      mal_id: r.mal_id, episode: r.episode, lang: r.lang, kind,
      nous: ours ? ours.start : null,
      retenu: hit && !hit.serve ? hit.held_reason : null,
      eux: theirs ? Number(theirs.start) : null,
      poids: w,
    }));
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join("\n") + "\n", "utf8");

// ── Restitution ──────────────────────────────────────────────────────────────
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)} %` : "n/a");
console.log(`\n=== POINT 6 — ${rows.length} lignes, ${stat.cells} cellules exploitables ===`);
console.log(`   (lot : ${IN})`);

console.log("\n1. COUVERTURE");
console.log(`   servie (brute)    : ${stat.served}/${stat.cells}  ${pct(stat.served, stat.cells)}`);
// Ne RIEN afficher plutôt qu'un nombre égal à la brute sous une étiquette
// « pondérée » : c'est la ligne qu'on citerait, et elle serait fausse.
if (weightsKnown) {
  console.log(`   servie (ponderee) : ${pct(stat.wServed, stat.wSeen)}  [popularite AniList]`);
  if (unweighted.size) {
    console.log(`                       !! ${unweighted.size} titre(s) sans poids, `
      + `comptes a 1 : ${[...unweighted].join(", ")}`);
  }
} else {
  console.log("   servie (ponderee) : INDISPONIBLE — la liste ne porte aucune");
  console.log(`                       popularite (${listPath}).`);
  console.log("                       Regenerer avec scripts/export-oped-anime-list.mjs,");
  console.log("                       ou passer --list=<fichier qui en porte>.");
}
console.log(`   participatif      : ${stat.thirdHas}/${stat.cells}  ${pct(stat.thirdHas, stat.cells)}`);

console.log("\n2. ABSTENTION");
console.log(`   trouve mais retenu : ${stat.held}/${stat.cells}  ${pct(stat.held, stat.cells)}`);
console.log(`   rien trouve        : ${stat.empty}/${stat.cells}  ${pct(stat.empty, stat.cells)}`);
const found = stat.served + stat.held;
console.log(`   -> sur ce qu'on TROUVE, on s'abstient dans ${pct(stat.held, found)}`);

console.log(`\n3. DESACCORDS (tolerance ${TOL} s)`);
console.log(`   les deux ont une valeur : ${stat.bothHave}`);
console.log(`     dont d'accord         : ${stat.agree}  ${pct(stat.agree, stat.bothHave)}`);
console.log(`     dont en desaccord     : ${stat.disagree}  ${pct(stat.disagree, stat.bothHave)}`);
console.log(`       leur marqueur APRES la fin du notre : ${stat.d_apres || 0}`
  + "   <- objets differents, pas un desaccord de valeur");
console.log(`       leur marqueur AVANT notre debut     : ${stat.d_avant || 0}`);
console.log(`       chevauchement (meme objet)          : ${stat.d_chevauche || 0}`
  + "   <- les seuls vrais desaccords de bornes");
console.log(`   nous seuls              : ${stat.onlyUs}`);
console.log(`   eux seuls               : ${stat.onlyThem}   <- ce que le detecteur rate`);
console.log(`   ni l'un ni l'autre      : ${stat.neither}`);

if (disagreements.length) {
  console.log("\n   Les 15 plus gros ecarts — chacun est un cas a trancher a la main :");
  for (const d of disagreements.sort((a, b) => b.ecart - a.ecart).slice(0, 15)) {
    // La LANGUE doit apparaître : sans elle, les lignes vostfr et vf du même
    // épisode s'affichent comme un doublon inexplicable.
    console.log(`     mal ${String(d.mal_id).padEnd(6)} ep${String(d.episode).padEnd(3)} `
      + `${String(d.lang).padEnd(6)} ${d.kind}  nous=${String(d.nous).padEnd(8)} `
      + `eux=${String(d.eux).padEnd(6)} ecart=${String(d.ecart).padEnd(7)} `
      + `hotes=${d.hosts_agree} spread=${d.spread}`);
  }
}

// Ce que le comptage ne dit pas — imprimé pour que la conclusion ne l'oublie pas.
console.log("\n=== CE QUE CES CHIFFRES NE PROUVENT PAS ===");
console.log("  - Les deux fournisseurs sont PARTICIPATIFS : leur silence ne prouve");
console.log("    aucune absence, il suit la popularite. `eux seuls` est une borne");
console.log("    INFERIEURE de ce qu'on rate, jamais une verite terrain.");
console.log("  - Un desaccord ne dit pas QUI a tort. Il faut regarder la cellule.");
if (!weightsKnown) {
  console.log(`  - Aucune popularite lue depuis ${listPath} : la ligne "ponderee"`);
  console.log("    ci-dessus n'est PAS ponderee. Ne pas la citer comme telle.");
}
const nErr = [...third.values()].filter((r) => r.errors?.length).length;
if (nErr) console.log(`  - ${nErr} paire(s) avec au moins une erreur de fournisseur.`);
console.log(`\n-> ${OUT}`);
