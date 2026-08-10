# Usage Monitor — 2026-08-10

_Generated 2026-08-10T08:06:05.561Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **4,043** (-3,132 -44%) vs yesterday
- 7-day avg/day: **11,252**
- Projected month: **337,560** / 500,000 cap — **68%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **11,275** | scanned: 11,247 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 9,102 | 80.9% | (+110 +1%) |
| `episode:` | 1,870 | 16.6% | (+10 +1%) |
| `tr:` | 232 | 2.1% | (+59 +34%) |
| `anilist:` | 25 | 0.2% | (+7 +39%) |
| `jikan:` | 10 | 0.1% | (-10 -50%) |
| `avail:` | 6 | 0.1% | (+1 +20%) |
| `index_server_v2:` | 1 | 0.0% | — |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 9,102 |
| `episode:v3` | 1,653 |
| `tr:fr` | 232 |
| `episode:v5` | 186 |
| `episode:v6` | 31 |
| `anilist:resp` | 25 |
| `jikan:eps` | 10 |
| `avail:v3` | 4 |
| `avail:v1` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
