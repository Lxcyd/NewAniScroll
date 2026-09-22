import { getFanartsClient } from "./turso-fanarts";
import {
  sqlScore,
  PLANCHER_DUR,
  TOP_PAR_TITRE,
  AFFICHAGE_MIN_LARGEUR,
  AFFICHAGE_MIN_HAUTEUR,
} from "@/lib/wallhaven/criteres.js";

/**
 * wallhaven_image — la lecture de galerie, et rien d'autre.
 *
 * Les ÉCRITURES vivent dans `tools/wallhaven/` : elles ne tournent que sur le
 * poste, jamais depuis une lambda. C'est tout l'objet du dispositif — Wallhaven
 * limite à 45 requêtes/minute par IP, et cette IP était celle de la fonction,
 * partagée par tous les visiteurs.
 *
 * Politique d'échec identique au reste du dossier (seasonCache, tmdbImagesCache) :
 * table créée paresseusement, toute erreur avalée en liste vide. Une galerie
 * sans Wallhaven reste une galerie — fanart.tv et TMDB la remplissent.
 *
 * ⛔ AUCUN CRITÈRE N'EST CODÉ EN DUR ICI. Seuils, multiplicateurs et plancher
 * d'affichage viennent tous de `lib/wallhaven/criteres.js`, y compris
 * l'expression SQL du score, qui est GÉNÉRÉE à partir des mêmes constantes que
 * la version JavaScript. C'est ce qui empêche la requête et le code de
 * diverger — et c'est le défaut, à plus petite échelle, qui a motivé tout ce
 * chantier.
 */

export interface WallhavenLigne {
  whId: string;
  url: string;
  fullUrl: string;
  width: number;
  height: number;
  likes: number;
  source: string | null;
  colors: string[];
  facetType: "illustration" | "capture" | null;
  hasCharacter: boolean;
  isScenery: boolean;
}

/** Les facettes qu'un appelant peut demander. */
export type Facette = "tout" | "illustration" | "capture" | "personnage" | "paysage";

export interface PageWallhaven {
  arts: WallhavenLigne[];
  hasMore: boolean;
  /** Le total disponible pour ce titre sous les critères courants. Wallhaven
   *  le donnait dans `meta.total` et l'ancien code le jetait ; le savoir permet
   *  à la galerie d'annoncer ce qu'elle déroule. */
  total: number;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS wallhaven_image (
  anime_id      INTEGER NOT NULL,
  wh_id         TEXT    NOT NULL,
  favorites     INTEGER NOT NULL,
  views         INTEGER,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  path          TEXT    NOT NULL,
  thumb         TEXT    NOT NULL,
  source        TEXT,
  colors        TEXT,
  wh_created_at TEXT,
  facet_type    TEXT,
  has_character INTEGER,
  is_scenery    INTEGER,
  serie_ok      INTEGER,
  tagged_at     INTEGER,
  fetched_at    INTEGER NOT NULL,
  PRIMARY KEY (anime_id, wh_id)
)`;
const CREATE_IDX = `
CREATE INDEX IF NOT EXISTS idx_wh_anime ON wallhaven_image(anime_id, favorites DESC)`;

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  const db = getFanartsClient();
  if (!db) return;
  try {
    await db.execute(CREATE_SQL);
    await db.execute(CREATE_IDX);
    ensured = true;
  } catch {
    /* non fatal — les lectures rendront une page vide */
  }
}

/**
 * La clause qui écarte les intrus.
 *
 * `serie_ok IS NULL` passe DÉLIBÉRÉMENT : une image non encore taguée n'a pas
 * été jugée, et transformer une ignorance en refus viderait la galerie de tout
 * ce que l'enrichissement n'a pas encore atteint. Seul un `0` — donc un démenti
 * explicite, tags en main — écarte.
 */
const OU_SERIE_OK = "(w.serie_ok IS NULL OR w.serie_ok = 1)";

function clauseFacette(f: Facette): string {
  switch (f) {
    case "illustration":
      return "AND w.facet_type = 'illustration'";
    case "capture":
      return "AND w.facet_type = 'capture'";
    case "personnage":
      return "AND w.has_character = 1";
    case "paysage":
      return "AND w.is_scenery = 1";
    default:
      return "";
  }
}

/**
 * Une page de galerie pour un anime.
 *
 * LE PLAFOND PAR TITRE, et pourquoi il ne peut pas être un simple plancher.
 * Mesuré sur le corpus One Piece entier (864 images) : un plancher de score à
 * 25 en écarte 51 % — sans dommage, il en reste 421 — mais le même appliqué à
 * Gachiakuta, qui en a 19, serait un massacre. `ROW_NUMBER()` fait que la
 * sévérité s'adapte d'elle-même à l'abondance, sans percentile à maintenir.
 *
 * Rend une page vide sur tout échec ; ne lève jamais.
 */
export async function lireGalerie(
  animeId: number,
  page = 1,
  taille = 24,
  facette: Facette = "tout",
  minLargeur = AFFICHAGE_MIN_LARGEUR,
  minHauteur = AFFICHAGE_MIN_HAUTEUR,
): Promise<PageWallhaven> {
  const vide: PageWallhaven = { arts: [], hasMore: false, total: 0 };
  if (!Number.isFinite(animeId) || animeId <= 0) return vide;
  const db = getFanartsClient();
  if (!db) return vide;
  await ensureTable();

  const p = Math.max(1, Math.floor(page));
  const n = Math.min(Math.max(1, Math.floor(taille)), 100);
  const score = sqlScore("w");

  /* Le classement et la coupe se font dans une sous-requête, pour que le
     `ROW_NUMBER()` porte sur l'anime entier et non sur la page demandée. */
  const sql = `
    WITH classe AS (
      SELECT w.wh_id, w.thumb, w.path, w.width, w.height, w.favorites,
             w.source, w.colors, w.facet_type, w.has_character, w.is_scenery,
             ${score} AS points,
             ROW_NUMBER() OVER (PARTITION BY w.anime_id ORDER BY ${score} DESC, w.wh_id) AS rang
        FROM wallhaven_image w
       WHERE w.anime_id = ?
         AND w.width >= ? AND w.height >= ?
         AND ${OU_SERIE_OK}
         ${clauseFacette(facette)}
    ),
    gardees AS (
      SELECT * FROM classe WHERE points >= ? AND rang <= ?
    )
    SELECT *, (SELECT COUNT(*) FROM gardees) AS total
      FROM gardees ORDER BY rang LIMIT ? OFFSET ?`;

  try {
    const r = await db.execute({
      sql,
      args: [animeId, minLargeur, minHauteur, PLANCHER_DUR, TOP_PAR_TITRE, n, (p - 1) * n],
    });
    if (!r.rows.length) return vide;
    const total = Number((r.rows[0] as any).total) || 0;
    const arts = r.rows.map((row: any) => ({
      whId: String(row.wh_id),
      url: String(row.thumb),
      fullUrl: String(row.path),
      width: Number(row.width) || 0,
      height: Number(row.height) || 0,
      likes: Number(row.favorites) || 0,
      source: row.source ? String(row.source) : null,
      colors: parseColors(row.colors),
      facetType: (row.facet_type as WallhavenLigne["facetType"]) ?? null,
      hasCharacter: row.has_character === 1,
      isScenery: row.is_scenery === 1,
    }));
    return { arts, hasMore: p * n < total, total };
  } catch {
    return vide;
  }
}

function parseColors(v: unknown): string[] {
  if (!v) return [];
  try {
    const a = JSON.parse(String(v));
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Le décompte par facette, pour n'afficher que les boutons qui mènent quelque
 * part — une facette « Capture » vide est un bouton qui ment.
 *
 * Une seule requête : les quatre décomptes sortent de la même lecture, celle-là
 * même que la galerie vient de faire. En demander quatre séparément
 * quadruplerait les lignes lues sur une base dont c'est le quota.
 */
export async function compterFacettes(
  animeId: number,
  minLargeur = AFFICHAGE_MIN_LARGEUR,
  minHauteur = AFFICHAGE_MIN_HAUTEUR,
): Promise<Record<Facette, number>> {
  const zero: Record<Facette, number> = {
    tout: 0, illustration: 0, capture: 0, personnage: 0, paysage: 0,
  };
  const db = getFanartsClient();
  if (!db || !Number.isFinite(animeId) || animeId <= 0) return zero;
  await ensureTable();
  const score = sqlScore("w");

  const sql = `
    WITH classe AS (
      SELECT w.facet_type, w.has_character, w.is_scenery,
             ${score} AS points,
             ROW_NUMBER() OVER (PARTITION BY w.anime_id ORDER BY ${score} DESC, w.wh_id) AS rang
        FROM wallhaven_image w
       WHERE w.anime_id = ? AND w.width >= ? AND w.height >= ? AND ${OU_SERIE_OK}
    )
    SELECT COUNT(*) AS tout,
           SUM(CASE WHEN facet_type = 'illustration' THEN 1 ELSE 0 END) AS illustration,
           SUM(CASE WHEN facet_type = 'capture'      THEN 1 ELSE 0 END) AS capture,
           SUM(CASE WHEN has_character = 1           THEN 1 ELSE 0 END) AS personnage,
           SUM(CASE WHEN is_scenery = 1              THEN 1 ELSE 0 END) AS paysage
      FROM classe WHERE points >= ? AND rang <= ?`;

  try {
    const r = await db.execute({
      sql,
      args: [animeId, minLargeur, minHauteur, PLANCHER_DUR, TOP_PAR_TITRE],
    });
    const row = (r.rows[0] || {}) as any;
    return {
      tout: Number(row.tout) || 0,
      illustration: Number(row.illustration) || 0,
      capture: Number(row.capture) || 0,
      personnage: Number(row.personnage) || 0,
      paysage: Number(row.paysage) || 0,
    };
  } catch {
    return zero;
  }
}
