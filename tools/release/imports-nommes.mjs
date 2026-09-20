#!/usr/bin/env node
/**
 * Verifie que chaque import NOMME designe un export qui existe reellement.
 *
 * POURQUOI. `release/vitesse` a construit, passe le lint, et passe `tsc` — avec
 * un `import { hasFreshUserList } from "@/lib/anilist/userListCache"` dont la
 * cible n'exportait rien de tel. Le fichier importateur etait en `.js` : hors
 * du typage, et webpack resout le MODULE sans verifier le NOM. La panne
 * n'apparaissait qu'a l'execution, sur la page de lecture.
 *
 * C'est le risque propre a une branche construite par selection de fichiers :
 * on prend l'appelant sans son appele, ou une version de l'appele ou le nom
 * n'existe pas encore. Ce controle est donc obligatoire avant toute release du
 * socle, et il ne coute que quelques secondes.
 *
 *   node tools/release/imports-nommes.mjs
 *
 * Limites assumees : analyse textuelle, pas d'AST. Elle ne suit ni les
 * re-exports en etoile (`export * from`) — traites comme « on ne sait pas,
 * donc on se tait — ni les exports fabriques dynamiquement. Elle attrape la
 * classe d'erreur qui nous a mordus, pas toutes les erreurs possibles.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const racine = process.cwd();
const fichiers = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64e6 })
  .split("\n")
  .filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && !f.startsWith("node_modules/"));

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];
const resous = (spec) => {
  const base = spec.replace(/^@\//, "").replace(/\.(tsx?|jsx?|mjs)$/, "");
  for (const e of EXTS) if (existsSync(`${racine}/${base}${e}`)) return `${base}${e}`;
  return null;
};

const cacheExports = new Map();
function exportsDe(fichier) {
  if (cacheExports.has(fichier)) return cacheExports.get(fichier);
  const src = readFileSync(`${racine}/${fichier}`, "utf8");
  const noms = new Set();
  // export const/function/class/type/interface/enum NOM
  for (const m of src.matchAll(
    /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
  ))
    noms.add(m[1]);
  // export { a, b as c } — et `export type { … }`, avec ou sans `from`.
  // Oublier le `type` faisait passer `export type { Facette };` pour un export
  // absent, et rendait quatre faux positifs.
  for (const m of src.matchAll(/export\s+type\s*\{([^}]*)\}|export\s*\{([^}]*)\}/g))
    for (const part of (m[1] ?? m[2]).split(","))
      noms.add((part.split(/\s+as\s+/).pop() || "").trim().replace(/^type\s+/, ""));
  // export default
  if (/^\s*export\s+default\b/m.test(src)) noms.add("default");
  // Un re-export en etoile rend l'inventaire incomplet : on s'abstient.
  const etoile = /export\s+\*\s+from/.test(src);
  const r = etoile ? null : noms;
  cacheExports.set(fichier, r);
  return r;
}

let fautes = 0;
for (const f of fichiers) {
  const src = readFileSync(`${racine}/${f}`, "utf8");
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](@\/[^"']+)["']/g)) {
    const cible = resous(m[2]);
    if (!cible) {
      console.log(`${f}\n    module introuvable : ${m[2]}`);
      fautes++;
      continue;
    }
    const dispo = exportsDe(cible);
    if (!dispo) continue; // re-export en etoile : inventaire incomplet
    for (const brut of m[1].split(",")) {
      const nom = brut.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (!nom || dispo.has(nom)) continue;
      console.log(`${f}\n    ${nom} absent de ${cible}`);
      fautes++;
    }
  }
}

console.log(
  fautes === 0
    ? `OK — ${fichiers.length} fichiers, aucun import nomme orphelin.`
    : `\n${fautes} import(s) nomme(s) sans export correspondant.`,
);
process.exit(fautes === 0 ? 0 : 1);
