-- ─────────────────────────────────────────────────────────────────────────
-- Fanarts schema — additive migration.
--
-- Adds:
--   • tvdb_id / tmdb_id columns to `anime` so we can map AniList IDs to the
--     IDs fanart.tv indexes by. Source of mapping = anime-offline-database.
--   • `anime_fanarts` — one row per fanart image, keeps URL + per-image NSFW
--     scores. We store URLs only, never the binary.
-- ─────────────────────────────────────────────────────────────────────────

-- IF NOT EXISTS isn't supported on ALTER TABLE in SQLite. Run-time check
-- happens in scripts/migrate-db-fanarts.mjs.
ALTER TABLE anime ADD COLUMN tvdb_id INTEGER;
ALTER TABLE anime ADD COLUMN tmdb_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_anime_tvdb_id ON anime(tvdb_id);
CREATE INDEX IF NOT EXISTS idx_anime_tmdb_id ON anime(tmdb_id);

CREATE TABLE IF NOT EXISTS anime_fanarts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  anime_id        INTEGER NOT NULL,
  type            TEXT NOT NULL,           -- 'background' | 'poster' | 'logo' | 'banner' | 'thumb' | 'clearart' | 'seasonbanner' | 'seasonposter' | 'seasonthumb'
  url             TEXT NOT NULL,
  fanart_id       TEXT,                    -- fanart.tv image id
  width           INTEGER,
  height          INTEGER,
  language        TEXT,                    -- 'en', 'jp', '00' (textless)
  likes           INTEGER DEFAULT 0,
  season          INTEGER,                 -- only for season* types

  -- NSFWJS scores (0..1). null until classified.
  nsfw_drawing    REAL,
  nsfw_hentai     REAL,
  nsfw_neutral    REAL,
  nsfw_porn       REAL,
  nsfw_sexy       REAL,

  -- Pre-computed label so the API doesn't have to re-evaluate the rule on
  -- every read. Recompute by running classifier with a new threshold.
  -- Values: 'safe' | 'suggestive' | 'nsfw' | 'explicit' | null (unclassified)
  nsfw_label      TEXT,

  classified_at   INTEGER,                 -- epoch s when we classified
  fetched_at      INTEGER NOT NULL,        -- epoch s when we got it from fanart.tv

  UNIQUE (anime_id, type, url),
  FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fanart_anime  ON anime_fanarts(anime_id);
CREATE INDEX IF NOT EXISTS idx_fanart_type   ON anime_fanarts(type);
CREATE INDEX IF NOT EXISTS idx_fanart_label  ON anime_fanarts(nsfw_label);
CREATE INDEX IF NOT EXISTS idx_fanart_unclassified ON anime_fanarts(classified_at);

-- ─────────────────────────────────────────────────────────────────────────
-- tmdb_stills_cache — per-anime TMDB episode still URLs, keyed
-- "tmdbStills:v1:<anilistId>" (version tag in the key, like season_cache).
-- Created lazily at runtime by lib/db/tmdbStillsCache.ts; mirrored here so the
-- schema is readable in one place.
--
-- Stores REFUSALS too (empty stills + a `reason`): most anime never resolve to
-- a trustworthy TMDB season, and caching the "no" is what keeps us from
-- re-asking TMDB on every cache miss. Lives in the fanarts DB to keep image
-- row-reads off the hot metadata path.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tmdb_stills_cache (
  cache_key   TEXT PRIMARY KEY,        -- tmdbStills:v1:<anilistId>
  value       TEXT NOT NULL,           -- JSON: { stills, reason, tvId, season }
  updated_at  INTEGER NOT NULL         -- epoch s; TTL checked on read
);
