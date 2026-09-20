#!/usr/bin/env node
/**
 * Le SOCLE : tout ce que dev apporte a la prod SAUF le profil.
 *
 * POURQUOI CE FICHIER EXISTE. `release/vitesse` avait ete construite en
 * cueillant des commits a la main. Resultat : elle servait le lecteur rapide
 * mais avait PERDU tout le travail de quota AniList (anilistFetch, seasonChain,
 * seasonCache, franchiseTree, db/anime, les routes catalog/search/seasons…),
 * pourtant l'une des quatre choses qu'elle devait porter. Une cueillette
 * oublie, en silence, et on ne s'en apercoit qu'en prod.
 *
 * On fait donc l'inverse : on part de TOUT ce que dev apporte, et on RETIRE
 * une liste explicite. Ce qui est nouveau sur dev et qui n'est pas dans la
 * liste d'exclusion entre dans le socle par defaut — l'oubli devient
 * impossible, et c'est une decision consciente qui exclut, jamais une
 * distraction.
 *
 *   node tools/release/socle.mjs            liste et classe
 *   node tools/release/socle.mjs --frontiere   ce qui, dans le socle, importe
 *                                              un module exclu (le vrai travail)
 *   node tools/release/socle.mjs --appliquer   ecrit les fichiers dans l'index
 *
 * A relire avant chaque synchro : la liste d'exclusion ci-dessous est la
 * definition du perimetre, pas une commodite.
 */
import { execFileSync } from "node:child_process";

const BASE = process.env.SOCLE_BASE || "origin/main";
const SOURCE = process.env.SOCLE_SOURCE || "origin/dev";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/* ── Ce qui reste DEHORS ──────────────────────────────────────────────────
 * Le profil et tout ce qui n'existe que pour lui : comptes, authentification
 * maison, badges, mise en page des widgets, pages de profil.
 *
 * `lib/stats/streak.ts` n'y est PAS : le lecteur s'en sert pour compter une
 * journee de visionnage, il precede le profil et vit sans lui.
 */
const DEHORS = [
  /^components\/auth\//,
  /^components\/profile\//,
  /^components\/shared\/AchievementToast\./,
  /* lib/badges : le MOTEUR et le catalogue restent dehors. Les trois
     enregistreurs FEUILLES entrent — `facts` est un magasin de compteurs
     bornes en localStorage, sans interface et sans dependance hors de
     `localtime` ; `gestures` pose des ecouteurs. Treize fichiers ordinaires du
     site les appellent (la recherche, l'editeur de liste, la page 404, le
     lecteur). Les exclure imposerait treize retouches de sites d'appel, donc
     treize points de conflit a chaque synchro, pour retirer du code qui
     n'affiche rien. */
  /^lib\/badges\/(?!facts\.|gestures\.|localtime\.)/,
  /* Pareil : `avatar` calcule une URL, `isAdmin` existe deja sur main. Le
     reste (sessions, mots de passe, magasin d'utilisateurs) est le compte. */
  /^lib\/auth\/(?!avatar\.|isAdmin\.)/,
  /* `history` est l'historique de visionnage — la « reprise » et la page
     « repris recemment », pas une decoration de profil. `href` fabrique une
     URL. Le reste est le profil. */
  /^lib\/profile\/(?!history\.|href\.)/,
  /^lib\/prefs\/profileLayout\./,
  /^lib\/list\/cloudSync\./,
  /^pages\/api\/v2\/account\//,
  /^pages\/api\/v2\/admin\/users\./,
  /^pages\/api\/v2\/profile-banner\./,
  /^pages\/api\/auth\//,
  /^pages\/api\/user\/profile\./,
  /^pages\/en\/profile\//,
  /^pages\/en\/auth\//,
  /^pages\/reset-password\./,
  /^tools\/badges\//,
];

/* Les outils Python d'OP/ED et leurs donnees : hors sujet pour une release du
   site, et l'utilisateur a demande qu'on n'y touche pas. Leurs 50 fichiers de
   scratch/datasets n'ont rien a faire dans une PR de prod. */
const HORS_SUJET = [/^tools\/opening-detector\//, /^tools\/usage-monitor\/snapshots\//];

const exclu = (f) => DEHORS.some((r) => r.test(f)) || HORS_SUJET.some((r) => r.test(f));

const fichiers = git("diff", "--name-only", BASE, SOURCE).split("\n").filter(Boolean);
const dedans = fichiers.filter((f) => !exclu(f));
const dehors = fichiers.filter(exclu);

if (process.argv.includes("--frontiere")) {
  /* La frontiere : un fichier DU SOCLE qui importe un module EXCLU. Chacun est
     une decision a prendre — soit le module rentre (il n'etait pas vraiment du
     profil), soit l'import doit disparaitre. Tant qu'il en reste un, le socle
     ne construit pas. C'est la seule chose qui demande du jugement ici. */
  /* `@/x/y` doit d'abord etre RESOLU en fichier reel avant d'etre juge : tester
     la regle d'exclusion sur le chemin d'import nu produit des faux positifs
     (`lib/badges/facts` sortait « exclu » alors que la regle le garde). */
  const tousDev = new Set(git("ls-tree", "-r", "--name-only", SOURCE).split("\n").filter(Boolean));
  const resous = (spec) => {
    const base = spec.replace(/\.(tsx?|jsx?|mjs)$/, "");
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx"]) {
      if (tousDev.has(base + ext)) return base + ext;
    }
    return null;
  };
  let n = 0;
  for (const f of dedans) {
    if (!/\.(tsx?|jsx?|mjs)$/.test(f)) continue;
    if (!tousDev.has(f)) continue; // supprime sur dev : rien a inspecter
    const src = git("show", `${SOURCE}:${f}`);
    const vus = new Set();
    for (const m of src.matchAll(/from\s+["']@\/([^"']+)["']|import\(\s*["']@\/([^"']+)["']/g)) {
      const cible = resous(m[1] || m[2]);
      if (!cible || !exclu(cible) || vus.has(cible)) continue;
      vus.add(cible);
      console.log(`${f}\n    -> ${cible}`);
      n++;
    }
  }
  console.log(`\n${n} import(s) a trancher.`);
  process.exit(0);
}

if (process.argv.includes("--appliquer")) {
  /* Un fichier SUPPRIME sur dev ne peut pas etre « checkout » : git repond
     « pathspec did not match any file(s) known to git » et le lot entier
     echoue. Les deux cas se traitent separement — porter une suppression fait
     partie de porter le travail.

     A savoir : ce fichier fait lui-meme partie du socle, donc l'application
     l'ECRASE par la version de la source. C'est voulu (la definition du
     perimetre doit venir de la source, pas de la branche de sortie), mais ca
     surprend : une modification locale non poussee sur SOURCE est perdue ici. */
  const surSource = new Set(git("ls-tree", "-r", "--name-only", SOURCE).split("\n").filter(Boolean));
  const aPorter = dedans.filter((f) => surSource.has(f));
  const aSupprimer = dedans.filter((f) => !surSource.has(f));

  /* Par paquets : la ligne de commande Windows plafonne, et un `git checkout`
     de 190 chemins la depasse. */
  for (let i = 0; i < aPorter.length; i += 60) {
    git("checkout", SOURCE, "--", ...aPorter.slice(i, i + 60));
  }
  for (let i = 0; i < aSupprimer.length; i += 60) {
    git("rm", "-q", "--", ...aSupprimer.slice(i, i + 60));
  }
  console.log(`${aPorter.length} fichier(s) portes, ${aSupprimer.length} supprime(s).`);
  process.exit(0);
}

console.log(`base   : ${BASE}`);
console.log(`source : ${SOURCE}`);
console.log(`socle  : ${dedans.length} fichier(s)`);
console.log(`dehors : ${dehors.length} fichier(s)`);
const par = {};
for (const f of dedans) {
  const d = f.split("/").slice(0, 2).join("/");
  par[d] = (par[d] || 0) + 1;
}
for (const [d, n] of Object.entries(par).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(3)}  ${d}`);
}
