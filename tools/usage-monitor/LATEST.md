# Usage Monitor — 2026-08-30

_Generated 2026-08-30T11:57:26.109Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **1,070** (-10,750 -91%) vs yesterday
- 7-day avg/day: **6,752**
- Projected month: **202,560** / 500,000 cap — **41%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **13,268** | scanned: 13,268 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 12,115 | 91.3% | (+12 +0%) |
| `episode:` | 715 | 5.4% | (-14 -2%) |
| `tr:` | 422 | 3.2% | (+7 +2%) |
| `avail:` | 7 | 0.1% | (+4 +133%) |
| `anilist:` | 4 | 0.0% | (+1 +33%) |
| `ftree:` | 2 | 0.0% | (-4 -67%) |
| `jikan:` | 2 | 0.0% | (-7 -78%) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 12,115 |
| `tr:fr` | 422 |
| `episode:v3` | 352 |
| `episode:v5` | 189 |
| `episode:v6` | 147 |
| `episode:v7` | 13 |
| `avail:v4` | 7 |
| `episode:v8` | 7 |
| `anilist:resp` | 4 |
| `episode:v11` | 4 |
| `episode:v9` | 2 |
| `ftree:v5` | 2 |
| `jikan:eps` | 2 |
| `episode:v10` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
