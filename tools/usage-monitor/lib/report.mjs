// Snapshot persistence + markdown report rendering (deltas vs the previous run).

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Most recent snapshot strictly before `todayFile`, or null. */
export function loadPreviousSnapshot(snapshotsDir, todayFile) {
  if (!existsSync(snapshotsDir)) return null;
  const files = readdirSync(snapshotsDir)
    .filter((f) => f.endsWith(".json") && f !== todayFile)
    .sort();
  const prev = files.at(-1);
  if (!prev) return null;
  try {
    return JSON.parse(readFileSync(join(snapshotsDir, prev), "utf8"));
  } catch {
    return null;
  }
}

export function writeSnapshot(snapshotsDir, file, snapshot) {
  ensureDir(snapshotsDir);
  writeFileSync(join(snapshotsDir, file), JSON.stringify(snapshot, null, 2));
}

function fmt(n) {
  return n == null ? "—" : Number(n).toLocaleString("en-US");
}

function deltaStr(now, prev) {
  if (now == null || prev == null) return "";
  const d = now - prev;
  if (d === 0) return " (=)";
  const pct = prev ? ` ${d > 0 ? "+" : ""}${Math.round((d / prev) * 100)}%` : "";
  return ` (${d > 0 ? "+" : ""}${fmt(d)}${pct})`;
}

/** Render the full daily markdown report. */
export function renderReport(snapshot, prev) {
  const L = [];
  L.push(`# Usage Monitor — ${snapshot.date}`);
  L.push("");
  L.push(`_Generated ${snapshot.generatedAt}_`);
  L.push("");

  // ── Flags first: the actionable summary ──────────────────────────────────
  const flags = buildFlags(snapshot, prev);
  if (flags.length) {
    L.push("## ⚠️ Flags");
    for (const f of flags) L.push(`- ${f}`);
    L.push("");
  }

  // ── Upstash daily requests (management API) ───────────────────────────────
  const s = snapshot.upstashStats;
  L.push("## Upstash — daily commands");
  if (s?.error) {
    L.push(`> _skipped: ${s.error}_`);
  } else if (s) {
    if (s.databaseCount > 1) {
      L.push(
        `> DBs on account: **${s.databaseCount}** — dev/prod are already SPLIT (good).`,
      );
    } else {
      L.push(
        `> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.`,
      );
    }
    L.push("");
    L.push(`- DB: \`${s.dbName || s.dbId}\``);
    L.push(`- Today: **${fmt(s.today)}**${deltaStr(s.today, s.yesterday)} vs yesterday`);
    L.push(`- 7-day avg/day: **${fmt(s.avgPerDay7d)}**`);
    L.push(
      `- Projected month: **${fmt(s.projectedMonthly)}** / ${fmt(s.freeCapMonthly)} cap — **${s.projectedCapPct ?? "—"}%**`,
    );
  } else {
    L.push(
      "> _no management creds (UPSTASH_EMAIL / UPSTASH_API_KEY) — daily-requests chart unavailable_",
    );
  }
  L.push("");

  // ── Keyspace census: where the keys (and thus commands) live ──────────────
  const c = snapshot.census;
  L.push("## Redis keyspace census (where the load comes from)");
  if (c?.error) {
    L.push(`> _skipped: ${c.error}_`);
  } else if (c) {
    const total = c.scanned || 1;
    L.push(
      `- DBSIZE: **${fmt(c.dbsize)}** | scanned: ${fmt(c.scanned)} keys${c.complete ? "" : " (⚠️ SCAN capped — increase maxIters)"}`,
    );
    L.push("");
    L.push("| prefix | keys | % | Δ vs prev |");
    L.push("|---|---:|---:|---:|");
    const prevBuckets = prev?.census?.buckets || {};
    for (const [k, v] of Object.entries(c.buckets)) {
      const pct = ((v / total) * 100).toFixed(1);
      L.push(`| \`${k}:\` | ${fmt(v)} | ${pct}% | ${deltaStr(v, prevBuckets[k]).trim() || "—"} |`);
    }
    if (c.topTwoSeg && Object.keys(c.topTwoSeg).length) {
      L.push("");
      L.push("<details><summary>Top 2-segment namespaces</summary>");
      L.push("");
      L.push("| namespace | keys |");
      L.push("|---|---:|");
      for (const [k, v] of Object.entries(c.topTwoSeg)) {
        L.push(`| \`${k}\` | ${fmt(v)} |`);
      }
      L.push("");
      L.push("</details>");
    }
  } else {
    L.push("> _census unavailable (no Redis REST config)_");
  }
  L.push("");

  // ── Vercel deployments (correlate spikes with releases) ───────────────────
  const v = snapshot.vercel;
  L.push("## Vercel — recent deployments");
  if (!v || v.ok === false) {
    L.push(`> _${v?.error || "no VERCEL_TOKEN — deployment correlation unavailable"}_`);
  } else {
    L.push("| when | target | branch | sha | message |");
    L.push("|---|---|---|---|---|");
    for (const d of v.deployments.slice(0, 10)) {
      L.push(
        `| ${d.createdAt?.slice(0, 16).replace("T", " ") || "—"} | ${d.target || "—"} | ${d.branch || "—"} | \`${d.sha || "—"}\` | ${d.message || ""} |`,
      );
    }
  }
  L.push("");
  return L.join("\n");
}

function buildFlags(snapshot, prev) {
  const flags = [];
  const s = snapshot.upstashStats;
  if (s && !s.error) {
    if (s.projectedCapPct != null && s.projectedCapPct >= 100) {
      flags.push(
        `**Upstash on track to blow the free cap** (~${s.projectedCapPct}% of ${fmt(s.freeCapMonthly)}) → cache will die mid-month. Split dev/prod or go pay-as-you-go.`,
      );
    } else if (s.projectedCapPct != null && s.projectedCapPct >= 80) {
      flags.push(`Upstash projected at **${s.projectedCapPct}%** of the free cap — watch it.`);
    }
    if (s.databaseCount === 1) {
      flags.push(
        "Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).",
      );
    }
    if (s.today != null && s.yesterday != null && s.yesterday > 0 && s.today > s.yesterday * 1.5) {
      flags.push(`Daily commands **jumped ${Math.round((s.today / s.yesterday - 1) * 100)}%** vs yesterday — check recent deployments below.`);
    }
  }
  // Keyspace growth anomalies
  const c = snapshot.census;
  const pc = prev?.census?.buckets;
  if (c?.buckets && pc) {
    for (const [k, v] of Object.entries(c.buckets)) {
      const p = pc[k];
      if (p && p >= 50 && v > p * 2) {
        flags.push(`Key prefix \`${k}:\` **doubled** (${fmt(p)} → ${fmt(v)}) — possible key-explosion or a cache-key bump.`);
      }
    }
  }
  return flags;
}

/** Prepend a one-line summary to a rolling HISTORY.md. */
export function appendHistory(historyPath, snapshot) {
  const s = snapshot.upstashStats;
  const c = snapshot.census;
  const top = c?.buckets ? Object.entries(c.buckets)[0] : null;
  const line =
    `- **${snapshot.date}** — ` +
    (s && !s.error
      ? `Upstash today ${fmt(s.today)} (proj ${s.projectedCapPct ?? "—"}% cap), `
      : "") +
    (c && !c.error
      ? `DBSIZE ${fmt(c.dbsize)}${top ? `, top prefix \`${top[0]}:\` ${fmt(top[1])}` : ""}`
      : "");
  let prevBody = "";
  if (existsSync(historyPath)) prevBody = readFileSync(historyPath, "utf8");
  else prevBody = "# Usage Monitor — history\n\n";
  // Insert the new line right after the header block.
  const headerEnd = prevBody.indexOf("\n\n");
  const head = headerEnd === -1 ? prevBody : prevBody.slice(0, headerEnd + 2);
  const rest = headerEnd === -1 ? "" : prevBody.slice(headerEnd + 2);
  writeFileSync(historyPath, `${head}${line}\n${rest}`);
}
