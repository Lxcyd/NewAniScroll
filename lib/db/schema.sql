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

-- ─────────────────────────────────────────────────────────────────────────
-- player_map — verified source-of-truth for player resolution.
-- One row per (aniId, source, lang): the resolved slug / season panel /
-- merged-list offset + a verification status (verified/heuristic/broken/
-- absent). The watch-time resolver reads this before running any slug/season
-- heuristics; scripts/verify-player-map.mjs promotes/demotes rows. See
-- lib/db/playerMap.ts for the full lifecycle.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS player_map (
  ani_id        INTEGER NOT NULL,
  source        TEXT    NOT NULL,           -- animesama | voiranime
  lang          TEXT    NOT NULL,           -- vostfr | vf
  status        TEXT    NOT NULL,           -- verified | heuristic | broken | absent
  slug          TEXT,
  season_dir    TEXT,                       -- anime-sama panel dir (saison2, film…)
  ep_offset     INTEGER NOT NULL DEFAULT 0, -- merged-panel episode offset
  episode_count INTEGER,                    -- canonical count at check time
  confidence    REAL,                       -- slug-title confidence (0..1)
  fail_count    INTEGER NOT NULL DEFAULT 0, -- runtime failures / user reports
  note          TEXT,                       -- verdict / demotion reason
  algo_version  INTEGER NOT NULL DEFAULT 0, -- season-resolution algo version (see playerMap.ts)
  checked_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,           -- re-verification deadline
  PRIMARY KEY (ani_id, source, lang)
);

CREATE INDEX IF NOT EXISTS idx_player_map_status  ON player_map(status);
CREATE INDEX IF NOT EXISTS idx_player_map_expires ON player_map(expires_at);

-- ─────────────────────────────────────────────────────────────────────────
-- fribb_map — cross-database ID + season mapping from Fribb/anime-lists.
-- One row per AniList id. Populated by a periodic ingest of
-- anime-list-mini.json (see lib/fribb/fribbMap.ts). Gives us the TMDB show/
-- movie id (for franchise grouping + dual-format detection) and the
-- pre-mapped TMDB season number — used as ONE validated signal in the
-- multi-signal season resolver, never as sole authority (TMDB mislabels:
-- Bungo Stray Dogs, split cours, etc.).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fribb_map (
  anilist_id     INTEGER PRIMARY KEY,
  mal_id         INTEGER,
  tmdb_tv_id     INTEGER,                     -- themoviedb_id.tv (franchise key)
  tmdb_movie_id  INTEGER,                     -- themoviedb_id.movie (dual-format)
  tvdb_id        INTEGER,
  simkl_id       INTEGER,                     -- inerte depuis le retrait de
                                              -- Simkl (22/08/2026) ; toujours
                                              -- alimente depuis Fribb, lu par
                                              -- personne
  tmdb_season    INTEGER,                     -- season.tmdb (NULL when unmapped)
  tvdb_season    INTEGER,                     -- season.tvdb
  type           TEXT,                        -- TV/MOVIE/OVA/... (Fribb `type`)
  updated_at     INTEGER NOT NULL             -- when this row was ingested
);

CREATE INDEX IF NOT EXISTS idx_fribb_tmdb_tv    ON fribb_map(tmdb_tv_id);
CREATE INDEX IF NOT EXISTS idx_fribb_tmdb_movie ON fribb_map(tmdb_movie_id);
CREATE INDEX IF NOT EXISTS idx_fribb_mal        ON fribb_map(mal_id);

-- ─────────────────────────────────────────────────────────────────────────
-- season_override — manual last-word patches for franchises the automatic
-- resolver gets wrong (TMDB fusion, mislabeled relations, etc.). Consulted
-- BEFORE Fribb in the resolver cascade. Rarely populated; a safety valve so
-- a broken case can be fixed without waiting on an upstream (TMDB/Fribb) fix.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS season_override (
  ani_id       INTEGER PRIMARY KEY,           -- AniList id being overridden
  season       INTEGER,                       -- forced season number (NULL = leave)
  total        INTEGER,                       -- forced total seasons (optional)
  format       TEXT,                          -- forced format hint (optional)
  note         TEXT,                          -- why this override exists
  updated_at   INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────
-- oped_youtube — the FULL-LENGTH version of an OP/ED on YouTube, one row per
-- (ani_id, slug). Filled offline by tools/ost-resolver/resolve.py, imported by
-- scripts/oped/import-oped-youtube.mjs, served by /api/v2/themes/{id}.
--
-- Why this table has to exist at all. AnimeThemes hosts the anime's own rip of
-- the sequence: 90 s, measured with ffprobe (ChainsawMan-OP1 = 90.1 s,
-- CyberpunkEdgerunners-OP1 = 89.9 s). That is the TV size, not the song, so
-- "play the opening" could never mean the real track without a second source.
-- YouTube has the full version, but finding it is a resolution problem, not a
-- lookup: it is done offline and its answer is what lands here.
--
-- `verdict` IS LOAD-BEARING, and the API must respect it:
--   ok     — two independent signals agreed (artist channel + cross-query, or
--            channel + near-exact title). Safe to serve.
--   review — ONE signal only. Usually right, sometimes a different track by the
--            right artist. NEVER served automatically; it is a queue for a
--            human. Serving these would throw away the whole point of the
--            guard, which exists because "right channel, plausible duration"
--            alone validated an unrelated song (Chainsaw Man ED3).
--   absent — processed, nothing acceptable exists (MAXIMUM THE HORMONE only
--            publishes the 90 s TV edit of Hawatari Nioku Centi).
--   api_fail — the search never answered. Retry later; NOT an absence.
--
-- A row exists as soon as a theme has been PROCESSED, absences included — same
-- rule as oped_host_skips. That is what tells a re-run "already looked at"
-- apart from "never tried", without which the batch re-does everything forever.
--
-- `algo_version` moves when the resolver's scoring changes, so a better version
-- can re-run only what it would now judge differently.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oped_youtube (
  ani_id       INTEGER NOT NULL,           -- AniList id
  slug         TEXT    NOT NULL,           -- OP1, ED2… (AnimeThemes theme slug)
  verdict      TEXT    NOT NULL,           -- ok | review | absent | api_fail
  video_id     TEXT,                       -- YouTube id (11 chars); null unless resolved
  yt_title     TEXT,                       -- what YouTube calls it (audit trail)
  yt_channel   TEXT,                       -- channel that served it (audit trail)
  duration     INTEGER,                    -- seconds — the TV-size guard is >= 100
  artist       TEXT,                       -- reference artist used for the search
  artist_src   TEXT,                       -- animethemes | aniplaylist | musicbrainz
  algo_version INTEGER NOT NULL DEFAULT 1,
  checked_at   INTEGER NOT NULL,
  PRIMARY KEY (ani_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_oped_youtube_verdict ON oped_youtube(verdict);
