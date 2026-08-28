/**
 * Balayage de la numerotation des saisons — chasse aux doublons du type
 * "Jujutsu Kaisen" (deux "Season 1" a la file).
 *
 *   node tools/season-audit/audit.mjs [ids...]
 *
 * Appelle le VRAI resolveSeasonList, pas une replique : c'est le seul moyen de
 * dire quelque chose sur le site plutot que sur une reconstitution.
 *
 * Un numero repete n'est pas en soi une faute — une saison coupee en deux cours
 * porte deux fois le meme ("S3 Part 1", "S3 Part 2"). Le signalement porte donc
 * sur le doublon SANS marque de partie, celui qui laisse deux lignes
 * indiscernables dans le selecteur, et sur un compteur qui recule.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

for (const ligne of readFileSync(".env.local", "utf8").split("\n")) {
  const m = ligne.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

/* jiti 1.x : un `require` qui compile le TypeScript a la volee. Les alias "@/"
   du tsconfig lui sont inconnus, on les lui apprend. */
const jiti = createRequire(import.meta.url)("jiti")(process.cwd(), {
  interopDefault: true,
  alias: { "@": process.cwd() },
});
const { resolveSeasonList } = jiti("./lib/anilist/seasonChain.ts");

/* Franchises multi-saisons, choisies pour couvrir les pieges connus : cours
   coupes (AoT, Slime), sous-oeuvres numerotees (SAO), films dans la chaine
   (Fate, Chainsaw Man), titres non numerotes (Vinland, Frieren). */
const IDS = process.argv.slice(2).map(Number).filter(Boolean);
const DEFAUT = [
  113415, 16498, 11757, 101922, 21, 20605, 269, 1535, 21087, 97940,
  99423, 108465, 140960, 127230, 154587, 131681, 116778, 105333, 20958, 30015,
  9253, 100977, 21519, 20665, 918, 6547, 235, 813, 5114, 11061,
  1735, 21856, 108632, 137822, 142329, 151514, 166873, 176496, 21234, 98478,
];
const cibles = IDS.length ? IDS : DEFAUT;

const partie = (s) => /\b(?:Part|Cour)\b/i.test(String(s.label ?? ""));

let suspects = 0;
for (const id of cibles) {
  let liste;
  try {
    liste = await resolveSeasonList(id);
  } catch (e) {
    console.log(`  ?? ${id} : ${String(e).slice(0, 80)}`);
    continue;
  }
  if (!Array.isArray(liste) || liste.length < 2) continue;

  const tv = liste.filter((s) => s.format !== "MOVIE");
  const griefs = [];
  const vus = new Map();
  for (const s of tv) {
    const deja = vus.get(s.number);
    if (deja && !partie(deja) && !partie(s)) {
      griefs.push(`doublon S${s.number} : "${deja.label}" (${deja.year}) et "${s.label}" (${s.year})`);
    }
    if (!deja) vus.set(s.number, s);
  }
  for (let i = 1; i < tv.length; i++) {
    if (tv[i].number < tv[i - 1].number) {
      griefs.push(`recul : "${tv[i - 1].label}" puis "${tv[i].label}"`);
    }
  }

  const titre = liste[0]?.title?.english || liste[0]?.title?.romaji || id;
  if (griefs.length) {
    suspects++;
    console.log(`\n!! ${titre} (${id})`);
    for (const s of liste) console.log(`     ${String(s.label).padEnd(22)} ${s.year ?? "?"}  ${s.format ?? ""}`);
    for (const g of griefs) console.log(`   -> ${g}`);
  } else {
    console.log(`ok ${String(titre).slice(0, 40).padEnd(42)} ${tv.map((s) => "S" + s.number).join(" ")}`);
  }
}
console.log(`\n${suspects} franchise(s) a regarder sur ${cibles.length}.`);
process.exit(0);
