# Usage Monitor — 2026-08-23

_Generated 2026-08-23T07:03:01.172Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **828** (-2,216 -73%) vs yesterday
- 7-day avg/day: **6,818**
- Projected month: **204,540** / 500,000 cap — **41%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **14,694** | scanned: 14,672 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 12,185 | 83.0% | (+65 +1%) |
| `episode:` | 1,992 | 13.6% | (+3 +0%) |
| `tr:` | 471 | 3.2% | (+2 +0%) |
| `jikan:` | 11 | 0.1% | (+8 +267%) |
| `avail:` | 5 | 0.0% | (+2 +67%) |
| `ftree:` | 5 | 0.0% | (=) |
| `anilist:` | 2 | 0.0% | (-10 -83%) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 12,185 |
| `episode:v3` | 1,653 |
| `tr:fr` | 471 |
| `episode:v5` | 203 |
| `episode:v6` | 134 |
| `jikan:eps` | 11 |
| `avail:v3` | 5 |
| `ftree:v5` | 5 |
| `anilist:resp` | 2 |
| `episode:v7` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
