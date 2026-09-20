import { getTursoClient } from "./turso";

/**
 * player_map — the VERIFIED source-of-truth for player resolution.
 *
 * One row per (aniId, source, lang) holding the resolved slug / season panel /
 * merged-list offset, plus a verification status. The watch-time resolver
 * (pages/api/v2/source) reads this FIRST:
 *
 *   verified  → trust it: go straight to the episode listing (1 upstream call
 *               instead of search + N probes + detail page). Cannot serve the
 *               wrong anime/season: the row was checked (episode count + title
 *               confidence) before being promoted.
 *   heuristic → best-effort mapping written back by the resolver after a
 *               runtime resolution. Served (it's what we'd compute anyway) but
 *               queued for verification by scripts/verify-player-map.mjs.
 *   broken    → resolution exists but verification FAILED (count mismatch,
 *               dead panel…). The resolver skips the source instead of serving
 *               wrong content. Retried on a short TTL.
 *   absent    → the source genuinely doesn't carry this anime/lang. Resolver
 *               skips instantly — no wasted worker probes, and the UI shows an
 *               honest "unavailable" instead of a dead chip.
 *
 * Why a table and not the in-process Maps the resolver always had: Vercel
 * lambdas are ephemeral — every cold start re-derived every mapping from
 * scratch (worker-hungry, and each re-derivation was a fresh chance to guess
 * wrong). The map makes a correct resolution PERMANENT until something
 * (verification, a user report, a TTL) actively challenges it.
 */

export type PlayerMapStatus = "verified" | "heuristic" | "broken" | "absent";
export type PlayerSource = "animesama" | "voiranime";
export type PlayerLang = "vostfr" | "vf";

export interface PlayerMapRow {
  aniId: number;
  source: PlayerSource;
  lang: PlayerLang;
  status: PlayerMapStatus;
  slug: string | null;
  seasonDir: string | null;     // anime-sama panel dir (saison2, film…) — null for voiranime
  epOffset: number;             // merged-panel episode offset (0 = none)
  episodeCount: number | null;  // canonical count observed at check time
  confidence: number | null;    // slugTitleConfidence at write time (0..1)
  failCount: number;            // consecutive failures / user reports
  note: string | null;          // classifier verdict or demotion reason
  algoVersion: number;          // season-resolution algo version at write time
  checkedAt: number;            // epoch seconds
  expiresAt: number;            // re-verification deadline (epoch seconds)
}

const HOUR = 3600;
const DAY = 86400;

/**
 * Season-resolution algorithm version. Bumped when the season-numbering /
 * panel-selection logic changes in a way that could invalidate previously
 * written HEURISTIC mappings (which encode a season→slug guess). A heuristic
 * row written under an older version is ignored on read (forcing a fresh
 * resolution) rather than trusted. `verified` rows — checked by
 * scripts/verify-player-map.mjs — are always honoured regardless of version.
 *
 * v2: multi-signal season resolver (Fribb + air-year guards) replaced the pure
 *     PREQUEL/SEQUEL walk, which mis-picked panels for remakes / mislabeled
 *     franchises (SNK "wrong episode" class).
 */
export const SEASON_ALGO_VERSION = 2;

/**
 * Re-verification TTL. RELEASING anime gain episodes/seasons, so their rows go
 * stale fast; a verified FINISHED mapping is essentially permanent (slugs only
 * change when a source restructures, which `broken` demotion self-heals).
 */
export function playerMapTtl(status: PlayerMapStatus, animeStatus?: string | null): number {
  switch (status) {
    case "verified":
      return animeStatus === "RELEASING" ? 7 * DAY : 90 * DAY;
    case "heuristic":
      return 14 * DAY;  // serve meanwhile; verifier should pass before this
    case "broken":
      return 7 * DAY;   // retry weekly — sources fix/restore panels
    case "absent":
      return 30 * DAY;  // catalogues grow; recheck monthly
    default:
      return 7 * DAY;
  }
}

export const PLAYER_MAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS player_map (
  ani_id        INTEGER NOT NULL,
  source        TEXT    NOT NULL,
  lang          TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  slug          TEXT,
  season_dir    TEXT,
  ep_offset     INTEGER NOT NULL DEFAULT 0,
  episode_count INTEGER,
  confidence    REAL,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  checked_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  PRIMARY KEY (ani_id, source, lang)
);
CREATE INDEX IF NOT EXISTS idx_player_map_status  ON player_map(status);
CREATE INDEX IF NOT EXISTS idx_player_map_expires ON player_map(expires_at);
`;

function rowFromDb(r: any): PlayerMapRow {
  return {
    aniId: Number(r.ani_id),
    source: r.source as PlayerSource,
    lang: r.lang as PlayerLang,
    status: r.status as PlayerMapStatus,
    slug: r.slug ?? null,
    seasonDir: r.season_dir ?? null,
    epOffset: Number(r.ep_offset ?? 0),
    episodeCount: r.episode_count == null ? null : Number(r.episode_count),
    confidence: r.confidence == null ? null : Number(r.confidence),
    failCount: Number(r.fail_count ?? 0),
    note: r.note ?? null,
    algoVersion: Number(r.algo_version ?? 0),
    checkedAt: Number(r.checked_at),
    expiresAt: Number(r.expires_at),
  };
}

/* In-process memo so a hot lambda doesn't hit Turso for every chip probe of the
   same anime (a watch page fires several server probes at once). Tiny TTL —
   the lambda itself is short-lived anyway. */
const memo = new Map<string, { t: number; rows: PlayerMapRow[] }>();
const MEMO_TTL_MS = 5 * 60 * 1000;
const memoKey = (aniId: number) => String(aniId);

/* Defensive migration: `algo_version` was added after the table shipped, so an
   existing deployment's player_map won't have the column and the upsert (which
   references it) would fail. Add it once per process; ignore the "duplicate
   column" error when it already exists. Reads tolerate its absence via
   rowFromDb's `?? 0` default. */
let algoColEnsured = false;
async function ensureAlgoVersionColumn(): Promise<void> {
  if (algoColEnsured) return;
  const db = getTursoClient();
  if (!db) return;
  try {
    await db.execute(
      "ALTER TABLE player_map ADD COLUMN algo_version INTEGER NOT NULL DEFAULT 0"
    );
  } catch {
    /* already exists (or table missing) — either way, nothing to do */
  }
  algoColEnsured = true;
}

/* Le memo ne se pose qu'une fois la requete revenue : deux appels rapproches
   partaient donc tous les deux vers Turso. C'est exactement ce que fait la
   route /api/v2/source depuis qu'elle lance cette lecture en meme temps que la
   resolution du titre. Un registre des vols en cours suffit. */
const enVol = new Map<string, Promise<PlayerMapRow[]>>();

/** All map rows for one anime (covers both sources × both langs in one read). */
export async function getPlayerMap(aniId: number): Promise<PlayerMapRow[]> {
  const hit = memo.get(memoKey(aniId));
  if (hit && Date.now() - hit.t < MEMO_TTL_MS) return hit.rows;
  const deja = enVol.get(memoKey(aniId));
  if (deja) return deja;

  const db = getTursoClient();
  if (!db) return [];
  const p = (async () => {
    try {
      const r = await db.execute({
        sql: "SELECT * FROM player_map WHERE ani_id = ?",
        args: [aniId],
      });
      const rows = r.rows.map(rowFromDb);
      memo.set(memoKey(aniId), { t: Date.now(), rows });
      if (memo.size > 2000) memo.clear(); // crude bound; lambdas are short-lived
      return rows;
    } catch (e: any) {
      console.warn("[player-map] read failed:", e?.message);
      return [];
    } finally {
      enVol.delete(memoKey(aniId));
    }
  })();
  enVol.set(memoKey(aniId), p);
  return p;
}

/** One entry, or null. */
export async function getPlayerMapEntry(
  aniId: number,
  source: PlayerSource,
  lang: PlayerLang,
): Promise<PlayerMapRow | null> {
  const rows = await getPlayerMap(aniId);
  const row = rows.find((r) => r.source === source && r.lang === lang) ?? null;
  if (!row) return null;
  // Ignore a HEURISTIC row written under an older season-resolution algorithm:
  // its season→slug guess may be wrong under the new numbering. Returning null
  // forces the resolver to recompute (and rewrite it at the current version).
  // verified/broken/absent are human/verifier-owned states — always honoured.
  if (row.status === "heuristic" && row.algoVersion < SEASON_ALGO_VERSION) {
    return null;
  }
  return row;
}

export interface UpsertPlayerMapInput {
  aniId: number;
  source: PlayerSource;
  lang: PlayerLang;
  status: PlayerMapStatus;
  slug?: string | null;
  seasonDir?: string | null;
  epOffset?: number;
  episodeCount?: number | null;
  confidence?: number | null;
  failCount?: number;
  note?: string | null;
  /** AniList status, used only to pick the TTL for verified rows. */
  animeStatus?: string | null;
}

export async function upsertPlayerMap(input: UpsertPlayerMapInput): Promise<void> {
  const db = getTursoClient();
  if (!db) return;
  await ensureAlgoVersionColumn();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + playerMapTtl(input.status, input.animeStatus);
  try {
    await db.execute({
      sql: `INSERT INTO player_map
              (ani_id, source, lang, status, slug, season_dir, ep_offset,
               episode_count, confidence, fail_count, note, algo_version,
               checked_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ani_id, source, lang) DO UPDATE SET
              status        = excluded.status,
              slug          = excluded.slug,
              season_dir    = excluded.season_dir,
              ep_offset     = excluded.ep_offset,
              episode_count = excluded.episode_count,
              confidence    = excluded.confidence,
              fail_count    = excluded.fail_count,
              note          = excluded.note,
              algo_version  = excluded.algo_version,
              checked_at    = excluded.checked_at,
              expires_at    = excluded.expires_at`,
      args: [
        input.aniId,
        input.source,
        input.lang,
        input.status,
        input.slug ?? null,
        input.seasonDir ?? null,
        input.epOffset ?? 0,
        input.episodeCount ?? null,
        input.confidence ?? null,
        input.failCount ?? 0,
        input.note ?? null,
        SEASON_ALGO_VERSION,
        now,
        expiresAt,
      ],
    });
    memo.delete(memoKey(input.aniId));
  } catch (e: any) {
    console.warn("[player-map] upsert failed:", e?.message);
  }
}

/**
 * Flag a mapping after a runtime failure or a user report: bumps fail_count and
 * forces re-verification (expires immediately). Three strikes demote a
 * `verified` row to `broken` so we stop serving something users say is wrong —
 * the verifier then re-derives it from scratch.
 *
 * `proven` distingue un SOUPCON d'une PREUVE, et les deux ne meritent pas le
 * meme traitement.
 *
 * Un echec d'execution est bruite : le CDN coupe, l'hote a un hoquet, l'upload
 * de la semaine manque. Trois coups avant de retrograder est le bon reglage
 * pour ce signal-la, et il ne bouge pas.
 *
 * Une incoherence de saison n'est pas un soupcon : le resolveur vient de
 * CALCULER que le panneau mappe designe une autre saison que celle de cet
 * anime. Attendre deux visites de plus n'apporte aucune information — et sur un
 * titre que personne n'ouvre, elles n'arrivent jamais. Au 20/09/2026, onze
 * lignes portaient une note `season mismatch` en etant toujours `verified`,
 * bloquees a `fail_count` 1 ou 2 : chaque visite contournait la ligne, re-payait
 * `detectSeasonNumber` et repartait sur le chemin long, sans jamais converger.
 *
 * Sur preuve on retrograde donc tout de suite en `heuristic` — pas en `broken` :
 * la ligne n'est pas morte, elle est perimee. Et on remet `algo_version` a 0
 * pour que la garde de lecture la neutralise jusqu'a ce que le resolveur la
 * reecrive a la version du jour. C'est le chemin d'auto-reparation.
 */
export async function flagPlayerMap(
  aniId: number,
  source: PlayerSource,
  lang: PlayerLang,
  reason: string,
  proven = false,
): Promise<void> {
  const db = getTursoClient();
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.execute({
      sql: proven
        ? `UPDATE player_map SET
              fail_count   = fail_count + 1,
              note         = ?,
              expires_at   = ?,
              status       = CASE WHEN status = 'verified' THEN 'heuristic'
                                  ELSE status END,
              algo_version = 0
            WHERE ani_id = ? AND source = ? AND lang = ?`
        : `UPDATE player_map SET
              fail_count = fail_count + 1,
              note       = ?,
              expires_at = ?,
              status     = CASE
                             WHEN fail_count + 1 >= 3 AND status = 'verified'
                             THEN 'broken' ELSE status
                           END
            WHERE ani_id = ? AND source = ? AND lang = ?`,
      args: [reason, now, aniId, source, lang],
    });
    memo.delete(memoKey(aniId));
  } catch (e: any) {
    console.warn("[player-map] flag failed:", e?.message);
  }
}

/** Rows needing (re-)verification, oldest deadline first. */
export async function getStalePlayerMap(limit = 200): Promise<PlayerMapRow[]> {
  const db = getTursoClient();
  if (!db) return [];
  const now = Math.floor(Date.now() / 1000);
  try {
    const r = await db.execute({
      sql: `SELECT * FROM player_map
             WHERE expires_at < ? OR status = 'heuristic'
             ORDER BY expires_at ASC
             LIMIT ?`,
      args: [now, limit],
    });
    return r.rows.map(rowFromDb);
  } catch (e: any) {
    console.warn("[player-map] stale read failed:", e?.message);
    return [];
  }
}
