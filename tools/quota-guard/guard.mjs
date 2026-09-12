#!/usr/bin/env node
/**
 * Le garde-fou de quota Vercel.
 *
 * POURQUOI CE FICHIER EXISTE — 11/09/2026, le compte Vercel est passe en pause,
 * le site a repondu 402 a tous ses visiteurs, et il a fallu supprimer plus de
 * 380 deploiements a la main. Deux causes, dont une seule est du code :
 *
 *   1. Aucune politique de retention n'avait jamais ete reglee, donc AUCUN
 *      deploiement n'avait jamais expire depuis la creation du projet. Ca se
 *      corrige dans le dashboard, pas ici.
 *   2. Un rythme de pushs a la demande : 12 commits pousses en deux jours, dont
 *      10 dans la meme journee, sur une serie d'allers-retours d'affinage
 *      (12 -> 60 -> 30 -> 60 images). Chaque push = un deploiement Preview =
 *      un bundle complet dans Functions Storage ET Deployment Storage, plus une
 *      cle de cache d'edge neuve donc chaque vue y est un MISS.
 *
 * C'est le point 2 que ce fichier empeche de se reproduire. Ce n'est pas une
 * preference qu'on peut oublier : c'est un refus, avec un budget chiffre.
 *
 * DEUX NIVEAUX, VOLONTAIREMENT REDONDANTS :
 *
 *   - `.githooks/pre-push` appelle `check-push`, qui COMPTE et REFUSE. C'est le
 *     gardien reel : il tient meme quand le push vient d'un terminal, d'un IDE
 *     ou de n'importe quel outil qui n'est pas Claude Code.
 *   - `.claude/settings.json` appelle `inspect` en PreToolUse, qui LIT le meme
 *     compteur et refuse la commande avant meme qu'elle parte. Ca evite un push
 *     a moitie fait et, surtout, ca met la raison sous les yeux de l'agent
 *     plutot que dans un code de sortie.
 *
 * Le compteur vit dans `.git/` : il ne se versionne pas, donc il ne voyage pas
 * d'une machine a l'autre et ne pollue aucun diff.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

/* Trois pushs par jour sur `dev`. Le chiffre vient de la mesure : 10 dans la
   journee du 11/09 ont suffi a faire deborder deux plafonds de 10 Go. Trois
   laisse de quoi livrer une fonctionnalite, la corriger, puis la corriger
   encore — au-dela, on affine, et affiner ne merite pas un deploiement par
   iteration : ca merite un commit par iteration et UN push a la fin. */
const BUDGET_DEV = 3;

/* `main` n'est pas compte. Une release passe par une PR, elle est rare et
   deliberee, et bloquer un correctif de production au motif qu'on a trop
   pousse sur dev serait exactement le mauvais arbitrage. */
const BRANCHES_COMPTEES = new Set(["dev"]);

/** La soupape. L'utilisateur peut l'accorder ; l'agent doit la DEMANDER. */
const OVERRIDE = "ANISCROLL_PUSH_OVERRIDE";

function racineGit() {
  try {
    return execSync("git rev-parse --git-dir", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function jour() {
  // UTC, pour que le budget ne se reinitialise pas deux fois lors d'un
  // changement d'heure ni au gre du fuseau de la machine.
  return new Date().toISOString().slice(0, 10);
}

function lireCompteur(fichier) {
  try {
    const brut = JSON.parse(readFileSync(fichier, "utf8"));
    return brut && typeof brut === "object" ? brut : {};
  } catch {
    return {};
  }
}

function ecrireCompteur(fichier, data) {
  try {
    mkdirSync(dirname(fichier), { recursive: true });
    writeFileSync(fichier, JSON.stringify(data, null, 2));
  } catch {
    /* non fatal : un compteur qu'on ne sait pas ecrire ne doit pas bloquer un
       push legitime. Le garde s'ouvre, il ne se ferme pas. */
  }
}

function cheminCompteur() {
  const gitDir = racineGit();
  return gitDir ? join(gitDir, "quota-guard.json") : null;
}

/** Combien de pushs deja faits aujourd'hui sur cette branche. */
export function dejaPousse(branche) {
  const f = cheminCompteur();
  if (!f) return 0;
  const data = lireCompteur(f);
  return Number(data?.[jour()]?.[branche] ?? 0);
}

function incrementer(branche) {
  const f = cheminCompteur();
  if (!f) return;
  const data = lireCompteur(f);
  const j = jour();
  /* On ne garde que le jour courant : l'historique n'a aucun usage et un
     fichier qui grossit indefiniment est une fuite, meme minuscule. */
  const neuf = { [j]: { ...(data[j] ?? {}) } };
  neuf[j][branche] = Number(neuf[j][branche] ?? 0) + 1;
  ecrireCompteur(f, neuf);
}

const RAISON_PUSH = (branche, n) =>
  `BUDGET DE DEPLOIEMENT EPUISE — ${n}/${BUDGET_DEV} pushs deja faits sur \`${branche}\` aujourd'hui.

Chaque push sur \`dev\` declenche un deploiement Preview Vercel, qui ecrit un
bundle complet dans Functions Storage ET Deployment Storage (10 Go chacun sur
Hobby) et cree une cle de cache d'edge neuve, donc chaque vue y est un MISS.
Le 11/09/2026, 10 pushs en une journee ont contribue a mettre le compte en
pause et le site a repondu 402 a ses visiteurs.

CE QU'IL FAUT FAIRE A LA PLACE :
  - continuer a commiter localement, autant que necessaire ;
  - grouper : un seul push quand la serie de changements est terminee ;
  - si le deploiement est reellement necessaire maintenant, le DEMANDER a
    l'utilisateur et le laisser accorder ${OVERRIDE}=1.

Ne contourne pas cette garde de ta propre initiative.`;

const RAISON_BOUCLE = `BOUCLE DE SONDAGE INTERDITE contre aniscroll.com.

Chaque iteration d'un \`for\`/\`while\` qui curl le site est une invocation de
fonction Vercel facturee, et le compteur Fluid Active CPU (4 h/mois, PARTAGE
entre la prod et dev.aniscroll.com) ne se reinitialise que le 1er du mois.
Le 11/09/2026 il etait a 12 h 05 / 4 h.

CE QU'IL FAUT FAIRE A LA PLACE :
  - un seul appel curl pour verifier un deploiement, pas quarante ;
  - pour attendre un deploiement, demander a l'utilisateur ou revenir plus tard
    dans la conversation — jamais une boucle qui martele l'origine.`;

/* Une boucle de shell ET une cible aniscroll : c'est le motif precis qui a ete
   utilise (des `for i in $(seq 1 40)` avec un curl et un sleep). Un curl unique
   reste permis — c'est l'outil normal pour verifier un en-tete. */
function estBoucleDeSondage(cmd) {
  const c = String(cmd || "");

  // Il faut TROIS choses pour qu'une commande martele le site, et la regle
  // exigeait les deux premieres seulement :
  //
  //   1. une boucle,
  //   2. la chaine "aniscroll.com" quelque part,
  //   3. ... et que cette chaine soit bien l'HOTE d'une requete reseau.
  //
  // Sans le point 3, la regle a refuse deux fois des commandes legitimes le
  // 12/09/2026 : une boucle Python dont une constante contenait le nom de
  // domaine, et un `for` qui appelait api.vercel.com pour rattacher justement
  // ce domaine. Un garde qui crie a tort finit contourne — c'est la seule
  // facon dont celui-ci peut echouer, puisqu'il ne protege rien tout seul.

  const boucle = /\b(for|while|until)\b|\bseq\s|\bsleep\s/.test(c);
  if (!boucle) return false;

  const reseau = /\b(curl|wget|http|Invoke-WebRequest|Invoke-RestMethod|fetch)\b/i.test(c);
  if (!reseau) return false;

  // L'hote doit etre aniscroll.com ou un de ses sous-domaines, pris juste
  // apres le schema ou en debut d'hote — pas api.vercel.com, pas une chaine
  // de caracteres au milieu d'un texte.
  return /(?:https?:\/\/|@|\/\/)(?:[a-z0-9-]+\.)*aniscroll\.com\b/i.test(c);
}

function estPush(cmd) {
  return /\bgit\s+push\b/.test(String(cmd || ""));
}

function brancheDe(cmd) {
  // `git push origin dev` -> dev. Sans argument, la branche courante.
  const m = String(cmd).match(/\bgit\s+push\b[^\n|;&]*/);
  const mots = (m?.[0] ?? "").trim().split(/\s+/).slice(2).filter((x) => !x.startsWith("-"));
  if (mots.length >= 2) return mots[1].replace(/^.*:/, "");
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function autorise() {
  return process.env[OVERRIDE] === "1";
}

/* ── Les deux points d'entree ──────────────────────────────────────────── */

/** Pour le hook PreToolUse : lit la commande, rend un verdict JSON. */
async function inspect() {
  let brut = "";
  for await (const bloc of process.stdin) brut += bloc;
  let cmd = "";
  try {
    cmd = JSON.parse(brut)?.tool_input?.command ?? "";
  } catch {
    /* Payload illisible : on ne bloque rien. Un garde qui se ferme sur une
       entree qu'il n'a pas comprise casse plus qu'il ne protege. */
  }

  const refuser = (raison) =>
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: raison,
        },
      }),
    );

  if (estBoucleDeSondage(cmd)) return refuser(RAISON_BOUCLE);

  if (estPush(cmd) && !autorise()) {
    const branche = brancheDe(cmd);
    if (BRANCHES_COMPTEES.has(branche)) {
      const n = dejaPousse(branche);
      if (n >= BUDGET_DEV) return refuser(RAISON_PUSH(branche, n));
    }
  }
  // Rien a dire : sortie vide = la commande suit son cours normal.
}

/** Pour `.githooks/pre-push` : compte et refuse. Le gardien reel. */
function checkPush() {
  let branche = "";
  try {
    branche = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    process.exit(0);
  }
  if (!BRANCHES_COMPTEES.has(branche)) process.exit(0);

  if (autorise()) {
    process.stderr.write(`[quota-guard] ${OVERRIDE}=1 — push autorise explicitement.\n`);
    incrementer(branche);
    process.exit(0);
  }

  const n = dejaPousse(branche);
  if (n >= BUDGET_DEV) {
    process.stderr.write(`\n[quota-guard] ${RAISON_PUSH(branche, n)}\n\n`);
    process.exit(1);
  }
  incrementer(branche);
  process.stderr.write(
    `[quota-guard] push ${n + 1}/${BUDGET_DEV} sur ${branche} aujourd'hui.\n`,
  );
  process.exit(0);
}

/** Pour savoir ou on en est sans rien declencher. */
function status() {
  const b = [...BRANCHES_COMPTEES];
  for (const branche of b) {
    const n = dejaPousse(branche);
    process.stdout.write(`${branche} : ${n}/${BUDGET_DEV} pushs aujourd'hui (${jour()} UTC)\n`);
  }
}

const cmd = process.argv[2];
if (cmd === "inspect") await inspect();
else if (cmd === "check-push") checkPush();
else if (cmd === "status") status();
else {
  process.stderr.write("usage: guard.mjs inspect|check-push|status\n");
  process.exit(2);
}
