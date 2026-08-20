# Usage Monitor — 2026-08-20

_Generated 2026-08-20T07:08:25.557Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **2,033** (-4,364 -68%) vs yesterday
- 7-day avg/day: **6,476**
- Projected month: **194,280** / 500,000 cap — **39%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **13,097** | scanned: 13,097 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 10,653 | 81.3% | (+505 +5%) |
| `episode:` | 1,982 | 15.1% | (+1 +0%) |
| `tr:` | 458 | 3.5% | (+2 +0%) |
| `jikan:` | 3 | 0.0% | (-1 -25%) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 10,653 |
| `episode:v3` | 1,653 |
| `tr:fr` | 458 |
| `episode:v5` | 203 |
| `episode:v6` | 126 |
| `jikan:eps` | 3 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
