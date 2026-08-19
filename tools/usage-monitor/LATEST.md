# Usage Monitor — 2026-08-19

_Generated 2026-08-19T07:07:36.802Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **1,433** (-3,385 -70%) vs yesterday
- 7-day avg/day: **5,554**
- Projected month: **166,620** / 500,000 cap — **33%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,732** | scanned: 12,602 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 10,148 | 80.5% | (+122 +1%) |
| `episode:` | 1,981 | 15.7% | (+5 +0%) |
| `tr:` | 456 | 3.6% | (+18 +4%) |
| `anilist:` | 5 | 0.0% | (-2 -29%) |
| `ftree:` | 5 | 0.0% | (-19 -79%) |
| `jikan:` | 4 | 0.0% | (-1 -20%) |
| `avail:` | 1 | 0.0% | — |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 10,148 |
| `episode:v3` | 1,653 |
| `tr:fr` | 456 |
| `episode:v5` | 203 |
| `episode:v6` | 125 |
| `anilist:resp` | 5 |
| `ftree:v5` | 5 |
| `jikan:eps` | 4 |
| `avail:v3` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
