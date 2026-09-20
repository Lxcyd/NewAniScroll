#!/usr/bin/env node
/**
 * Recopie la liste des animes DOUBLES de MyDubList dans la table `dub_catalog`.
 *
 * MyDubList (https://mydublist.com, CC BY 4.0) agrege MyAnimeList, AniList,
 * Anime News Network, AnimeSchedule, aniSearch, Kitsu et des listes curees pour
 * repondre a une seule question : cet anime a-t-il un doublage dans telle
 * langue ? Les fichiers sont indexes par **id MAL**, celui que le site porte
 * deja (`idMal`).
 *
 * Pourquoi ca valait le detour. Sans cette liste, ouvrir un anime avec l'ordre
 * de langues « VF d'abord » faisait essayer les lecteurs VF l'un apres l'autre
 * sur des series qui n'ont tout simplement jamais ete doublees — une dizaine de
 * secondes pour apprendre une chose que MyDubList sait.
 *
 * Elle sert aussi de JUGE EXTERIEUR a `player_map` : nos propres scores de
 * confiance titre<->slug ne peuvent pas voir qu'un slug pointe vers un autre
 * anime quand il RESSEMBLE au titre. Croisement du 20/09/2026 : 541 des 553
 * lignes VF reellement constatees concordent (97,8 %), et les douze desaccords
 * etaient douze vraies erreurs — dont cinq notees `confidence: 1`.
 *
 * Palier `low` (>= 1 source) et non `normal`/`high` : on s'en sert comme filtre
 * NEGATIF, donc plus le palier est large, moins on declare « pas de doublage »
 * a tort. Un palier strict inverserait le risque.
 *
 * Idempotent, sans etat entre deux executions — fait pour GitHub Actions.
 *
 * Usage :
 *   node scripts/mydublist/sync-dubs.mjs
 *   node scripts/mydublist/sync-dubs.mjs --dry     # n'ecrit rien
 *   node scripts/mydublist/sync-dubs.mjs --force   # passe outre le garde-fou
 *
 * Donnees : MyDubList — https://mydublist.com — CC BY 4.0.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@libsql/client";

const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");
/** En deca de cette part de l'effectif precedent, on refuse d'ecrire. */
const CHUTE_MAX = 0.4;
/** Un fichier de langue plus petit que ca est un symptome, pas une nouvelle. */
const PLANCHER = 200;

/* Les langues qu'on recopie. `french` seule sert aujourd'hui ; la colonne
   `lang` existe pour que l'anglais ou l'espagnol n'exigent pas de migration. */
const LANGUES = (process.env.MYDUBLIST_LANGS || "french").split(",").map((s) => s.trim());
const BASE =
  process.env.MYDUBLIST_BASE ||
  "https://raw.githubusercontent.com/Joelis57/MyDubList/main/dubs/confidence/low";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function listePour(langue) {
  const res = await fetch(`${BASE}/dubbed_${langue}.json`, {
    headers: { Accept: "application/json" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`MyDubList dubbed_${langue} → HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json?.dubbed)) {
    throw new Error(`dubbed_${langue} : reponse inattendue (pas de tableau 'dubbed')`);
  }
  /* Les ids sont des entiers MAL. On filtre defensivement : le README previent
     que des cles non numeriques peuvent apparaitre, et qu'il faut les
     reconnaitre a leur FORME plutot qu'exclure celles qu'on connait. */
  return [...new Set(json.dubbed.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

await db.execute(`
CREATE TABLE IF NOT EXISTS dub_catalog (
  lang        TEXT    NOT NULL,
  mal_id      INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (lang, mal_id)
);`);

const parLangue = new Map();
for (const langue of LANGUES) {
  const ids = await listePour(langue);
  console.log(`[mydublist] ${langue} : ${ids.length} titres doubles`);

  if (ids.length < PLANCHER) {
    console.error(
      `[mydublist] ${langue} : trop peu d'entrees (${ids.length}) — on n'ecrase rien`,
    );
    process.exit(1);
  }

  /* Le plancher ci-dessus ne voit qu'une panne FRANCHE. Il laisse passer le cas
     qui fait vraiment mal : un fichier qui repond, bien forme, mais ampute — un
     champ renomme, un palier de confiance reorganise. 2 572 titres qui tombent
     a 900 passeraient le plancher et declareraient d'un coup que 1 600 series
     n'ont plus de VF, en silence. D'ou une seconde mesure, RELATIVE a ce qui est
     deja en base. Une vraie coupe se debloque a la main (`--force`). */
  const avant = Number(
    (
      await db.execute({
        sql: "SELECT COUNT(*) AS n FROM dub_catalog WHERE lang = ?",
        args: [langue],
      })
    ).rows[0]?.n ?? 0,
  );
  if (avant > 0) {
    const delta = ids.length - avant;
    console.log(
      `[mydublist] ${langue} : effectif precedent ${avant} (${delta >= 0 ? "+" : ""}${delta})`,
    );
  }
  const seuil = Math.floor(avant * CHUTE_MAX);
  if (avant > 0 && ids.length < seuil && !FORCE) {
    console.error(
      `[mydublist] ${langue} : chute suspecte, ${ids.length} contre ${avant} en base ` +
        `(seuil ${seuil}) — on n'ecrase rien. Relancer avec --force si la coupe est reelle.`,
    );
    process.exit(1);
  }

  parLangue.set(langue, ids);
}

if (DRY) {
  console.log("[mydublist] --dry : rien n'est ecrit");
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
for (const [langue, ids] of parLangue) {
  const tx = await db.transaction("write");
  try {
    // Remplacement, pas fusion : un titre retire doit disparaitre.
    await tx.execute({ sql: "DELETE FROM dub_catalog WHERE lang = ?", args: [langue] });
    for (let i = 0; i < ids.length; i += 500) {
      const lot = ids.slice(i, i + 500);
      await tx.execute({
        sql:
          `INSERT OR REPLACE INTO dub_catalog (lang, mal_id, updated_at) VALUES ` +
          lot.map(() => "(?, ?, ?)").join(", "),
        args: lot.flatMap((id) => [langue, id, now]),
      });
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
  console.log(`[mydublist] ${langue} : table remplacee, ${ids.length} lignes`);
}
