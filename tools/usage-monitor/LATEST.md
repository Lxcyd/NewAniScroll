# Usage Monitor — 2026-08-15

_Generated 2026-08-15T06:59:23.586Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **1,200** (-4,416 -79%) vs yesterday
- 7-day avg/day: **4,770**
- Projected month: **143,100** / 500,000 cap — **29%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,023** | scanned: 12,010 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 9,677 | 80.6% | (+12 +0%) |
| `episode:` | 1,941 | 16.2% | (+10 +1%) |
| `tr:` | 381 | 3.2% | (+16 +4%) |
| `anilist:` | 4 | 0.0% | — |
| `avail:` | 3 | 0.0% | (+1 +50%) |
| `jikan:` | 2 | 0.0% | (=) |
| `index_server_v2:` | 1 | 0.0% | — |
| `new_schedule:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 9,677 |
| `episode:v3` | 1,653 |
| `tr:fr` | 381 |
| `episode:v5` | 202 |
| `episode:v6` | 86 |
| `anilist:resp` | 4 |
| `avail:v3` | 3 |
| `jikan:eps` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
