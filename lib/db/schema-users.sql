-- Schema of the aniscroll-users database (Turso / libSQL).
--
-- Applied by ensureUsersSchema() in lib/db/turso-users.ts, which mirrors this
-- file statement by statement. This file is the readable reference — the DDL
-- that actually runs lives in TypeScript so a cold boot needs no migration
-- tool.
--
-- Guests have NO row here: their identity is a local UUID (lib/prefs/
-- guestIdentity.ts). Nothing to purge, by construction.

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,        -- minted server-side (ULID)
  tag               TEXT NOT NULL UNIQUE,    -- 6 public hex chars, e.g. "7F3A2C"
  username          TEXT,                    -- display name (case preserved)
  username_lower    TEXT UNIQUE,             -- reservation; NULL if AniList-only
  email             TEXT,
  email_lower       TEXT UNIQUE,
  email_verified_at INTEGER,
  password_hash     TEXT,                    -- NULL if AniList-only
  anilist_id        INTEGER UNIQUE,
  anilist_name      TEXT,
  avatar_url        TEXT,
  profile_banner    TEXT,                    -- {url, animeId, title} — PUBLIC
  profile_layout    TEXT,                    -- [{i,x,y,w,h}]        — PUBLIC
  role              TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  status            TEXT NOT NULL DEFAULT 'active', -- 'active' | 'disabled'
  created_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL
);

-- One row per data category. JSON payload + revision, last writer wins.
CREATE TABLE IF NOT EXISTS user_data (
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,  -- list|progress|queue|prefs|favourites|recent|player
  payload    TEXT NOT NULL,  -- JSON
  rev        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,  -- sha256 of the token mailed to the user
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,     -- 'verify' | 'reset'
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- Rate limiting lives here rather than in Upstash: the free Upstash tier
-- (~500k commands/month) is already watched closely, no need to add auth
-- traffic to it.
CREATE TABLE IF NOT EXISTS auth_throttle (
  key      TEXT PRIMARY KEY,    -- 'ip:x' | 'email:x'
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_anilist   ON users(anilist_id);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_tokens_user     ON auth_tokens(user_id, kind);
