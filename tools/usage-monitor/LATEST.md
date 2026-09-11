# Usage Monitor — 2026-09-11

_Generated 2026-09-11T11:26:06.985Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~493% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **69,659** (-252,226 -78%) vs yesterday
- 7-day avg/day: **82,087**
- Projected month: **2,462,610** / 500,000 cap — **493%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **304** | scanned: 304 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `ftree:` | 214 | 70.4% | (-21 -9%) |
| `anime:` | 75 | 24.7% | (+36 +92%) |
| `tr:` | 11 | 3.6% | (+9 +450%) |
| `episode:` | 4 | 1.3% | (-14 -78%) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `ftree:v5` | 214 |
| `anime:v5` | 75 |
| `tr:fr` | 11 |
| `episode:v11` | 4 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
