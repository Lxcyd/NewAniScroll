/**
 * Clé Turso (season_cache) des pochettes de génériques d'un anime, et ce qui y
 * est rangé. Partagée par /api/v2/theme-covers (qui l'écrit) et
 * /api/v2/themes (qui joint les pochettes déjà connues à sa réponse : une
 * requête de moins à chaque ouverture d'un anime).
 */
// v4 : pochettes servies en 120 px (affichées à 40) au lieu de 250.
export const COVERS_KEY = (anilistId: number) => `themecovers:v4:al${anilistId}`;

/** Les pochettes, et les morceaux dont la cascade est allée au bout (`tried`)
 *  — un anime à vingt-cinq génériques se résout en plusieurs appels, chacun
 *  reprenant où le précédent s'est arrêté. */
export type CoversEntry = { covers: Record<string, string | null>; tried: string[] };
