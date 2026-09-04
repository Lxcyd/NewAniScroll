# Usage Monitor — 2026-09-04

_Generated 2026-09-04T11:22:18.361Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **8,111** (-2,404 -23%) vs yesterday
- 7-day avg/day: **6,853**
- Projected month: **205,590** / 500,000 cap — **41%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,462** | scanned: 11,926 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 10,902 | 91.4% | (-14 0%) |
| `tr:` | 452 | 3.8% | (-4 -1%) |
| `episode:` | 301 | 2.5% | (-40 -12%) |
| `anilist:` | 258 | 2.2% | (+230 +821%) |
| `jikan:` | 6 | 0.1% | (+5 +500%) |
| `ftree:` | 5 | 0.0% | (-3 -37%) |
| `index_server_v3:` | 1 | 0.0% | — |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 10,902 |
| `tr:fr` | 452 |
| `anilist:resp` | 257 |
| `episode:v6` | 147 |
| `episode:v5` | 105 |
| `episode:v11` | 26 |
| `episode:v7` | 13 |
| `episode:v8` | 7 |
| `jikan:eps` | 6 |
| `ftree:v5` | 5 |
| `episode:v9` | 2 |
| `anilist:list` | 1 |
| `episode:v10` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
