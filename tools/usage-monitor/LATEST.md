# Usage Monitor — 2026-08-17

_Generated 2026-08-17T07:17:36.957Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **2,151** (-7,034 -77%) vs yesterday
- 7-day avg/day: **5,241**
- Projected month: **157,230** / 500,000 cap — **31%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,473** | scanned: 12,366 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 9,958 | 80.5% | (+211 +2%) |
| `episode:` | 1,951 | 15.8% | (+8 +0%) |
| `tr:` | 403 | 3.3% | (+20 +5%) |
| `anilist:` | 31 | 0.3% | (+19 +158%) |
| `ftree:` | 21 | 0.2% | — |
| `avail:` | 1 | 0.0% | (=) |
| `jikan:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 9,958 |
| `episode:v3` | 1,653 |
| `tr:fr` | 403 |
| `episode:v5` | 203 |
| `episode:v6` | 95 |
| `anilist:resp` | 31 |
| `ftree:v5` | 21 |
| `avail:v3` | 1 |
| `jikan:eps` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
