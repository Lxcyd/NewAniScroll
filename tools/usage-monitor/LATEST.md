# Usage Monitor — 2026-09-03

_Generated 2026-09-03T11:19:03.291Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **1,225** (-5,737 -82%) vs yesterday
- 7-day avg/day: **4,601**
- Projected month: **138,030** / 500,000 cap — **28%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **11,759** | scanned: 11,754 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 10,916 | 92.9% | (-178 -2%) |
| `tr:` | 456 | 3.9% | (+12 +3%) |
| `episode:` | 341 | 2.9% | (-51 -13%) |
| `anilist:` | 28 | 0.2% | (-3 -10%) |
| `ftree:` | 8 | 0.1% | (+5 +167%) |
| `avail:` | 3 | 0.0% | (+1 +50%) |
| `jikan:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 10,916 |
| `tr:fr` | 456 |
| `episode:v6` | 147 |
| `episode:v5` | 146 |
| `anilist:resp` | 27 |
| `episode:v11` | 25 |
| `episode:v7` | 13 |
| `ftree:v5` | 8 |
| `episode:v8` | 7 |
| `avail:v4` | 3 |
| `episode:v9` | 2 |
| `anilist:list` | 1 |
| `episode:v10` | 1 |
| `jikan:eps` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
