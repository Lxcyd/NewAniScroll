# Usage Monitor — 2026-08-18

_Generated 2026-08-18T07:06:09.447Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **898** (-9,050 -91%) vs yesterday
- 7-day avg/day: **5,607**
- Projected month: **168,210** / 500,000 cap — **34%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,493** | scanned: 12,477 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 10,026 | 80.4% | (+68 +1%) |
| `episode:` | 1,976 | 15.8% | (+25 +1%) |
| `tr:` | 438 | 3.5% | (+35 +9%) |
| `ftree:` | 24 | 0.2% | (+3 +14%) |
| `anilist:` | 7 | 0.1% | (-24 -77%) |
| `jikan:` | 5 | 0.0% | (+4 +400%) |
| `index_server_v3:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 10,026 |
| `episode:v3` | 1,653 |
| `tr:fr` | 438 |
| `episode:v5` | 203 |
| `episode:v6` | 120 |
| `ftree:v5` | 24 |
| `anilist:resp` | 7 |
| `jikan:eps` | 5 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
