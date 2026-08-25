# Usage Monitor — 2026-08-25

_Generated 2026-08-25T07:10:20.294Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **517** (-1,235 -70%) vs yesterday
- 7-day avg/day: **3,811**
- Projected month: **114,330** / 500,000 cap — **23%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **13,583** | scanned: 13,573 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 11,550 | 85.1% | (-628 -5%) |
| `episode:` | 1,557 | 11.5% | (-438 -22%) |
| `tr:` | 449 | 3.3% | (-9 -2%) |
| `jikan:` | 8 | 0.1% | (-3 -27%) |
| `anilist:` | 5 | 0.0% | (+3 +150%) |
| `ftree:` | 3 | 0.0% | (+1 +50%) |
| `index_server_v3:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 11,550 |
| `episode:v3` | 1,213 |
| `tr:fr` | 449 |
| `episode:v5` | 203 |
| `episode:v6` | 139 |
| `jikan:eps` | 8 |
| `anilist:resp` | 5 |
| `ftree:v5` | 3 |
| `episode:v7` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
