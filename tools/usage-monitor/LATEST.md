# Usage Monitor — 2026-09-01

_Generated 2026-09-01T11:42:29.112Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **751** (-4,496 -86%) vs yesterday
- 7-day avg/day: **6,734**
- Projected month: **202,020** / 500,000 cap — **40%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,577** | scanned: 12,551 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 11,529 | 91.9% | (-171 -1%) |
| `episode:` | 565 | 4.5% | (-67 -11%) |
| `tr:` | 445 | 3.5% | (+7 +2%) |
| `ftree:` | 5 | 0.0% | (-1 -17%) |
| `anilist:` | 3 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `jikan:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | — |
| `recent-episode-v2:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 11,529 |
| `tr:fr` | 445 |
| `episode:v3` | 189 |
| `episode:v5` | 189 |
| `episode:v6` | 147 |
| `episode:v11` | 17 |
| `episode:v7` | 13 |
| `episode:v8` | 7 |
| `ftree:v5` | 5 |
| `anilist:resp` | 3 |
| `episode:v9` | 2 |
| `episode:v10` | 1 |
| `jikan:eps` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
