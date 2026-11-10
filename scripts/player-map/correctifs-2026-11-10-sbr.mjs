/**
 * Steel Ball Run cote anime-sama (10/11/2026) : AniList coupe la serie en deux
 * fiches, 190327 « 1st STAGE » (1 ep de 47 min, 19/03) et 210482 « 2nd & 3rd
 * STAGE » (depuis le 25/09). anime-sama les FUSIONNE dans
 * `jojos-bizarre-adventure/saison7` : son ep 1 est le 1st STAGE (48,7 min
 * mesures, l'ep 2 en fait 25). Le site servait 210482 depuis saison7 sans
 * decalage : chaque episode etait le precedent.
 *
 * L'alignement (tools/anime-sama) ne peut pas le poser : la fiche JoJo casse
 * des saison1. D'ou une ligne `manuel`, que la garde de saison du site et le
 * verificateur de nuit laissent en place.
 *
 *   node scripts/player-map/correctifs-2026-11-10-sbr.mjs          essai (n'ecrit rien)
 *   node scripts/player-map/correctifs-2026-11-10-sbr.mjs --ecrire
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";
import "dotenv/config";

const ecrire = process.argv.includes("--ecrire");
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const ALGO = Number(fs.readFileSync(new URL("../../lib/db/playerMap.ts", import.meta.url), "utf8").match(/SEASON_ALGO_VERSION\s*=\s*(\d+)/)[1]);

const SLUG = "jojos-bizarre-adventure";
const DOSSIER = "saison7";
const NOTE = "manuel 10/11/2026 : SBR, 1st + 2nd STAGE fusionnes dans saison7";
// [aniId, decalage]
const CIBLES = [[190327, 0], [210482, 1]];

const now = Math.floor(Date.now() / 1000);
const expire = now + 365 * 86400;
for (const [id, dec] of CIBLES) {
  for (const lang of ["vostfr", "vf"]) {
    const langs = lang === "vf" ? ["vf", "vf1", "vf2"] : ["vostfr"];
    const [p] = await q(
      `SELECT max(nb_ep) n FROM as_panneau WHERE slug=? AND dossier=? AND langue IN (${langs.map(() => "?").join(",")})`,
      [SLUG, DOSSIER, ...langs],
    );
    if (!(p?.n > dec)) {
      console.log(`${id} ${lang} : ${DOSSIER} absent ou trop court dans la copie (${p?.n ?? 0} ep) — rien`);
      continue;
    }
    const [avant] = await q("SELECT status, slug, season_dir, ep_offset, note FROM player_map WHERE ani_id=? AND source='animesama' AND lang=?", [id, lang]);
    console.log(`${id} ${lang} : ${avant ? `${avant.status} ${avant.slug}/${avant.season_dir}+${avant.ep_offset}` : "aucune ligne"} -> verified ${SLUG}/${DOSSIER}+${dec} (copie : ${p.n} ep)`);
    if (!ecrire) continue;
    await q(
      `INSERT INTO player_map (ani_id, source, lang, status, slug, season_dir, ep_offset, episode_count, confidence, fail_count, note, algo_version, checked_at, expires_at)
       VALUES (?, 'animesama', ?, 'verified', ?, ?, ?, NULL, 1, 0, ?, ?, ?, ?)
       ON CONFLICT(ani_id, source, lang) DO UPDATE SET status='verified', slug=excluded.slug, season_dir=excluded.season_dir,
         ep_offset=excluded.ep_offset, episode_count=NULL, confidence=1, fail_count=0, note=excluded.note,
         algo_version=excluded.algo_version, checked_at=excluded.checked_at, expires_at=excluded.expires_at`,
      [id, lang, SLUG, DOSSIER, dec, NOTE, ALGO, now, expire],
    );
  }
}
if (!ecrire) console.log("\nessai : rien n'est ecrit (--ecrire pour appliquer)");
