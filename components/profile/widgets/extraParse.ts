/**
 * Les lectures des réglages des blocs « extra » (épinglés, OP/ED, affinités),
 * HORS d'ExtraBlocks.tsx (26/11/2026, passe vitesse du profil).
 *
 * L'aperçu en a besoin à chaque rendu, même quand aucun de ces blocs n'est
 * posé ; les laisser dans ExtraBlocks (107 Ko minifiés, émojis et stickers
 * compris) obligeait la page à embarquer tout le module d'office. Ici, il ne
 * reste que du JSON : ExtraBlocks se charge à la demande (ProfileOverview,
 * `lazyBlock`) et réexporte ces noms pour ses propres usages.
 */

export type Pin = { id: number; note: string };
export const PIN_NOTE_MAX = 120;

export type FavTheme = { a: number; s: string };
/** Pas de limite voulue (03/11/2026, Luc) : seulement le plafond de sauvegarde (grid.ts). */
export const THEMES_MAX = 250;

export function parsePins(raw: string | undefined): Pin[] {
  try {
    const p = JSON.parse(raw || "[]");
    return Array.isArray(p)
      ? p
          .filter((x) => Number.isFinite(Number(x?.id)))
          .slice(0, 3)
          .map((x) => ({ id: Number(x.id), note: String(x.note ?? "").slice(0, PIN_NOTE_MAX) }))
      : [];
  } catch {
    return [];
  }
}

export function parseThemes(raw: string | undefined): FavTheme[] {
  try {
    const p = JSON.parse(raw || "[]");
    return Array.isArray(p)
      ? p
          .filter((x) => Number.isFinite(Number(x?.a)) && typeof x?.s === "string")
          .slice(0, THEMES_MAX)
          .map((x) => ({ a: Number(x.a), s: String(x.s).slice(0, 8) }))
      : [];
  } catch {
    return [];
  }
}

export function parseTags(s: string | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
