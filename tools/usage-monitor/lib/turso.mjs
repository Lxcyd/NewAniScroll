// Turso dans le rapport quotidien : lignes lues HIER par base, consommé du
// mois, projection à la fin de la période facturée.
//
// Pourquoi (22/10/2026) : la base fanarts a lu 283 M de lignes du 14 au 21/10
// sans que rien ne le signale — on l'a vu au bandeau « 80 % » du tableau de
// bord Turso. Ici, le premier jour à 12 M aurait levé un drapeau.

import { DATABASES, organization, databaseUsage, quota } from "../../turso/lib.mjs";

/** Un jour au-dessus de ce seuil, pour UNE base, est anormal (base ~0,2-2 M). */
export const TURSO_DAY_FLAG = 10_000_000;
/** Projection de fin de période au-delà de laquelle on prévient. */
export const TURSO_PROJECTION_FLAG = 0.7;

export async function collectTurso(now = new Date()) {
  if (!process.env.TURSO_API_TOKEN) return null;
  const org = await organization();
  const day = (d) => d.toISOString().slice(0, 10) + "T00:00:00Z";
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 86_400_000);

  const perDb = {};
  for (const [key, d] of Object.entries(DATABASES)) {
    try {
      perDb[key] = { name: d.name, ...(await databaseUsage(org, d.name, day(yesterday), day(today))) };
    } catch (e) {
      perDb[key] = { name: d.name, error: e.message };
    }
  }

  const q = await quota(org);
  /* Projection au RYTHME D'HIER, pas en ligne droite depuis le début de la
     période : une pointe corrigée gonflait sinon la projection jusqu'au bout
     du mois (117 % le 22/10 alors qu'il restait de la marge). */
  const hier = Object.values(perDb).reduce((s, d) => s + (d.rowsRead || 0), 0);
  const restant = Math.max(0, (new Date(q.periodEnd).getTime() - now.getTime()) / 86_400_000);
  const projected = q.rowsReadLimit ? (q.rowsRead + hier * restant) / q.rowsReadLimit : null;

  return {
    org,
    day: day(yesterday).slice(0, 10),
    perDb,
    quota: q,
    usedPct: q.rowsReadLimit ? Math.round((q.rowsRead / q.rowsReadLimit) * 100) : null,
    projectedPct: projected == null ? null : Math.round(projected * 100),
  };
}

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

export function renderTurso(t) {
  const L = ["## Turso — rows read"];
  if (!t) {
    L.push("> _no TURSO_API_TOKEN — Turso usage unavailable_", "");
    return L;
  }
  if (t.error) {
    L.push(`> _skipped: ${t.error}_`, "");
    return L;
  }
  L.push(
    `- Period ${t.quota.periodStart.slice(0, 10)} → ${t.quota.periodEnd.slice(0, 10)} (plan \`${t.quota.plan}\`): **${fmt(t.quota.rowsRead)}** / ${fmt(t.quota.rowsReadLimit)} read — **${t.usedPct ?? "—"}%**, projected **${t.projectedPct ?? "—"}%** at period end`,
    "",
    `| database | rows read on ${t.day} | rows written |`,
    "|---|---:|---:|",
  );
  for (const d of Object.values(t.perDb))
    L.push(`| \`${d.name}\` | ${d.error ? `_${d.error}_` : fmt(d.rowsRead)} | ${d.error ? "" : fmt(d.rowsWritten)} |`);
  L.push("");
  return L;
}

export function tursoFlags(t) {
  const flags = [];
  if (!t || t.error) return flags;
  for (const d of Object.values(t.perDb)) {
    if (!d.error && d.rowsRead > TURSO_DAY_FLAG)
      flags.push(
        `**Turso \`${d.name}\` a lu ${fmt(d.rowsRead)} lignes le ${t.day}** (seuil ${fmt(TURSO_DAY_FLAG)}) — une requête a probablement perdu son index : \`node tools/turso/query-cost.mjs\`, puis EXPLAIN QUERY PLAN sur les suspects.`,
      );
  }
  if (t.projectedPct != null && t.projectedPct >= TURSO_PROJECTION_FLAG * 100)
    flags.push(
      `**Turso projeté à ${t.projectedPct}% du quota** de lignes lues en fin de période (${t.usedPct}% consommé, fin le ${t.quota.periodEnd.slice(0, 10)}).`,
    );
  return flags;
}
