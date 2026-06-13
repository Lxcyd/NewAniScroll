/**
 * Shared list-domain types and date helpers.
 *
 * These were originally inlined in components/listEditor.tsx. They're now
 * extracted here so the local-list store (lib/list/localList.ts), the sync
 * engine (lib/list/syncEngine.ts) and the editor all speak the same shapes
 * without duplicating the AniList status enum / fuzzy-date conversions.
 */

/** AniList MediaListStatus — the canonical status set used everywhere
 *  (AniList entries AND our local list mirror the same values). */
export type Status =
  | "CURRENT"
  | "PLANNING"
  | "COMPLETED"
  | "DROPPED"
  | "PAUSED"
  | "REPEATING";

/** AniList stores dates as { year, month, day } (any of which may be null). */
export type FuzzyDate = {
  year: number | null;
  month: number | null;
  day: number | null;
};

/** FuzzyDate → value for an <input type="date"> ("" when incomplete). */
export function fuzzyToInput(d?: FuzzyDate | null): string {
  if (!d?.year || !d?.month || !d?.day) return "";
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}

/** <input type="date"> value → FuzzyDate (null when empty/invalid). */
export function inputToFuzzy(s: string): FuzzyDate | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return { year: y, month: m, day: d };
}

/** Today as a FuzzyDate (used to stamp startedAt/completedAt on auto-status). */
export function todayFuzzy(): FuzzyDate {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}
