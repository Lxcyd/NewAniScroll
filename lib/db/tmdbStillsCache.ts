import { getFanartsClient } from "./turso-fanarts";
import { tableEnsurer } from "./turso";

/**
 * tmdb_stills_cache — per-anime episode still URLs, and the refusals.
 *
 * The TABLE NAME is a fossil and stays one on purpose: it long outlived the
 * provider it was named after, and holds live rows in production. Renaming it
 * would orphan every one of them and re-fetch the whole catalogue for nothing.
 * It is, and always was, a generic stills cache.
 *
 * Shape and failure policy copied from lib/db/seasonCache.ts: the key carries
 * its own version tag, TTL is checked on read, the table is created lazily, and
 * every error is swallowed to null so the caller recomputes rather than serving
 * something wrong.
 *
 * Lives in the fanarts DB (lib/db/turso-fanarts.ts) because it's image data —
 * that module exists to keep image row-reads off the hot metadata path, and
 * episode stills have exactly that profile. It falls back to the main DB when
 * the fanarts env vars are unset.
 *
 * REFUSALS ARE CACHED, and that's the point: a title the provider has no
 * images for would otherwise be re-fetched on every Redis miss. Refusals get a shorter TTL
 * than hits so a provider-side correction can rescue a title within a day.
 * Transient failures (network, rate-limit) must NOT be cached — the caller
 * decides that.
 */

export interface StillsCacheValue {
  /** episode number → full still URL. Empty on a refusal. */
  stills: Record<number, string>;
  /** episode number → title. Absent on rows written before titles shipped and
   *  on leftover TMDB-era rows, so readers must treat it as optional. */
  titles?: Record<number, string>;
  /** Why this is what it is — kept so a bad mapping is diagnosable later.
   *  Free-form; older rows may still carry a TMDB refusal tag. */
  reason: string;
  tvId: number | null;
  season: number | null;
  /** TMDB tient la suite DANS une saison precedente : notre episode 1 est son
   *  episode offset+1. Absent dans le cas normal. */
  offset?: number;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS tmdb_stills_cache (
  cache_key   TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
)`;

export const TTL_HIT_S = 7 * 24 * 60 * 60;
export const TTL_REFUSAL_S = 24 * 60 * 60;
/* UNE LIGNE QUI NE COUVRE PAS TOUT CE QU'ON AFFICHE (20/11/2026) : sur un anime
   en cours, la ligne ecrite la veille d'une sortie n'a pas le nouvel episode,
   ou l'a sans image ni titre (le fournisseur les ajoute quelques heures apres).
   A 7 jours, l'episode restait « Episode 8 » sur fond noir toute la semaine
   (Firefly Wedding S2). Meme fenetre que la liste d'episodes d'un anime en
   cours dans Redis : on ne la relit pas plus souvent qu'elle ne se refait. */
export const TTL_INCOMPLETE_S = 3 * 60 * 60;

/** Un episode affiche (1..displayed) sans image — ou sans titre, quand la
 *  source donne des titres — rend la ligne incomplete. */
function isIncomplete(v: StillsCacheValue, displayed: number | null | undefined): boolean {
  if (!displayed || displayed <= 0) return false;
  // Une serie dont la source ne titre AUCUN episode ne sera jamais « complete ».
  const titled = !!v.titles && Object.keys(v.titles).length > 0;
  for (let n = 1; n <= displayed; n++) {
    if (!v.stills?.[n]) return true;
    if (titled && !v.titles![n]) return true;
  }
  return false;
}

// non-fatal — reads return null and the caller recomputes
const ensureTable = tableEnsurer(CREATE_SQL, getFanartsClient);

/** Stills source. Part of the cache key so no two overwrite each other. */
export type StillsSource = "tmdb" | "anizip";

const KEY_PREFIX: Record<StillsSource, string> = {
  /* v2 depuis le 28/08/2026 : les URL stockees portent la TAILLE (`/w300/`,
     desormais `/w780/`), donc une ligne v1 servirait des vignettes floues
     pendant les 7 jours de son TTL. Le tag de version est la pour ca — les
     lignes v1 restent en base, inertes, plutot qu'un DELETE de masse.
     v3 (29/08) : le garde de coherence Fribb ne refuse plus une saison dont le
     compte d'episodes tombe EXACTEMENT juste. Ce sont les REFUS qui sont en
     cache, et un refus ne se corrige pas tout seul — sans le tag, Gundam et ses
     semblables auraient garde leurs screencaps TVDB. */
  tmdb: "tmdbStills:v3:",
  anizip: "anizipStills:v1:",
  // Il y a eu un prefixe "simklStills:v1:". Simkl est retire (22/08/2026) et
  // plus rien ne l'ecrit ni ne le lit ; ses lignes restent en base, inertes,
  // plutot qu'un DELETE de masse sur une table de production pour recuperer
  // quelques kilo-octets.
};

function keyFor(anilistId: number, source: StillsSource): string {
  return `${KEY_PREFIX[source]}${anilistId}`;
}

/** La ligne en cache : `fresh` si elle est servable telle quelle, sinon
 *  `previous` porte l'ancienne reponse valide (reason "ok") a COMPLETER, jamais
 *  a jeter — voir mergeWithPrevious. Les deux a null sur un manque, une base
 *  absente ou une erreur. */
export async function readCachedStills(
  anilistId: number,
  source: StillsSource,
  displayedEpisodes?: number | null,
): Promise<{ fresh: StillsCacheValue | null; previous: StillsCacheValue | null }> {
  const none = { fresh: null, previous: null };
  const db = getFanartsClient();
  if (!db) return none;
  await ensureTable();
  try {
    const r = await db.execute({
      sql: "SELECT value, updated_at FROM tmdb_stills_cache WHERE cache_key = ? LIMIT 1",
      args: [keyFor(anilistId, source)],
    });
    if (!r.rows.length) return none;
    const row = r.rows[0] as any;
    const parsed = JSON.parse(String(row.value)) as StillsCacheValue;
    // A refusal expires sooner than a hit: it may only be waiting on a Fribb
    // re-ingest or a TMDB fix.
    const ttl =
      parsed.reason !== "ok"
        ? TTL_REFUSAL_S
        : isIncomplete(parsed, displayedEpisodes)
          ? TTL_INCOMPLETE_S
          : TTL_HIT_S;
    const age = Math.floor(Date.now() / 1000) - Number(row.updated_at);
    if (age <= ttl) return { fresh: parsed, previous: null };
    return { fresh: null, previous: parsed.reason === "ok" ? parsed : null };
  } catch {
    return none;
  }
}

/* UNE RELECTURE COMPLETE, ELLE N'EFFACE PAS (20/11/2026). Le fournisseur peut
   perdre une serie qu'il couvrait : ani.zip rend `episodes: {}` pour Koori no
   Jouheki S2 (AniList 213805) alors que la ligne du 15/11 portait les images et
   titres des episodes 1 a 7. Relire cette ligne pour y chercher l'episode 8 ne
   doit pas la remplacer par un refus vide. Le neuf passe devant, l'ancien bouche
   les trous ; s'il n'y a rien de neuf, l'ancienne ligne est reecrite telle
   quelle (son horloge repart, elle sera retentee a la prochaine fenetre). */
export function mergeWithPrevious(
  next: { stills: Record<number, string>; titles?: Record<number, string> },
  previous: StillsCacheValue | null,
): { stills: Record<number, string>; titles?: Record<number, string> } {
  if (!previous) return next;
  const stills = { ...previous.stills, ...next.stills };
  const titles =
    previous.titles || next.titles ? { ...previous.titles, ...next.titles } : undefined;
  return titles ? { stills, titles } : { stills };
}

/** Upsert. Non-fatal on error (the cache is an optimization). */
export async function setCachedStills(
  anilistId: number,
  value: StillsCacheValue,
  source: StillsSource = "tmdb",
): Promise<void> {
  const db = getFanartsClient();
  if (!db) return;
  await ensureTable();
  try {
    await db.execute({
      sql: `INSERT INTO tmdb_stills_cache (cache_key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at`,
      args: [
        keyFor(anilistId, source),
        JSON.stringify(value),
        Math.floor(Date.now() / 1000),
      ],
    });
  } catch {
    /* non-fatal */
  }
}
