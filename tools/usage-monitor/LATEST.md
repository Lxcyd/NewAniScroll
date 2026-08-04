# Usage Monitor — 2026-08-04

_Generated 2026-08-04T13:31:55.508Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~146% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **9,707** (+1,870 +24%) vs yesterday
- 7-day avg/day: **24,334**
- Projected month: **730,020** / 500,000 cap — **146%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **6,273** | scanned: 6,205 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 4,051 | 65.3% | (+295 +8%) |
| `episode:` | 1,733 | 27.9% | (+64 +4%) |
| `src:` | 181 | 2.9% | (+180 +18000%) |
| `tr:` | 86 | 1.4% | (+6 +8%) |
| `avail:` | 82 | 1.3% | (+67 +447%) |
| `jikan:` | 44 | 0.7% | (+3 +7%) |
| `anilist:` | 26 | 0.4% | (+4 +18%) |
| `index_server_v2:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 4,051 |
| `episode:v3` | 1,653 |
| `src:v11` | 181 |
| `tr:fr` | 86 |
| `avail:v1` | 82 |
| `episode:v5` | 80 |
| `jikan:eps` | 44 |
| `anilist:resp` | 26 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
