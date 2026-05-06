-- ─────────────────────────────────────────────────────────────────────────
-- AniScroll persistent anime cache (Turso/libSQL = SQLite)
-- ─────────────────────────────────────────────────────────────────────────
-- Strategy:
--   • One row per AniList anime (id = AniList ID).
--   • Hot fields (status, format, popularity, season) are denormalized into
--     columns so cron jobs and discovery queries can index/filter them
--     without parsing the JSON blob.
--   • Everything else (description, images, relations, studios, …) lives
--     in `data` as a JSON string. Adding new fields later doesn't require
--     a migration — we just enrich the JSON.
--   • `expires_at` drives the TTL refresh. `last_accessed_at` lets the cron
--     prioritize anime users actually look at.
--   • A separate FTS5 table powers local search (survives AniList outage).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS anime (
  id                  INTEGER PRIMARY KEY,        -- AniList ID
  id_mal              INTEGER,
  status              TEXT,                       -- RELEASING/FINISHED/...
  format              TEXT,                       -- TV/MOVIE/OVA/...
  type                TEXT,                       -- ANIME/MANGA
  season              TEXT,                       -- WINTER/SPRING/SUMMER/FALL
  season_year         INTEGER,
  popularity          INTEGER,
  average_score       INTEGER,
  is_adult            INTEGER NOT NULL DEFAULT 0,
  data                TEXT NOT NULL,              -- JSON blob (Tier 1 fields)
  anilist_updated_at  INTEGER,                    -- AniList Media.updatedAt
  last_fetched_at     INTEGER NOT NULL,           -- when WE last fetched (epoch s)
  expires_at          INTEGER NOT NULL,           -- TTL deadline (epoch s)
  last_accessed_at    INTEGER NOT NULL            -- last user read (epoch s)
);

CREATE INDEX IF NOT EXISTS idx_anime_status        ON anime(status);
CREATE INDEX IF NOT EXISTS idx_anime_format        ON anime(format);
CREATE INDEX IF NOT EXISTS idx_anime_expires_at    ON anime(expires_at);
CREATE INDEX IF NOT EXISTS idx_anime_popularity    ON anime(popularity DESC);
CREATE INDEX IF NOT EXISTS idx_anime_season        ON anime(season_year, season);
CREATE INDEX IF NOT EXISTS idx_anime_last_accessed ON anime(last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_anime_id_mal        ON anime(id_mal);

-- ─────────────────────────────────────────────────────────────────────────
-- Full-text search across title.romaji / english / native / synonyms.
--
-- This is a STANDALONE FTS5 table (no `content=` option) because we need to
-- DELETE+INSERT rows manually on every upsert. With `content=''` (contentless
-- mode), DELETE is rejected; with `content='anime'` (external content), we'd
-- need triggers. A standalone table is simplest and the storage overhead is
-- tiny (we only store 4 short strings per anime).
-- ─────────────────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS anime_fts USING fts5(
  romaji, english, native, synonyms,
  tokenize='unicode61 remove_diacritics 2'
);

-- Bootstrap & cron progress markers (so we can resume scrapes mid-run)
CREATE TABLE IF NOT EXISTS scrape_state (
  key       TEXT PRIMARY KEY,
  value     TEXT,
  updated_at INTEGER NOT NULL
);
