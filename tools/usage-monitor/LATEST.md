# Usage Monitor — 2026-09-02

_Generated 2026-09-02T11:22:51.544Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **2,011** (-1,419 -41%) vs yesterday
- 7-day avg/day: **5,730**
- Projected month: **171,900** / 500,000 cap — **34%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,034** | scanned: 11,969 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 11,094 | 92.7% | (-435 -4%) |
| `tr:` | 444 | 3.7% | (-1 0%) |
| `episode:` | 392 | 3.3% | (-173 -31%) |
| `anilist:` | 31 | 0.3% | (+28 +933%) |
| `ftree:` | 3 | 0.0% | (-2 -40%) |
| `avail:` | 2 | 0.0% | — |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `jikan:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 11,094 |
| `tr:fr` | 444 |
| `episode:v5` | 189 |
| `episode:v6` | 147 |
| `anilist:resp` | 31 |
| `episode:v11` | 22 |
| `episode:v7` | 13 |
| `episode:v3` | 11 |
| `episode:v8` | 7 |
| `ftree:v5` | 3 |
| `avail:v4` | 2 |
| `episode:v9` | 2 |
| `episode:v10` | 1 |
| `jikan:eps` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
