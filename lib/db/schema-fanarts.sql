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

-- ─────────────────────────────────────────────────────────────────────────
-- wallhaven_image — un fond d'ecran par ligne, moissonne DEPUIS LE POSTE.
--
-- Pourquoi cette table existe. Wallhaven etait la seule de nos trois sources
-- d'illustrations interrogee EN DIRECT depuis la lambda, sur un quota de 45
-- requetes/minute par IP — l'IP de la fonction, partagee par tous les
-- visiteurs. Quatre fiches froides ouvertes en meme temps suffisaient a la
-- faire sauter, et un 429 rend une galerie vide.
--
-- ⛔ AUCUN CRITERE N'EST APPLIQUE A L'ECRITURE. C'est la regle de cette table,
-- et elle vient d'une erreur couteuse : l'ancien lib/wallhaven/artworks.ts en
-- etait a sa SIXIEME version de cle de cache en deux jours, dont trois bumps
-- qui ne reglaient qu'un seuil, chacun invalidant trente jours de galeries.
-- Le moissonneur ecrit donc TOUT ce que Wallhaven rend, avec ses compteurs ;
-- le tri vit dans lib/wallhaven/criteres.js et s'applique a la LECTURE, ou le
-- changer ne coute rien. Ne jamais filtrer ici.
--
-- Cle composite (anime_id, wh_id) et non wh_id seul : une image « One Piece »
-- de la mesure portait 18 tags de serie — c'etait un collage Shonen Jump. Une
-- image appartient legitimement a plusieurs animes.
--
-- On ne stocke que des URL, jamais le binaire, comme anime_fanarts.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallhaven_image (
  anime_id      INTEGER NOT NULL,
  wh_id         TEXT    NOT NULL,   -- '72lej9', identifiant stable chez Wallhaven
  favorites     INTEGER NOT NULL,
  views         INTEGER,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  path          TEXT    NOT NULL,   -- l'image entiere
  thumb         TEXT    NOT NULL,   -- thumbs.large, ~500 px
  source        TEXT,               -- l'auteur d'origine quand Wallhaven le connait
  colors        TEXT,               -- JSON, 5 dominantes — sert au theme du profil
  wh_created_at TEXT,               -- depot chez Wallhaven ; borne la re-lecture
                                    -- des favoris (au-dela d'un mois, stabilises)

  -- Facettes derivees des tags. NULL = pas encore tague, ce qui n'est PAS la
  -- meme chose que « non ». Voir serie_ok ci-dessous.
  facet_type    TEXT,               -- 'illustration' | 'capture' | NULL
  has_character INTEGER,            -- 0/1
  is_scenery    INTEGER,            -- 0/1

  -- La recherche Wallhaven est TEXTUELLE, donc elle ramene d'autres animes :
  -- mesure sur les 864 images de « one piece », on y trouve Sakura Miko
  -- (Hololive) et Nishikino Maki (Love Live!), bien notees et bien creditees.
  -- Aucun signal de qualite ne peut voir ca. Seuls les tags le peuvent.
  --   1    un tag confirme l'anime          -> affichee
  --   0    taguee, aucun tag ne correspond  -> ECARTEE
  --   NULL pas encore taguee                -> affichee (on ne sait pas, et une
  --                                            ignorance ne devient pas un refus)
  serie_ok      INTEGER,
  tagged_at     INTEGER,

  fetched_at    INTEGER NOT NULL,
  PRIMARY KEY (anime_id, wh_id)
);

-- La lecture de galerie : WHERE anime_id = ? puis tri. Le score n'etant pas
-- stocke (il change avec les constantes), l'index porte sur favorites, qui en
-- est le terme dominant — SQLite trie ensuite les ~centaines de lignes d'un
-- seul anime, pas les centaines de milliers de la table.
CREATE INDEX IF NOT EXISTS idx_wh_anime ON wallhaven_image(anime_id, favorites DESC);
-- La file du moissonneur de tags, et celle du rafraichissement quotidien.
CREATE INDEX IF NOT EXISTS idx_wh_atag  ON wallhaven_image(tagged_at);
CREATE INDEX IF NOT EXISTS idx_wh_frais ON wallhaven_image(wh_created_at);

-- Les tags BRUTS. Ils sont conserves tels quels pour que corriger la regle de
-- repliage (lib/wallhaven/criteres.js) ne demande AUCUN re-moissonnage : si la
-- facette « Capture » montre autre chose que des captures, on recalcule depuis
-- cette table. Meme principe que le reste : garder le brut, juger a la lecture.
CREATE TABLE IF NOT EXISTS wallhaven_tag (
  wh_id     TEXT    NOT NULL,
  tag_id    INTEGER NOT NULL,
  name      TEXT    NOT NULL,
  category  TEXT,                   -- 'Characters' | 'Series' | 'Landscapes' | …
  PRIMARY KEY (wh_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_whtag_nom ON wallhaven_tag(name);

-- Le curseur des moissonneurs, pour qu'une coupure ne coute rien.
CREATE TABLE IF NOT EXISTS wallhaven_progres (
  tache      TEXT PRIMARY KEY,      -- 'crawl' | 'tags' | 'quotidien'
  curseur    TEXT,                  -- dernier anime_id ou wh_id traite
  note       TEXT,
  maj_at     INTEGER NOT NULL
);
