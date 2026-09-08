# Usage Monitor — 2026-09-08

_Generated 2026-09-08T11:23:22.123Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~600% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **12,440** (-202,342 -94%) vs yesterday
- 7-day avg/day: **100,038**
- Projected month: **3,001,140** / 500,000 cap — **600%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **23,833** | scanned: 23,827 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 16,191 | 68.0% | (+2,168 +15%) |
| `episode:` | 5,854 | 24.6% | (+1,844 +46%) |
| `ftree:` | 1,213 | 5.1% | (-759 -38%) |
| `tr:` | 397 | 1.7% | (-36 -8%) |
| `src:` | 157 | 0.7% | (-55 -26%) |
| `avail:` | 8 | 0.0% | (-92 -92%) |
| `jikan:` | 7 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 16,191 |
| `episode:v11` | 5,688 |
| `ftree:v5` | 1,213 |
| `tr:fr` | 397 |
| `src:v14` | 157 |
| `episode:v6` | 126 |
| `episode:v5` | 17 |
| `episode:v7` | 13 |
| `avail:v5` | 8 |
| `episode:v8` | 7 |
| `jikan:eps` | 7 |
| `episode:v9` | 2 |
| `episode:v10` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
