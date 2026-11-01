/**
 * Correctifs player_map anime-sama du 01/11/2026 : liens `verified` qui
 * servaient le panneau d'un AUTRE anime (Kenshin 2023 -> serie de 1996,
 * courts SAO/K-ON/Euphonium -> serie principale, Gundam -> Gundam 00, parties
 * 2 servies depuis l'episode 1...). Trouves en croisant le nombre d'episodes
 * AniList et le libelle des saisons de la copie (as_panneau) — hors du champ
 * de tools/anime-sama/parite.mjs, qui ne voit que les saisons alignables.
 *
 * Une cible est ecrite seulement si le panneau existe dans la copie pour la
 * langue de la ligne ; sinon la ligne passe `absent` (30 j) : ne rien servir
 * vaut mieux que servir un autre anime.
 *
 *   node scripts/player-map/correctifs-2026-11-01.mjs [--dry]
 */
import { createClient } from "@libsql/client";
import "dotenv/config";
const dry = process.argv.includes("--dry");
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;

// [aniId, dossier, decalage] ; dossier null = anime-sama ne l'a pas.
const CIBLES = [
  [142877, "saison1hs", 0],   // Rurouni Kenshin 2023 : « Saison 1 Remake », pas la serie de 1996
  [162890, "saison1hs", 0],   // Gintama 3-Z Ginpachi-sensei, pas Gintama saison 1
  [173533, "saison11", 0],    // Monogatari Off & Monster, pas Second Season
  [170166, "saison3", 0],     // Link Click Bridon Arc, pas la saison 3
  [14751, "saison6", 0],      // Sailor Moon Crystal, pas la serie de 1992
  [81, "saison7", 0],         // Gundam 08th MS Team, pas Gundam 00
  [10937, "film3", 0],        // Gundam The Origin (OVA)
  [18097, "saison6", 0],      // Inazuma Eleven GO Galaxy
  [13261, "saison5", 0],      // Inazuma Eleven GO Chrono Stone
  [99539, "saison2", 0],      // Nanatsu no Taizai : Imashime
  [108928, "saison3", 0],     // Nanatsu no Taizai : Kamigami
  [116752, "saison4", 0],     // Nanatsu no Taizai : Funnu
  [20996, "saison7", 0],      // Gintama° = ep. 266-316
  [15417, "saison6", 0],      // Gintama' Enchousen = ep. 253-265
  [99714, "saison8", 12],     // Gintama. Porori-hen = ep. 329-341
  [101925, "saison8", 37],    // Gintama. Shirogane Kouhan = ep. 354-367
  [21356, "saison19", 0],     // Pokemon XY&Z = saison 19 chez eux
  [119661, "saison2", 13],    // Re:Zero S2 partie 2
  [114308, "saison4", 12],    // SAO War of Underworld partie 2
  [146722, "saison6", 12],    // JoJo Stone Ocean partie 2
  [20799, "saison3", 24],     // JoJo Stardust Crusaders Egypte
  [1253, "saison2", 13],      // Saint Seiya Hades Inferno
  [116741, "saison1hs", 0],   // Slime Diaries
  [120150, "saison1hs", 0],   // Bungou Stray Dogs Wan!, pas la serie
  ...[101, 140005, 16099, 20628, 2819, 97919, 158988, 102427, 114448, 3515, 9203, 21255,
    21053, 19029, 6330, 155017, 10119, 665, 108039, 5723, 158870].map((id) => [id, null, 0]),
  // AIR->Air Gear, Conan Hanzawa->Conan, Sword Art Offline->SAO, LoGH Neue These->1988,
  // Dragon Warrior 1989->Dai 2020, Saintia Sho->Omega, KotZ x3->Lost Canvas, Hades Elysion,
  // K-ON/Euphonium/Amagi/Yuyushiki/Shana/Petit Clover shorts, SYD OVA, JoJo 2000,
  // Gundam Origin TV/Uchuu Seiki Yowa, Pokemon Mezase.
];

const now = Date.now();
for (const [id, dossier, dec] of CIBLES) {
  for (const r of await q("SELECT lang, slug, season_dir, ep_offset FROM player_map WHERE ani_id=? AND source='animesama' AND status='verified'", [id])) {
    const langs = r.lang === "vf" ? ["vf", "vf1", "vf2"] : ["vostfr"];
    const p = dossier && (await q(`SELECT max(nb_ep) n FROM as_panneau WHERE slug=? AND dossier=? AND langue IN (${langs.map(() => "?").join(",")})`, [r.slug, dossier, ...langs]))[0];
    if (dossier && r.season_dir === dossier && r.ep_offset === dec) continue; // deja fait
    const ok = dossier && p?.n > dec;
    const avant = `${r.slug}/${r.season_dir}+${r.ep_offset}`;
    if (ok) {
      console.log(`${id} ${r.lang} ${avant} -> ${dossier}+${dec}`);
      if (!dry) await q("UPDATE player_map SET season_dir=?, ep_offset=?, note=?, checked_at=? WHERE ani_id=? AND source='animesama' AND lang=?",
        [dossier, dec, `manuel 01/11/2026 : etait ${avant}`, now, id, r.lang]);
    } else {
      console.log(`${id} ${r.lang} ${avant} -> absent${dossier ? ` (${dossier} introuvable en ${r.lang})` : ""}`);
      if (!dry) await q("UPDATE player_map SET status='absent', note=?, checked_at=?, expires_at=? WHERE ani_id=? AND source='animesama' AND lang=?",
        [`manuel 01/11/2026 : servait ${avant}, le panneau d'un autre anime`, now, now + 30 * 86400000, id, r.lang]);
    }
  }
}
