# Usage Monitor — 2026-08-24

_Generated 2026-08-24T07:30:28.959Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **226** (-1,341 -86%) vs yesterday
- 7-day avg/day: **5,732**
- Projected month: **171,960** / 500,000 cap — **34%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **14,655** | scanned: 14,648 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 12,178 | 83.1% | (-7 0%) |
| `episode:` | 1,995 | 13.6% | (+3 +0%) |
| `tr:` | 458 | 3.1% | (-13 -3%) |
| `jikan:` | 11 | 0.1% | (=) |
| `anilist:` | 2 | 0.0% | (=) |
| `ftree:` | 2 | 0.0% | (-3 -60%) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 12,178 |
| `episode:v3` | 1,653 |
| `tr:fr` | 458 |
| `episode:v5` | 203 |
| `episode:v6` | 137 |
| `jikan:eps` | 11 |
| `anilist:resp` | 2 |
| `episode:v7` | 2 |
| `ftree:v5` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
