# Usage Monitor — 2026-08-26

_Generated 2026-08-26T07:10:40.464Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **627** (-6,772 -92%) vs yesterday
- 7-day avg/day: **2,878**
- Projected month: **86,340** / 500,000 cap — **17%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **13,342** | scanned: 13,341 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 11,508 | 86.3% | (-42 0%) |
| `episode:` | 1,350 | 10.1% | (-207 -13%) |
| `tr:` | 441 | 3.3% | (-8 -2%) |
| `anilist:` | 25 | 0.2% | (+20 +400%) |
| `jikan:` | 8 | 0.1% | (=) |
| `avail:` | 4 | 0.0% | — |
| `ftree:` | 4 | 0.0% | (+1 +33%) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 11,508 |
| `episode:v3` | 1,000 |
| `tr:fr` | 441 |
| `episode:v5` | 203 |
| `episode:v6` | 145 |
| `anilist:resp` | 25 |
| `jikan:eps` | 8 |
| `avail:v3` | 4 |
| `ftree:v5` | 4 |
| `episode:v7` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
