# Usage Monitor — 2026-09-06

_Generated 2026-09-06T11:01:13.070Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~163% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).
- Key prefix `episode:` **doubled** (374 → 1,228) — possible key-explosion or a cache-key bump.
- Key prefix `ftree:` **doubled** (110 → 725) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **9,417** (-66,095 -88%) vs yesterday
- 7-day avg/day: **27,194**
- Projected month: **815,820** / 500,000 cap — **163%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **13,990** | scanned: 13,985 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 11,461 | 82.0% | (-124 -1%) |
| `episode:` | 1,228 | 8.8% | (+854 +228%) |
| `ftree:` | 725 | 5.2% | (+615 +559%) |
| `tr:` | 433 | 3.1% | (-1 0%) |
| `anilist:` | 112 | 0.8% | (-392 -78%) |
| `avail:` | 11 | 0.1% | (+9 +450%) |
| `jikan:` | 10 | 0.1% | (+4 +67%) |
| `src:` | 4 | 0.0% | (-22 -85%) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 11,461 |
| `episode:v11` | 983 |
| `ftree:v5` | 725 |
| `tr:fr` | 433 |
| `episode:v6` | 147 |
| `anilist:resp` | 111 |
| `episode:v5` | 75 |
| `episode:v7` | 13 |
| `avail:v4` | 11 |
| `jikan:eps` | 10 |
| `episode:v8` | 7 |
| `src:v13` | 4 |
| `episode:v9` | 2 |
| `anilist:list` | 1 |
| `episode:v10` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
