# Usage Monitor — 2026-08-12

_Generated 2026-08-12T07:54:34.804Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **841** (-5,303 -86%) vs yesterday
- 7-day avg/day: **8,264**
- Projected month: **247,920** / 500,000 cap — **50%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **11,461** | scanned: 11,460 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 9,212 | 80.4% | (+49 +1%) |
| `episode:` | 1,916 | 16.7% | (+11 +1%) |
| `tr:` | 300 | 2.6% | (+26 +9%) |
| `anilist:` | 28 | 0.2% | (+19 +211%) |
| `avail:` | 1 | 0.0% | (-2 -67%) |
| `index_server_v2:` | 1 | 0.0% | (=) |
| `jikan:` | 1 | 0.0% | (-1 -50%) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 9,212 |
| `episode:v3` | 1,653 |
| `tr:fr` | 300 |
| `episode:v5` | 199 |
| `episode:v6` | 64 |
| `anilist:resp` | 28 |
| `avail:v1` | 1 |
| `jikan:eps` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
