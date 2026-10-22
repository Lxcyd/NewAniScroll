// Outils Turso partagés : coût exact d'une requête, usage par base, quota.
//
// Né du 22/10/2026 : 283 M de lignes lues en une semaine sur la base fanarts
// (80 % du quota du mois) par UNE requête qui avait cessé d'utiliser son index.
// Rien ne le voyait venir. Ce module sert au moniteur quotidien
// (tools/usage-monitor) et au test de coût (tools/turso/query-cost.mjs).

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Charge .env puis .env.local sans écraser ce que l'environnement fixe déjà. */
export function loadEnv() {
  for (const f of [".env", ".env.local"]) {
    const p = join(REPO_ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m || process.env[m[1]]) continue;
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

/** Les bases que le site lit, et leurs variables (mêmes noms que les secrets GitHub). */
export const DATABASES = {
  cache: { name: "aniscroll-cache", url: "TURSO_DATABASE_URL", token: "TURSO_AUTH_TOKEN" },
  fanarts: { name: "aniscroll-fanarts", url: "TURSO_FANARTS_DATABASE_URL", token: "TURSO_FANARTS_AUTH_TOKEN" },
  admin: { name: "aniscroll-admin", url: "TURSO_ADMIN_URL", token: "TURSO_ADMIN_TOKEN" },
  users: { name: "aniscroll-users", url: "TURSO_USERS_URL", token: "TURSO_USERS_TOKEN" },
};

const arg = (v) =>
  v === null
    ? { type: "null" }
    : typeof v === "number" && Number.isInteger(v)
      ? { type: "integer", value: String(v) }
      : typeof v === "number"
        ? { type: "float", value: v }
        : { type: "text", value: String(v) };

/**
 * Le coût EXACT d'une requête : `rows_read` tel que Turso le facture, rendu par
 * son API HTTP (pipeline Hrana) — ce que `@libsql/client` n'expose pas.
 * `EXPLAIN QUERY PLAN` dit quel index est pris ; ceci dit combien ça coûte.
 */
export async function queryCost(db, sql, args = []) {
  const d = DATABASES[db];
  const url = process.env[d.url];
  const token = process.env[d.token];
  if (!url || !token) throw new Error(`${d.url} / ${d.token} absents`);
  const base = url.replace(/^libsql:/, "https:").replace(/\/$/, "");
  const r = await fetch(`${base}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requests: [{ type: "execute", stmt: { sql, args: args.map(arg) } }, { type: "close" }],
    }),
  });
  const j = await r.json().catch(() => null);
  const res = j?.results?.[0];
  if (res?.type !== "ok") throw new Error(res?.error?.message ?? `HTTP ${r.status}`);
  return { rows: res.response.result.rows.length, rowsRead: res.response.result.rows_read };
}

/* ── API plateforme (TURSO_API_TOKEN) ─────────────────────────────────────── */

const API = "https://api.turso.tech/v1";

async function api(path) {
  const tok = process.env.TURSO_API_TOKEN;
  if (!tok) throw new Error("TURSO_API_TOKEN absent");
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

export async function organization() {
  const orgs = await api("/organizations");
  return orgs[0]?.slug;
}

/** Lignes lues / écrites par une base entre deux instants (ISO). */
export async function databaseUsage(org, name, from, to) {
  const j = await api(`/organizations/${org}/databases/${name}/usage?from=${from}&to=${to}`);
  return { rowsRead: j.total?.rows_read ?? 0, rowsWritten: j.total?.rows_written ?? 0 };
}

/** La période facturée en cours, le quota du plan et ce qui en est consommé. */
export async function quota(org) {
  const [sub, plans, usage] = await Promise.all([
    api(`/organizations/${org}/subscription`),
    api(`/organizations/${org}/plans`),
    api(`/organizations/${org}/usage`),
  ]);
  const s = sub.subscription;
  const plan = plans.plans.find((p) => p.name === s.plan);
  return {
    plan: s.plan,
    periodStart: s.current_billing_period_start,
    periodEnd: s.current_billing_period_end,
    rowsReadLimit: plan?.quotas?.rowsRead ?? null,
    rowsWrittenLimit: plan?.quotas?.rowsWritten ?? null,
    rowsRead: usage.organization.usage.rows_read,
    rowsWritten: usage.organization.usage.rows_written,
  };
}
