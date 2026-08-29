import { getTursoClient } from "./turso";

/**
 * server_perf — le classement des lecteurs, AGREGE sur tous les visiteurs.
 *
 * Ce qui existait : `lib/watch/serverPerf.ts` mesure quatre criteres par hote
 * et les garde en localStorage. Excellent pour l'appareil qui a mesure, inutile
 * pour tous les autres — un nouveau visiteur repart du rang `speed` ecrit a la
 * main dans lib/servers.js, qui est faux au moins une fois (uqload y est
 * dernier alors qu'il seek plus vite que la plupart) et qui ne suit pas les
 * hotes quand ils se degradent.
 *
 * Cette table est le chainon manquant : ce que les visiteurs mesurent alimente
 * le PRIOR de ceux qui arrivent. Trois etages, du plus faible au plus fort :
 *
 *     `speed` (ecrit a la main)  →  cette table  →  les mesures locales
 *
 * Chaque etage ne sert que la ou le suivant n'a rien a dire. Un appareil qui a
 * ses propres mesures continue donc de decider seul : le partage ne dilue
 * jamais une observation directe.
 *
 * COUT. Une ligne par (hote, critere), soit ~55 lignes au total, jamais plus —
 * ce n'est pas un journal, c'est un agregat mis a jour en place. La lecture
 * passe par une route mise en cache d'edge une heure, donc quasi aucun appel
 * n'atteint la base ; l'ecriture est ECHANTILLONNEE cote client (voir
 * SHARE_PROBABILITY) pour ne pas payer une ecriture par visionnage. Le site est
 * deja surveille de pres cote quotas, ceci ne doit pas y peser.
 *
 * CONFIANCE. Le POST n'est pas authentifie, donc n'importe qui peut poster un
 * nombre. Deux garde-fous, et ils suffisent au regard de l'enjeu : les valeurs
 * hors bornes sont refusees, et la moyenne mobile avance a pas tres court
 * (ALPHA). Empoisonner le classement demanderait des milliers d'envois
 * coherents pour, au pire, mettre un lecteur qui marche en troisieme position
 * au lieu de la premiere. Rien de ce qui compte n'en depend — l'ordre des
 * chips est un confort, pas une regle de securite.
 */

/** Les criteres, en accord avec `Crit` de lib/watch/serverPerf.ts. */
export const CRITERES = ["t", "s", "b", "k", "q"] as const;
export type CritPartage = (typeof CRITERES)[number];

/** Memes bornes de saisie que le module client — un envoi hors bornes est du
 *  bruit ou une falsification, dans les deux cas on n'en veut pas. */
const BORNES: Record<CritPartage, [number, number]> = {
  t: [1, 15000],
  s: [0, 60],
  b: [200, 45000],
  k: [1, 10000],
  q: [0, 4320],
};

/**
 * Pas de la moyenne mobile GLOBALE. Tres court devant celui du client (0,3) :
 * ici la population est grande, et un visiteur seul — reseau encombre, machine
 * lente, ou malveillant — ne doit pas deplacer le verdict de tout le monde.
 */
const ALPHA = 0.05;

export type LignePerf = { ewma: number; n: number };
export type PerfPartagee = Record<string, Partial<Record<CritPartage, LignePerf>>>;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS server_perf (
  server_id  TEXT    NOT NULL,
  crit       TEXT    NOT NULL,
  ewma       REAL    NOT NULL,
  n          INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, crit)
)`;

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  const db = getTursoClient();
  if (!db) return;
  try {
    await db.execute(CREATE_SQL);
    ensured = true;
  } catch {
    /* non fatal — la lecture rend {} et le client garde son prior statique */
  }
}

export function estCritValide(c: unknown): c is CritPartage {
  return typeof c === "string" && (CRITERES as readonly string[]).includes(c);
}

export function estValeurPlausible(c: CritPartage, v: unknown): v is number {
  const n = Number(v);
  if (!Number.isFinite(n)) return false;
  const [lo, hi] = BORNES[c];
  return n >= lo && n <= hi;
}

/**
 * Tout l'agregat. ~55 lignes, une seule requete, aucun filtre : c'est plus
 * simple ET moins cher que de demander un sous-ensemble, et la route qui
 * l'expose est de toute facon mise en cache.
 * Rend {} sur base absente ou erreur — l'appelant garde son prior statique.
 */
export async function lirePerfPartagee(): Promise<PerfPartagee> {
  const db = getTursoClient();
  if (!db) return {};
  await ensureTable();
  try {
    const r = await db.execute(
      `SELECT server_id, crit, ewma, n FROM server_perf`,
    );
    const out: PerfPartagee = {};
    for (const row of r.rows) {
      const id = String(row.server_id);
      const c = String(row.crit);
      if (!estCritValide(c)) continue;
      (out[id] ||= {})[c] = { ewma: Number(row.ewma), n: Number(row.n) };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Replie les mesures d'UNE session dans l'agregat.
 *
 * La moyenne mobile est calculee EN SQL plutot que lue puis reecrite : deux
 * visiteurs qui deposent en meme temps perdraient sinon l'une des deux
 * contributions, et rien ici ne merite une transaction.
 */
export async function ajouterMesures(
  serverId: string,
  mesures: Partial<Record<CritPartage, number>>,
): Promise<boolean> {
  const db = getTursoClient();
  if (!db) return false;
  await ensureTable();
  const maintenant = Math.floor(Date.now() / 1000);
  const lots = [];
  for (const c of CRITERES) {
    const v = mesures[c];
    if (v === undefined || !estValeurPlausible(c, v)) continue;
    lots.push({
      sql: `INSERT INTO server_perf (server_id, crit, ewma, n, updated_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(server_id, crit) DO UPDATE SET
              ewma = server_perf.ewma + ? * (excluded.ewma - server_perf.ewma),
              n = server_perf.n + 1,
              updated_at = excluded.updated_at`,
      args: [serverId, c, Number(v), maintenant, ALPHA],
    });
  }
  if (!lots.length) return false;
  try {
    await db.batch(lots, "write");
    return true;
  } catch {
    return false;
  }
}
