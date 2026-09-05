# Usage Monitor — 2026-09-05

_Generated 2026-09-05T10:39:11.933Z_

## ⚠️ Flags
- Upstash projected at **83%** of the free cap — watch it.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **14,774** (-18,789 -56%) vs yesterday
- 7-day avg/day: **13,849**
- Projected month: **415,470** / 500,000 cap — **83%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **13,105** | scanned: 13,043 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 11,585 | 88.8% | (+683 +6%) |
| `anilist:` | 504 | 3.9% | (+246 +95%) |
| `tr:` | 434 | 3.3% | (-18 -4%) |
| `episode:` | 374 | 2.9% | (+73 +24%) |
| `ftree:` | 110 | 0.8% | (+105 +2100%) |
| `src:` | 26 | 0.2% | — |
| `jikan:` | 6 | 0.0% | (=) |
| `avail:` | 2 | 0.0% | — |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 11,585 |
| `anilist:resp` | 502 |
| `tr:fr` | 434 |
| `episode:v6` | 147 |
| `episode:v11` | 128 |
| `ftree:v5` | 110 |
| `episode:v5` | 76 |
| `src:v14` | 26 |
| `episode:v7` | 13 |
| `episode:v8` | 7 |
| `jikan:eps` | 6 |
| `anilist:list` | 2 |
| `avail:v5` | 2 |
| `episode:v9` | 2 |
| `episode:v10` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
