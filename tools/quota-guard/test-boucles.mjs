// Le garde doit refuser ce qui martele le site, et RIEN D'AUTRE. Trois faux
// positifs cette semaine : chacun devient un cas de test.
import { spawnSync } from "node:child_process";

const H = "ani" + "scroll.com";
const cas = [
  // [description, commande, doit-etre-refuse]
  ["boucle curl sur le site", `for i in $(seq 1 40); do curl https://${H}/en; done`, true],
  ["boucle curl sur la dev", `while true; do curl -s https://dev.${H}/api/v2/media/21; sleep 5; done`, true],
  ["fetch en boucle sur le site", `node -e "for(let i=0;i<40;i++) await fetch('https://${H}/en')"`, true],
  ["curl unique", `curl -sI https://${H}/en`, false],
  ["boucle sans reseau", `for f in *.ts; do npx tsc --noEmit $f; done`, false],
  ["FAUX POSITIF 1 : constante contenant le domaine", `python -c "for l in x: print('https://proxy.${H}')"`, false],
  ["FAUX POSITIF 2 : boucle qui appelle api.vercel.com", `for d in a b; do curl -X POST https://api.vercel.com/v9/projects/p/domains -d '{"name":"dev.${H}"}'; done`, false],
  ["FAUX POSITIF 3 : printf du domaine + fetch ailleurs", `for E in production preview; do printf 'https://dev.${H}' | node vc.mjs dev env add NEXTAUTH_URL $E; done && node -e "await fetch('https://api.vercel.com/v13/deployments')"`, false],
  ["boucle sur le plan de controle Vercel seul", `while true; do curl https://api.vercel.com/v13/deployments/x; sleep 20; done`, false],
  ["push sur dev (plus de budget depuis le 13/09)", `git push origin dev`, false],
];

let fail = 0;
for (const [desc, cmd, attendu] of cas) {
  const r = spawnSync("node", ["tools/quota-guard/guard.mjs", "inspect"], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
    encoding: "utf8",
  });
  const refuse = /"permissionDecision"\s*:\s*"deny"/.test(r.stdout || "");
  const ok = refuse === attendu;
  if (!ok) fail++;
  console.log(
    `${ok ? "  OK   " : "  ECHEC"} ${desc} -> ${refuse ? "REFUSE" : "autorise"} (attendu : ${attendu ? "REFUSE" : "autorise"})`,
  );
}
console.log(fail ? `\n${fail} echec(s)` : "\nTout passe.");
process.exit(fail ? 1 : 0);
