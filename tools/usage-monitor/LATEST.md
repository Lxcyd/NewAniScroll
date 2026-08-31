# Usage Monitor — 2026-08-31

_Generated 2026-08-31T13:56:38.784Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **1,644** (-4,496 -73%) vs yesterday
- 7-day avg/day: **7,151**
- Projected month: **214,530** / 500,000 cap — **43%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,800** | scanned: 12,792 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 11,700 | 91.5% | (-415 -3%) |
| `episode:` | 632 | 4.9% | (-83 -12%) |
| `tr:` | 438 | 3.4% | (+16 +4%) |
| `avail:` | 11 | 0.1% | (+4 +57%) |
| `ftree:` | 6 | 0.0% | (+4 +200%) |
| `anilist:` | 3 | 0.0% | (-1 -25%) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `jikan:` | 1 | 0.0% | (-1 -50%) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 11,700 |
| `tr:fr` | 438 |
| `episode:v3` | 257 |
| `episode:v5` | 189 |
| `episode:v6` | 147 |
| `episode:v11` | 16 |
| `episode:v7` | 13 |
| `avail:v4` | 11 |
| `episode:v8` | 7 |
| `ftree:v5` | 6 |
| `anilist:resp` | 3 |
| `episode:v9` | 2 |
| `episode:v10` | 1 |
| `jikan:eps` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
