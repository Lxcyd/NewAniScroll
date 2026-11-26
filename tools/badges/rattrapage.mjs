/**
 * LE RATTRAPAGE QUOTIDIEN DES BADGES des comptes liés à AniList qui ne
 * reviennent pas (26/11/2026, Luc : « tu as fix pour pas que ça se
 * reproduise ? »).
 *
 *   node tools/badges/check-catalog.mjs        # compile les règles (obligatoire)
 *   node tools/badges/rattrapage.mjs [--jours=1] [--dry]
 *
 * Les badges ne se calculent que dans le navigateur du membre. Un compte lié
 * dont le propriétaire ne revient pas n'en gagnait jamais : Kuraryn, 16 283
 * épisodes, 1 badge. Pour chaque compte lié pas vu depuis `--jours` (1 par
 * défaut : un membre actif, son navigateur s'en charge, et on ne court pas
 * contre lui), on lance `audit-compte.mjs --ecrire` — ajout seulement, sans
 * date, mêmes règles que le navigateur. Deux fois : `legendary-5` compte les
 * badges obtenus, il ne devient atteignable qu'après le premier passage.
 *
 * Le fil AniList (dates, heures) se met à jour avant, par
 * tools/anilist-feed/backfill.mjs (même workflow).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const JOURS = Number(args.jours ?? 1);

const env = existsSync(join(ROOT, ".env"))
  ? Object.fromEntries(
      readFileSync(join(ROOT, ".env"), "utf8")
        .split(/\r?\n/)
        .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
    )
  : process.env;
const { createClient } = createRequire(join(ROOT, "package.json"))("@libsql/client");
const db = createClient({ url: env.TURSO_USERS_URL, authToken: env.TURSO_USERS_TOKEN });

const avant = Date.now() - JOURS * 86400_000;
const comptes = (
  await db.execute({
    sql: `SELECT anilist_name FROM users
           WHERE anilist_id IS NOT NULL AND anilist_name IS NOT NULL
             AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    args: [avant],
  })
).rows.map((r) => String(r.anilist_name));

console.log(`${comptes.length} compte(s) lié(s) pas vu(s) depuis ${JOURS} j : ${comptes.join(", ") || "aucun"}`);
let echecs = 0;
for (const nom of comptes) {
  for (let passe = 0; passe < 2; passe++) {
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "tools", "badges", "audit-compte.mjs"), `--user=${nom}`, ...(args.dry ? [] : ["--ecrire"])],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );
    const fin = (r.stdout ?? "").trim().split("\n").pop();
    if (r.status !== 0) {
      echecs++;
      console.log(`  ✘ ${nom} : ${(r.stderr ?? "").trim().split("\n").pop()}`);
      break;
    }
    console.log(`  ${nom} (passe ${passe + 1}) : ${fin}`);
    if (args.dry || /rien à accorder/.test(fin)) break;
  }
}
process.exit(echecs ? 1 : 0);
