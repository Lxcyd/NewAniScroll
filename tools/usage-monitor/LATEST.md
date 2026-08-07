# Usage Monitor — 2026-08-07

_Generated 2026-08-07T07:43:39.270Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~103% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **5,642** (-9,960 -64%) vs yesterday
- 7-day avg/day: **17,104**
- Projected month: **513,120** / 500,000 cap — **103%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **9,555** | scanned: 9,538 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 7,431 | 77.9% | (+1,655 +29%) |
| `episode:` | 1,781 | 18.7% | (-2 0%) |
| `anilist:` | 166 | 1.7% | (+160 +2667%) |
| `tr:` | 131 | 1.4% | (+8 +7%) |
| `jikan:` | 19 | 0.2% | (-2 -10%) |
| `avail:` | 8 | 0.1% | (+2 +33%) |
| `index_server_v2:` | 1 | 0.0% | — |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 7,431 |
| `episode:v3` | 1,653 |
| `anilist:resp` | 166 |
| `tr:fr` | 131 |
| `episode:v5` | 128 |
| `jikan:eps` | 19 |
| `avail:v1` | 8 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
