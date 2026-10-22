/**
 * « Le PC n'a pas bouge » — verification en une commande.
 *
 *   node tools/browser-check/pc-regression.mjs <ref-base> <test-base> <dossier> [chemin...]
 *   ex. node tools/browser-check/pc-regression.mjs http://localhost:3125 http://localhost:3124 out
 *
 * <ref-base> sert le code de depart (worktree NewAniScroll-ref fige sur le commit
 * de base de la branche mobile), <test-base> la branche en cours. Capture en PC
 * (1440x900) : reference, test, reference encore — puis compare le test aux
 * DEUX references : seul compte un pixel qui differe des deux (le bruit propre
 * a une page, tire au hasard, differe deja entre les deux references).
 *
 * Sortie : la liste des captures qui ont change, et leurs images de diff (pixels
 * changes en rouge) dans <dossier>/diff.
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const ici = dirname(fileURLToPath(import.meta.url));
const [ref, test, dossier, ...chemins] = process.argv.slice(2);
if (!ref || !test || !dossier) {
  console.error("usage : node tools/browser-check/pc-regression.mjs <ref-base> <test-base> <dossier> [chemin...]");
  process.exit(1);
}
const PAGES = chemins.length ? chemins : [
  "/en", "/en/anime/154587", "/en/anime/154587#episodes", "/en/anime/154587#scores",
  "/en/anime/154587#characters", "/en/anime/154587#artworks",
  "/en/anime/watch/154587/frieren?id=animesama-ansembed-154587-1&num=1",
  "/en/discover", "/en/search/anime", "/en/schedule", "/en/my-list", "/en/settings",
  "/en/anime/trending", "/en/anime/popular", "/en/anime/recent", "/en/anime/recently-watched",
  "/en/sources", "/en/about", "/en/dmca", "/en/removed", "/page-inexistante",
  "/reset-password", "/en/profile/me",
];

const env = { ...process.env, BUREAU: "1", TRANCHES: process.env.TRANCHES || "3", ATTENTE_MS: process.env.ATTENTE_MS || "10000" };
const audit = (base, out) => {
  rmSync(out, { recursive: true, force: true });
  spawnSync(process.execPath, [join(ici, "mobile-audit.mjs"), base, out, ...PAGES], { env, stdio: "ignore" });
};
const A = join(dossier, "ref-a"), T = join(dossier, "test"), B = join(dossier, "ref-b");
console.log("capture reference…"); audit(ref, A);
console.log("capture branche…"); audit(test, T);
console.log("capture reference (2)…"); audit(ref, B);
const r = spawnSync(process.execPath, [join(ici, "compare-captures.mjs"), A, T, join(dossier, "diff")], {
  env: { ...process.env, REF2: B }, encoding: "utf8",
});
const lignes = r.stdout.split("\n").filter((l) => l && !l.startsWith("=  "));
console.log(lignes.join("\n"));
