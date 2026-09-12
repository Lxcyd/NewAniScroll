# Usage Monitor — 2026-09-12

_Generated 2026-09-12T10:51:20.446Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~493% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **0** (-69,661 -100%) vs yesterday
- 7-day avg/day: **82,088**
- Projected month: **2,462,640** / 500,000 cap — **493%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **90** | scanned: 90 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 75 | 83.3% | (=) |
| `tr:` | 11 | 12.2% | (=) |
| `episode:` | 4 | 4.4% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 75 |
| `tr:fr` | 11 |
| `episode:v11` | 4 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
