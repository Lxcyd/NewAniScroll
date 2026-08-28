# Usage Monitor — 2026-08-28

_Generated 2026-08-28T18:45:31.970Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **7,329** (+891 +14%) vs yesterday
- 7-day avg/day: **5,527**
- Projected month: **165,810** / 500,000 cap — **33%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,837** | scanned: 12,837 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 11,563 | 90.1% | (+289 +3%) |
| `episode:` | 740 | 5.8% | (-209 -22%) |
| `tr:` | 428 | 3.3% | (-10 -2%) |
| `anilist:` | 70 | 0.5% | (+13 +23%) |
| `ftree:` | 15 | 0.1% | (+12 +400%) |
| `avail:` | 11 | 0.1% | (+2 +22%) |
| `jikan:` | 9 | 0.1% | (+1 +13%) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 11,563 |
| `tr:fr` | 428 |
| `episode:v3` | 379 |
| `episode:v5` | 192 |
| `episode:v6` | 147 |
| `anilist:resp` | 70 |
| `ftree:v5` | 15 |
| `episode:v7` | 14 |
| `jikan:eps` | 9 |
| `episode:v8` | 8 |
| `avail:v3` | 6 |
| `avail:v4` | 5 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
