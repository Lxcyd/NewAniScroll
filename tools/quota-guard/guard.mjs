#!/usr/bin/env node
/**
 * Le garde-fou de quota Vercel — hook PreToolUse de Claude Code.
 *
 * POURQUOI CE FICHIER EXISTE — 11/09/2026, le compte Vercel est passe en pause,
 * le site a repondu 402 a tous ses visiteurs, et il a fallu supprimer plus de
 * 380 deploiements a la main.
 *
 * Il ne refuse plus qu'UNE chose : les boucles de sondage contre le site.
 *
 * Le budget de 3 pushs/jour sur `dev` a ete retire le 13/09/2026, a la demande
 * de l'utilisateur. Ce qui protege le stockage aujourd'hui, sans compter les
 * pushs :
 *   - dev vit sur son PROPRE compte Vercel depuis le 12/09 (tools/vercel/) :
 *     ses deploiements ne pesent plus sur le quota de la prod ;
 *   - tools/quota-guard/should-build.sh annule les previews et les commits sans
 *     effet sur le site (un build annule n'ecrit aucun bundle) ;
 *   - la politique de retention reglee dans chaque projet efface les anciens
 *     deploiements.
 */

const RAISON_BOUCLE = `BOUCLE DE SONDAGE INTERDITE contre aniscroll.com.

Chaque iteration d'un \`for\`/\`while\` qui curl le site est une invocation de
fonction Vercel facturee, et le compteur Fluid Active CPU (4 h/mois) ne se
reinitialise que le 1er du mois. Le 11/09/2026 il etait a 12 h 05 / 4 h.

CE QU'IL FAUT FAIRE A LA PLACE :
  - un seul appel curl pour verifier un deploiement, pas quarante ;
  - pour attendre un deploiement, demander a l'utilisateur ou revenir plus tard
    dans la conversation — jamais une boucle qui martele l'origine.`;

/* Une boucle de shell ET une cible aniscroll : c'est le motif precis qui a ete
   utilise (des `for i in $(seq 1 40)` avec un curl et un sleep). Un curl unique
   reste permis — c'est l'outil normal pour verifier un en-tete. */
export function estBoucleDeSondage(cmd) {
  const c = String(cmd || "");

  // Il faut TROIS choses pour qu'une commande martele le site :
  //
  //   1. une boucle,
  //   2. la chaine "aniscroll.com" quelque part,
  //   3. ... et que cette chaine soit bien l'HOTE d'une requete reseau.
  //
  // Sans le point 3, la regle a refuse deux fois des commandes legitimes le
  // 12/09/2026 : une boucle Python dont une constante contenait le nom de
  // domaine, et un `for` qui appelait api.vercel.com pour rattacher justement
  // ce domaine. Un garde qui crie a tort finit contourne.

  const boucle = /\b(for|while|until)\b|\bseq\s|\bsleep\s/.test(c);
  if (!boucle) return false;

  // CORRECTIF DU 13/09/2026. Les points 2 et 3 etaient verifies SEPAREMENT :
  // une commande qui posait NEXTAUTH_URL=https://dev.aniscroll.com dans une
  // boucle ET appelait api.vercel.com plus loin cochait les trois cases sans
  // jamais toucher au site. On exige desormais que l'hote aniscroll.com
  // apparaisse DANS la portee d'un appel reseau.
  const HOTE = /(?:https?:\/\/|@|\/\/)(?:[a-z0-9-]+\.)*aniscroll\.com\b/i;
  const VERBE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|fetch)\b/gi;
  const PORTEE = 200; // caracteres apres le verbe : de quoi couvrir l'URL

  let m;
  while ((m = VERBE.exec(c)) !== null) {
    if (HOTE.test(c.slice(m.index, m.index + PORTEE))) return true;
  }
  return false;
}

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

  if (estBoucleDeSondage(cmd)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: RAISON_BOUCLE,
        },
      }),
    );
  }
  // Rien a dire : sortie vide = la commande suit son cours normal.
}

if (process.argv[2] === "inspect") await inspect();
else {
  process.stderr.write("usage: guard.mjs inspect\n");
  process.exit(2);
}
