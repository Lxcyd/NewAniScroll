# Usage Monitor — 2026-08-27

_Generated 2026-08-27T17:39:43.917Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **2,742** (-1,975 -42%) vs yesterday
- 7-day avg/day: **3,635**
- Projected month: **109,050** / 500,000 cap — **22%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,781** | scanned: 12,763 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 11,274 | 88.3% | (-234 -2%) |
| `episode:` | 949 | 7.4% | (-401 -30%) |
| `tr:` | 438 | 3.4% | (-3 -1%) |
| `anilist:` | 57 | 0.4% | (+32 +128%) |
| `src:` | 24 | 0.2% | — |
| `avail:` | 9 | 0.1% | (+5 +125%) |
| `jikan:` | 8 | 0.1% | (=) |
| `ftree:` | 3 | 0.0% | (-1 -25%) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 11,274 |
| `episode:v3` | 594 |
| `tr:fr` | 438 |
| `episode:v5` | 203 |
| `episode:v6` | 146 |
| `anilist:resp` | 57 |
| `src:v13` | 24 |
| `avail:v4` | 9 |
| `jikan:eps` | 8 |
| `episode:v7` | 6 |
| `ftree:v5` | 3 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
