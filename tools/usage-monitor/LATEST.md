# Usage Monitor — 2026-08-05

_Generated 2026-08-05T09:08:10.221Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~136% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **4,720** (-37,585 -89%) vs yesterday
- 7-day avg/day: **22,733**
- Projected month: **681,990** / 500,000 cap — **136%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **6,937** | scanned: 6,929 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 5,037 | 72.7% | (+986 +24%) |
| `episode:` | 1,751 | 25.3% | (+18 +1%) |
| `tr:` | 93 | 1.3% | (+7 +8%) |
| `jikan:` | 40 | 0.6% | (-4 -9%) |
| `anilist:` | 6 | 0.1% | (-20 -77%) |
| `avail:` | 1 | 0.0% | (-81 -99%) |
| `index_server_v2:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 5,037 |
| `episode:v3` | 1,653 |
| `episode:v5` | 98 |
| `tr:fr` | 93 |
| `jikan:eps` | 40 |
| `anilist:resp` | 6 |
| `avail:v1` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
