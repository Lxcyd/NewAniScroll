# Usage Monitor — 2026-08-11

_Generated 2026-08-11T07:39:37.412Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **2,611** (-10,317 -80%) vs yesterday
- 7-day avg/day: **10,431**
- Projected month: **312,930** / 500,000 cap — **63%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **11,363** | scanned: 11,359 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 9,163 | 80.7% | (+61 +1%) |
| `episode:` | 1,905 | 16.8% | (+35 +2%) |
| `tr:` | 274 | 2.4% | (+42 +18%) |
| `anilist:` | 9 | 0.1% | (-16 -64%) |
| `avail:` | 3 | 0.0% | (-3 -50%) |
| `jikan:` | 2 | 0.0% | (-8 -80%) |
| `index_server_v2:` | 1 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | — |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 9,163 |
| `episode:v3` | 1,653 |
| `tr:fr` | 274 |
| `episode:v5` | 194 |
| `episode:v6` | 58 |
| `anilist:resp` | 9 |
| `avail:v3` | 3 |
| `jikan:eps` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
