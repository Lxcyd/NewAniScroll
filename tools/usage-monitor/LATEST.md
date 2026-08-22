# Usage Monitor — 2026-08-22

_Generated 2026-08-22T07:01:22.011Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **1,459** (-10,715 -88%) vs yesterday
- 7-day avg/day: **7,299**
- Projected month: **218,970** / 500,000 cap — **44%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **14,635** | scanned: 14,603 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 12,120 | 83.0% | (+528 +5%) |
| `episode:` | 1,989 | 13.6% | (+3 +0%) |
| `tr:` | 469 | 3.2% | (+5 +1%) |
| `anilist:` | 12 | 0.1% | — |
| `ftree:` | 5 | 0.0% | (-3 -37%) |
| `avail:` | 3 | 0.0% | (-10 -77%) |
| `jikan:` | 3 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | — |
| `new_schedule:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 12,120 |
| `episode:v3` | 1,653 |
| `tr:fr` | 469 |
| `episode:v5` | 203 |
| `episode:v6` | 131 |
| `anilist:resp` | 12 |
| `ftree:v5` | 5 |
| `jikan:eps` | 3 |
| `avail:v3` | 2 |
| `episode:v7` | 2 |
| `avail:v4` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
