/**
 * Clé Turso (season_cache) de la liste des thèmes d'un anime. Partagée par
 * /api/v2/themes et /api/v2/theme-covers : les pochettes relisent la liste déjà
 * en cache au lieu de redemander AnimeThemes.
 */
// v2: the Theme shape gained videoNc/videoCredited (credits toggle). Bumping the
// key retires v1 rows that only had a single `video` URL, so warm caches don't
// serve the old shape without the credited variant.
export const THEMES_KEY = (anilistId: number | null, malId: number | null) =>
  `themes:v2:${malId ? `mal${malId}` : `al${anilistId}`}`;
