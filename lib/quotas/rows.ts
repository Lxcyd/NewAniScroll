/**
 * Assemblage et tri des lignes de quota.
 *
 * Isole de l'API et de la page parce que les deux doivent trier de la MEME
 * facon : l'endpoint accepte `?sort=` (pour un curl ou un script), la page
 * reordonne sans refaire un appel reseau. Un comparateur duplique finirait par
 * diverger, et un tableau qui ment sur l'ordre est pire qu'un tableau sans tri.
 */

import { CATALOG, type Quota } from "./catalog";
import type { Measure } from "./measure";

export type QuotaState = "over" | "warn" | "watch" | "ok" | "unknown";

export type QuotaRow = Quota & {
  used: number | null;
  pct: number | null;
  state: QuotaState;
  at: string | null;
  measuredBy: string | null;
  detail: string | null;
  /** true quand la valeur vient d'une saisie manuelle et non d'une API. */
  manual: boolean;
  /** Age du releve en heures — sert a signaler un chiffre perime. */
  ageHours: number | null;
  /** Variables d'env manquantes qui empechent la mesure automatique. */
  missing: string[];
};

/**
 * Les seuils. 80 % est le point ou il reste assez de marge pour agir sans
 * urgence ; 100 % n'est pas « bientot », c'est deja le 402.
 */
export function stateFor(pct: number | null): QuotaState {
  if (pct == null) return "unknown";
  if (pct >= 100) return "over";
  if (pct >= 80) return "warn";
  if (pct >= 50) return "watch";
  return "ok";
}

export function buildRows(
  measures: Record<string, Measure>,
  manual: Record<string, Measure> = {},
): QuotaRow[] {
  const now = Date.now();
  return CATALOG.map((q) => {
    // Une mesure automatique prime toujours sur une saisie manuelle : elle est
    // fraiche par construction, la saisie ne l'est que si on y pense.
    const auto = measures[q.id];
    const hand = manual[q.id];
    const m = auto || hand || null;

    const missing = (q.needs || []).filter((v) => !process.env[v]);
    const used = m ? m.used : null;
    const pct =
      used != null && q.limit > 0
        ? Math.round((used / q.limit) * 1000) / 10
        : null;

    return {
      ...q,
      used,
      pct,
      state: stateFor(pct),
      at: m?.at ?? null,
      measuredBy: m?.source ?? null,
      detail: m?.detail ?? null,
      manual: !auto && !!hand,
      ageHours: m?.at
        ? Math.round(((now - Date.parse(m.at)) / 3_600_000) * 10) / 10
        : null,
      missing,
    };
  });
}

export const SORTS = {
  /** Le tri par defaut, et la raison d'etre de la page. */
  closest: "Au plus pres de la limite",
  pct: "Pourcentage croissant",
  provider: "Fournisseur",
  metric: "Nom",
  period: "Periode de remise a zero",
  age: "Fraicheur du releve",
} as const;

export type SortKey = keyof typeof SORTS;

/** Ordre d'urgence des periodes : une minute se rejoue tout de suite, un mois
 *  laisse le temps de voir venir. Les bornes structurelles ferment la marche. */
const PERIOD_RANK: Record<string, number> = {
  seconde: 0,
  minute: 1,
  heure: 2,
  jour: 3,
  mois: 4,
  "30 jours": 5,
};
const periodRank = (p: string) => PERIOD_RANK[p] ?? 9;

export function sortRows(rows: QuotaRow[], sort: SortKey): QuotaRow[] {
  const byName = (a: QuotaRow, b: QuotaRow) =>
    a.provider.localeCompare(b.provider, "fr") ||
    a.metric.localeCompare(b.metric, "fr");

  const out = [...rows];
  switch (sort) {
    case "pct":
      // Les inconnus restent en queue : on trie ce qu'on sait, on n'invente pas
      // un rang pour ce qu'on ignore.
      return out.sort(
        (a, b) =>
          (a.pct ?? Infinity) - (b.pct ?? Infinity) || byName(a, b),
      );
    case "provider":
      return out.sort(byName);
    case "metric":
      return out.sort(
        (a, b) => a.metric.localeCompare(b.metric, "fr") || byName(a, b),
      );
    case "period":
      return out.sort(
        (a, b) => periodRank(a.period) - periodRank(b.period) || byName(a, b),
      );
    case "age":
      return out.sort(
        (a, b) => (b.ageHours ?? -1) - (a.ageHours ?? -1) || byName(a, b),
      );
    case "closest":
    default:
      return out.sort(
        (a, b) => (b.pct ?? -1) - (a.pct ?? -1) || byName(a, b),
      );
  }
}

/** Formatage d'une valeur selon son unite. Exporte pour que l'API et la page
 *  affichent la meme chose (un « 10 Go » cote serveur et un « 10737418240 »
 *  cote client seraient le meme chiffre et deux lectures differentes). */
export function formatValue(value: number, unit: Quota["unit"]): string {
  switch (unit) {
    case "bytes": {
      const units = ["o", "Ko", "Mo", "Go", "To"];
      let v = value;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      // Precision decroissante avec la magnitude, et pas de zeros inutiles :
      // « 10 Go » et non « 10.00 Go », mais « 1,25 Go » reste lisible.
      const decimals = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
      return `${v.toLocaleString("fr-FR", {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
      })} ${units[i]}`;
    }
    case "cpu-hours":
      return `${Math.round(value * 100) / 100} h CPU`;
    case "gb-hours":
      return `${Math.round(value * 100) / 100} Go·h`;
    case "seconds":
      return `${value} s`;
    case "minutes":
      return `${value} min`;
    default:
      return value.toLocaleString("fr-FR");
  }
}
