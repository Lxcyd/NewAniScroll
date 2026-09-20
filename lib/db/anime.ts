import { getTursoClient } from "./turso";

/**
 * Anime cache — read/write helpers around the `anime` Turso table.
 *
 * The `data` column stores a JSON blob with the full Tier-1 payload (titles,
 * description, images, relations, studios, …). Hot fields are mirrored into
 * dedicated columns so cron jobs and discovery queries can index them.
 *
 * TTL strategy (drives `expires_at`):
 *   RELEASING        → 1 hour      (episode counts, score change fast)
 *   NOT_YET_RELEASED → 24 hours    (release date can shift)
 *   FINISHED         → 30 days     (description/cover edited rarely)
 *   CANCELLED|HIATUS → 7 days
 *   default          → 7 days
 *
 * Reads always succeed if a row exists, regardless of `expires_at`. The caller
 * decides whether the data is fresh enough or needs a background refresh
 * (stale-while-revalidate). This way an AniList outage still serves data.
 */

export type AnimeStatus =
  | "RELEASING"
  | "NOT_YET_RELEASED"
  | "FINISHED"
  | "CANCELLED"
  | "HIATUS";

export interface CachedAnime {
  id: number;
  data: any;                      // The Tier-1 JSON payload (Media object)
  status: AnimeStatus | null;
  lastFetchedAt: number;          // epoch seconds
  expiresAt: number;              // epoch seconds
  isStale: boolean;               // expires_at < now
}

const HOUR = 3600;
const DAY = 86400;

/* Throttle the last_accessed_at write: this column only feeds the cron's
   "refresh user-visible rows first" ordering, so day-granularity is more
   than enough. The Map tracks the epoch-day each id was last bumped in
   this process; bumping again the same day is a no-op. Without this the
   anime cache produced one write per read, doubling Turso usage.

   Bounded loosely so a long-running process doesn't accumulate forever.
   When we hit the cap we drop the oldest half — picking exact LRU isn't
   worth the bookkeeping. */
const accessBumpDay = new Map<number, number>();
const MAX_BUMP_ENTRIES = 5000;

function shouldBumpAccess(id: number, now: number): boolean {
  const today = Math.floor(now / DAY);
  if (accessBumpDay.get(id) === today) return false;
  accessBumpDay.set(id, today);
  if (accessBumpDay.size > MAX_BUMP_ENTRIES) {
    const keys = Array.from(accessBumpDay.keys()).slice(0, MAX_BUMP_ENTRIES / 2);
    for (const k of keys) accessBumpDay.delete(k);
  }
  return true;
}

export function ttlForStatus(status: string | null | undefined): number {
  switch (status) {
    case "RELEASING":         return 1 * HOUR;
    case "NOT_YET_RELEASED":  return 1 * DAY;
    case "FINISHED":          return 30 * DAY;
    case "CANCELLED":
    case "HIATUS":            return 7 * DAY;
    default:                  return 7 * DAY;
  }
}

/** Drops keys whose value is `undefined` so { ...existing, ...new } doesn't
 *  let absent fields wipe out previously-stored data. */
function stripUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}

/**
 * Fetch one anime by AniList id.
 *
 * Touches `last_accessed_at` so the cron knows users care about this row.
 * Returns null if not in cache (caller should fetch from AniList).
 */
export async function getCachedAnime(id: number): Promise<CachedAnime | null> {
  const db = getTursoClient();
  if (!db) return null;

  const now = Math.floor(Date.now() / 1000);

  const r = await db.execute({
    sql: `SELECT id, status, data, last_fetched_at, expires_at
            FROM anime WHERE id = ?`,
    args: [id],
  });

  if (r.rows.length === 0) return null;
  const row = r.rows[0] as any;

  // Bump last_accessed_at without blocking the read path. We don't await it
  // because reads are hot and accuracy of this column is best-effort.
  // Throttled to once per id per UTC-day in this process so we don't
  // double Turso writes on every hot read.
  if (shouldBumpAccess(id, now)) {
    db.execute({
      sql: "UPDATE anime SET last_accessed_at = ? WHERE id = ?",
      args: [now, id],
    }).catch((e) => {
      console.warn("[anime-cache] last_accessed bump failed:", e?.message);
    });
  }

  return {
    id: Number(row.id),
    data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
    status: row.status as AnimeStatus | null,
    lastFetchedAt: Number(row.last_fetched_at),
    expiresAt: Number(row.expires_at),
    isStale: Number(row.expires_at) < now,
  };
}

/**
 * Les bandes-annonces YouTube de plusieurs animés, en UNE requête.
 *
 * Elle existe parce que la liste d'un profil en demande des centaines à la
 * fois : `getCachedAnime` par identifiant aurait fait autant d'allers-retours
 * Turso, et `getMediaMeta` aurait en plus ramené ~30 ko de métadonnées par
 * titre pour n'en garder que onze caractères.
 *
 * `json_extract` lit dans le blob : le champ `trailer` n'a pas de colonne à
 * lui, et lui en donner une aurait demandé une migration pour une donnée que
 * seule cette liste consulte. Les identifiants qui ne sont pas en cache — ou
 * dont la bande-annonce n'est pas sur YouTube — sont simplement absents de la
 * carte retournée, jamais présents avec une valeur vide.
 */
export async function trailersFor(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const db = getTursoClient();
  const clean = Array.from(new Set(ids.filter((n) => Number.isFinite(n) && n > 0)));
  if (!db || clean.length === 0) return out;

  /* Par paquets : une clause IN a une limite de paramètres (999 sur SQLite par
     défaut), et une liste de 800 titres la dépasse. */
  const CHUNK = 400;
  for (let i = 0; i < clean.length; i += CHUNK) {
    const part = clean.slice(i, i + CHUNK);
    const placeholders = part.map(() => "?").join(",");
    try {
      const r = await db.execute({
        sql: `SELECT id,
                     json_extract(data, '$.trailer.id')   AS tid,
                     json_extract(data, '$.trailer.site') AS site
                FROM anime
               WHERE id IN (${placeholders})`,
        args: part,
      });
      for (const row of r.rows as any[]) {
        const tid = row.tid ? String(row.tid) : null;
        if (!tid || String(row.site) !== "youtube") continue;
        out.set(Number(row.id), tid);
      }
    } catch (e: any) {
      /* Une panne de cache n'est pas une absence de bande-annonce, mais elle
         n'a rien de mieux à offrir ici : la liste se montrera plus courte. */
      console.warn("[anime-cache] trailers lookup failed:", e?.message);
    }
  }
  return out;
}

/**
 * Insert or merge an anime row.
 *
 * Different callers ship different shapes of Media:
 *   • `getMediaMeta` (Tier-1 query)        → full payload
 *   • SSR of /en/anime/[...id]              → small slice (title/relations/…)
 *   • Bootstrap script                      → full payload
 *
 * If we blindly REPLACE on every call, a partial caller would regress a row
 * that was previously written with the full payload. So we merge: the new
 * payload's fields win for keys it actually defines, but every other key
 * coming from the existing row is preserved.
 *
 * Hot columns (status/format/…) are only updated when the new payload
 * actually has a non-undefined value for them, for the same reason.
 */
export async function upsertAnime(media: any): Promise<void> {
  const db = getTursoClient();
  if (!db) return;
  if (!media?.id) {
    console.warn("[anime-cache] upsertAnime called without id");
    return;
  }

  const id = Number(media.id);
  const now = Math.floor(Date.now() / 1000);

  // Read the existing row (if any) so we can merge instead of clobber.
  let existing: any = null;
  try {
    const r = await db.execute({
      sql: "SELECT data FROM anime WHERE id = ?",
      args: [id],
    });
    if (r.rows.length > 0) {
      const raw = (r.rows[0] as any).data;
      existing = typeof raw === "string" ? JSON.parse(raw) : raw;
    }
  } catch {
    // ignore — we'll just write the new payload as-is
  }

  // Shallow merge is enough: AniList Media is mostly flat, and for nested
  // objects we DO want the newer caller's version to win when they bother
  // to provide it. So we merge the partial OVER the existing.
  const merged = existing ? { ...existing, ...stripUndefined(media) } : media;

  // Use the merged status (so a partial payload that only had `id, title` still
  // gets the right TTL from the previously-stored status).
  const ttl = ttlForStatus(merged.status);
  const expiresAt = now + ttl;

  const synonymsStr = Array.isArray(merged.synonyms) ? merged.synonyms.join(" ") : "";
  const dataJson = JSON.stringify(merged);

  // Single transaction so the main row and the FTS row stay in sync.
  // Hot columns use COALESCE(excluded.X, anime.X) so a partial caller (no
  // status/popularity/…) never regresses values previously set by a richer
  // caller. `data` is replaced with the already-merged JSON.
  await db.batch([
    {
      sql: `INSERT INTO anime
              (id, id_mal, status, format, type, season, season_year,
               popularity, average_score, is_adult, data,
               anilist_updated_at, last_fetched_at, expires_at, last_accessed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              id_mal             = COALESCE(excluded.id_mal,             anime.id_mal),
              status             = COALESCE(excluded.status,             anime.status),
              format             = COALESCE(excluded.format,             anime.format),
              type               = COALESCE(excluded.type,               anime.type),
              season             = COALESCE(excluded.season,             anime.season),
              season_year        = COALESCE(excluded.season_year,        anime.season_year),
              popularity         = COALESCE(excluded.popularity,         anime.popularity),
              average_score      = COALESCE(excluded.average_score,      anime.average_score),
              is_adult           = excluded.is_adult,
              data               = excluded.data,
              anilist_updated_at = COALESCE(excluded.anilist_updated_at, anime.anilist_updated_at),
              last_fetched_at    = excluded.last_fetched_at,
              expires_at         = excluded.expires_at,
              last_accessed_at   = excluded.last_accessed_at`,
      args: [
        id,
        merged.idMal ?? null,
        merged.status ?? null,
        merged.format ?? null,
        merged.type ?? null,
        merged.season ?? null,
        merged.seasonYear ?? null,
        merged.popularity ?? null,
        merged.averageScore ?? null,
        merged.isAdult ? 1 : 0,
        dataJson,
        merged.updatedAt ?? null,
        now,
        expiresAt,
        now,
      ],
    },
    // Refresh the FTS row. Standalone FTS5 — we manage rows manually.
    {
      sql: "DELETE FROM anime_fts WHERE rowid = ?",
      args: [id],
    },
    {
      sql: `INSERT INTO anime_fts (rowid, romaji, english, native, synonyms)
              VALUES (?, ?, ?, ?, ?)`,
      args: [
        id,
        merged.title?.romaji ?? "",
        merged.title?.english ?? "",
        merged.title?.native ?? "",
        synonymsStr,
      ],
    },
  ]);
}

/* How many FTS matches we're willing to rank by popularity. The query is a
   PREFIX match, so a short one matches a large share of the catalogue: `"na"*`
   alone reaches into the thousands. Ranking needs the popularity column, which
   lives on `anime`, so every candidate considered means fetching that row's
   ~15 ko `data` blob. 200 is far more than 20 results need to be well-ordered,
   and it bounds the worst case instead of leaving it open. */
const SEARCH_CANDIDATES = 200;

/* Below this, a prefix match says almost nothing and matches almost everything.
   The palette debounces per keystroke, so without a floor every visitor typing
   a title ran one near-catalogue-wide query per character. */
const SEARCH_MIN_CHARS = 3;

/**
 * Local search by title fragment. Used when AniList search is down or to
 * deliver instant results. Returns up to `limit` matches ordered by
 * popularity desc.
 */
export async function searchAnime(query: string, limit = 20): Promise<any[]> {
  const db = getTursoClient();
  if (!db) return [];
  const trimmed = query?.trim();
  if (!trimmed || trimmed.length < SEARCH_MIN_CHARS) return [];

  // FTS5 needs the query escaped. Wrap in double quotes and escape any "" in it,
  // then append * for prefix matching on the last token.
  const safe = trimmed.replace(/"/g, '""');
  const ftsQuery = `"${safe}"*`;

  /* The candidate set is bounded INSIDE the FTS table, before the join.
     Ordering by `a.popularity` in the outer query means the LIMIT cannot be
     pushed down: SQLite had to materialise every match, fetch each row's ~15 ko
     blob, sort them all, then keep 20. `"na"*` alone made that 1 558 blobs, per
     keystroke, per visitor.

     `ORDER BY rank` (bm25) inside the subquery is what makes the bound safe:
     truncating by rowid would have dropped candidates by AniList id, i.e. at
     random. Measured against the unbounded query on the real table, the top 20
     is identical for `"dragon"*` and `"sword"*` (20/20) and 16/20 for `"one"*` —
     the divergence is confined to short generic prefixes, where "correct"
     ordering is arbitrary anyway. Final ranking stays popularity, so what the
     palette shows is ordered exactly as before. */
  const r = await db.execute({
    sql: `SELECT a.data
            FROM (SELECT rowid FROM anime_fts
                   WHERE anime_fts MATCH ?
                   ORDER BY rank
                   LIMIT ?) f
            JOIN anime a ON a.id = f.rowid
            ORDER BY a.popularity DESC NULLS LAST
            LIMIT ?`,
    args: [ftsQuery, SEARCH_CANDIDATES, limit],
  });

  return r.rows.map((row: any) =>
    typeof row.data === "string" ? JSON.parse(row.data) : row.data
  );
}

/**
 * Returns a list of cached anime ordered by the requested sort. Used as a
 * graceful fallback when AniList is down — we serve whatever's in Turso so
 * the homepage doesn't go empty.
 *
 * Supported sorts mirror AniList's `MediaSort` enum (the subset the homepage
 * actually uses):
 *   - "TRENDING_DESC"      → currently-airing, most popular first
 *   - "POPULARITY_DESC"    → indexed popularity column
 *   - "SCORE_DESC"         → indexed average_score column
 *   - "ID_DESC" / default  → most recent rows first
 *
 * Only non-adult, non-NULL-id rows are returned. Stale rows are NOT filtered
 * out — better to serve slightly outdated data than nothing.
 *
 * EVERY sort here must be servable by an index. `TRENDING_DESC` used to order by
 * `CAST(json_extract(data, '$.trending') AS INTEGER)`, which no index can serve:
 * SQLite read all ~22 600 rows, parsed ~15 ko of JSON each, sorted the lot and
 * kept 15. The homepage runs three of these in parallel, so one uncached render
 * cost ~45 000 rows read — during the 02/09/2026 AniList outage, 60 M rows a
 * day, 87 % of the monthly Turso quota in eight days. If a new sort is added
 * here, check `EXPLAIN QUERY PLAN` says `USING INDEX`, not `SCAN`.
 */
export async function listAnime(
  sort: string = "POPULARITY_DESC",
  limit = 15,
): Promise<any[]> {
  const db = getTursoClient();
  if (!db) return [];

  /* Each sort must also produce a VISIBLY DIFFERENT list from its neighbours:
     the homepage renders trending, popular and genre as three rows at once, and
     falling two of them back to the same `ORDER BY` would show the same fifteen
     titles twice — a more obvious breakage than a stale ranking. */
  const { where, orderBy } = (() => {
    switch (sort) {
      case "TRENDING_DESC":
        /* The real `trending` is unusable (see above), and plain popularity
           would duplicate the row below. "Airing right now, most popular first"
           is the closest honest stand-in — it is what trending mostly surfaces
           anyway — and `idx_anime_status` serves the filter. */
        return { where: "AND status = 'RELEASING'", orderBy: "popularity DESC NULLS LAST" };
      case "POPULARITY_DESC":
        return { where: "", orderBy: "popularity DESC NULLS LAST" };
      case "SCORE_DESC":
        return { where: "", orderBy: "average_score DESC NULLS LAST" };
      case "ID_DESC":
      default:
        return { where: "", orderBy: "id DESC" };
    }
  })();

  const r = await db.execute({
    sql: `SELECT data
            FROM anime
           WHERE is_adult = 0
             AND data IS NOT NULL
             ${where}
           ORDER BY ${orderBy}
           LIMIT ?`,
    args: [limit],
  });

  return r.rows.map((row: any) =>
    typeof row.data === "string" ? JSON.parse(row.data) : row.data
  );
}

/**
 * Returns rows whose expires_at < now, ordered by last_accessed_at desc so
 * the cron refreshes user-visible anime first. Used by the daily cron.
 */
export async function getStaleAnime(limit = 200): Promise<{ id: number; status: string | null }[]> {
  const db = getTursoClient();
  if (!db) return [];

  const now = Math.floor(Date.now() / 1000);
  const r = await db.execute({
    sql: `SELECT id, status FROM anime
           WHERE expires_at < ?
           ORDER BY last_accessed_at DESC
           LIMIT ?`,
    args: [now, limit],
  });

  return r.rows.map((row: any) => ({
    id: Number(row.id),
    status: row.status,
  }));
}

/**
 * All RELEASING anime — what the cron refreshes most aggressively.
 */
export async function getReleasingAnime(): Promise<number[]> {
  const db = getTursoClient();
  if (!db) return [];
  const r = await db.execute("SELECT id FROM anime WHERE status = 'RELEASING'");
  return r.rows.map((row: any) => Number(row.id));
}

/** Save a key/value progress marker (used by the bootstrap script). */
export async function setScrapeState(key: string, value: string): Promise<void> {
  const db = getTursoClient();
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO scrape_state (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                          updated_at = excluded.updated_at`,
    args: [key, value, now],
  });
}

export async function getScrapeState(key: string): Promise<string | null> {
  const db = getTursoClient();
  if (!db) return null;
  const r = await db.execute({
    sql: "SELECT value FROM scrape_state WHERE key = ?",
    args: [key],
  });
  return r.rows[0] ? String((r.rows[0] as any).value) : null;
}
