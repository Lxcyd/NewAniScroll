# Usage Monitor — 2026-08-29

_Generated 2026-08-29T12:42:43.988Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **5,158** (-4,555 -47%) vs yesterday
- 7-day avg/day: **6,685**
- Projected month: **200,550** / 500,000 cap — **40%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **13,274** | scanned: 13,274 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 12,103 | 91.2% | (+540 +5%) |
| `episode:` | 729 | 5.5% | (-11 -1%) |
| `tr:` | 415 | 3.1% | (-13 -3%) |
| `jikan:` | 9 | 0.1% | (=) |
| `ftree:` | 6 | 0.0% | (-9 -60%) |
| `src:` | 5 | 0.0% | — |
| `anilist:` | 3 | 0.0% | (-67 -96%) |
| `avail:` | 3 | 0.0% | (-8 -73%) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 12,103 |
| `tr:fr` | 415 |
| `episode:v3` | 368 |
| `episode:v5` | 191 |
| `episode:v6` | 147 |
| `episode:v7` | 13 |
| `jikan:eps` | 9 |
| `episode:v8` | 8 |
| `ftree:v5` | 6 |
| `src:v13` | 5 |
| `anilist:resp` | 3 |
| `avail:v4` | 3 |
| `episode:v9` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
