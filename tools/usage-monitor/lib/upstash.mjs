// Upstash collectors: (1) a key-prefix CENSUS of the live DB over the REST API —
// this is the "where do the commands come from" attribution, since Upstash's
// dashboard only shows a single aggregate command count; and (2) the management
// API daily-requests time series (the exact chart in the console).

const FREE_CAP_MONTHLY = 500_000; // Upstash Free ~500K commands/month (see DEVLOG)

/** Run one Redis command over the Upstash REST API. Returns `result` or throws. */
async function restCommand(cfg, args) {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`Upstash REST ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`Upstash cmd error: ${json.error}`);
  return json.result;
}

/**
 * Full-keyspace SCAN, bucketed by the first `:`-segment of each key (`src`,
 * `avail`, `episode`, `lock`, W2G `room`/`presence`/…). Auto-discovers prefixes,
 * so a new cache namespace shows up without editing this file. Cost is a handful
 * of SCAN calls once a day (bounded by MAX_ITERS) — negligible against the cap,
 * and exactly the diagnostic the aggregate chart can't give you.
 */
export async function censusKeyspace(cfg, { maxIters = 200, count = 1000 } = {}) {
  let cursor = "0";
  let iters = 0;
  let scanned = 0;
  const buckets = {};
  const twoSeg = {}; // finer split for the top namespaces (e.g. src:v11)

  do {
    const [next, keys] = await restCommand(cfg, ["SCAN", cursor, "COUNT", count]);
    for (const k of keys) {
      scanned++;
      const seg = k.split(":");
      const b = seg[0] || "(none)";
      buckets[b] = (buckets[b] || 0) + 1;
      if (seg.length >= 2) {
        const b2 = `${seg[0]}:${seg[1]}`;
        twoSeg[b2] = (twoSeg[b2] || 0) + 1;
      }
    }
    cursor = String(next);
    iters++;
  } while (cursor !== "0" && iters < maxIters);

  let dbsize = null;
  try {
    dbsize = await restCommand(cfg, ["DBSIZE"]);
  } catch {
    /* non-fatal */
  }

  const sorted = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
  const sortedTwo = Object.entries(twoSeg)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  return {
    dbsize,
    scanned,
    complete: cursor === "0",
    iters,
    buckets: Object.fromEntries(sorted),
    topTwoSeg: Object.fromEntries(sortedTwo),
  };
}

/** Basic-auth header for the Upstash management API (email:apiKey). */
function mgmtAuth(mgmt) {
  const b64 = Buffer.from(`${mgmt.email}:${mgmt.apiKey}`).toString("base64");
  return `Basic ${b64}`;
}

async function mgmtGet(mgmt, path) {
  const res = await fetch(`https://api.upstash.com${path}`, {
    headers: { Authorization: mgmtAuth(mgmt) },
  });
  if (!res.ok) {
    throw new Error(`Upstash mgmt ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Daily-requests time series from the management API. Auto-discovers the DB id
 * when not given (picks the first database on the account). Returns the raw
 * series plus a monthly projection vs the free cap — the number that actually
 * predicts a mid-month cache death (see DEVLOG 2026-07-29).
 */
export async function fetchUpstashStats(mgmt) {
  let dbId = mgmt.dbId;
  let dbName = null;
  const databases = await mgmtGet(mgmt, "/v2/redis/databases");
  const list = Array.isArray(databases) ? databases : databases?.databases || [];
  if (!dbId && list.length) {
    dbId = list[0].database_id || list[0].id;
    dbName = list[0].database_name || list[0].name;
  } else if (dbId) {
    const match = list.find((d) => (d.database_id || d.id) === dbId);
    dbName = match?.database_name || match?.name || null;
  }
  if (!dbId) throw new Error("No Upstash database id resolved");

  const stats = await mgmtGet(mgmt, `/v2/redis/stats/${dbId}`);

  // The stats payload uses {x: <iso>, y: <n>} point arrays; `dailyrequests` is
  // the series behind the "Daily Commands" chart. Be tolerant of shape drift.
  const daily = normalizeSeries(stats?.dailyrequests);
  const recent = daily.slice(-7);
  const avgPerDay = recent.length
    ? Math.round(recent.reduce((s, p) => s + p.y, 0) / recent.length)
    : null;
  const projectedMonthly = avgPerDay != null ? avgPerDay * 30 : null;

  return {
    dbId,
    dbName,
    databaseCount: list.length, // >1 here would mean dev/prod are ALREADY split
    daily,
    today: daily.at(-1)?.y ?? null,
    yesterday: daily.at(-2)?.y ?? null,
    avgPerDay7d: avgPerDay,
    projectedMonthly,
    freeCapMonthly: FREE_CAP_MONTHLY,
    projectedCapPct:
      projectedMonthly != null
        ? Math.round((projectedMonthly / FREE_CAP_MONTHLY) * 100)
        : null,
  };
}

function normalizeSeries(series) {
  if (!Array.isArray(series)) return [];
  return series
    .map((p) => {
      if (p == null) return null;
      if (typeof p === "object") {
        const x = p.x ?? p.date ?? p.timestamp ?? null;
        const y = Number(p.y ?? p.value ?? p.count ?? 0);
        return { x: x != null ? String(x).slice(0, 10) : null, y };
      }
      return null;
    })
    .filter(Boolean);
}

export { FREE_CAP_MONTHLY };
