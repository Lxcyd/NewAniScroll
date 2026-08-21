# Usage Monitor — 2026-08-21

_Generated 2026-08-21T07:09:25.938Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **4,412** (-7,236 -62%) vs yesterday
- 7-day avg/day: **7,445**
- Projected month: **223,350** / 500,000 cap — **45%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **14,251** | scanned: 14,066 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 11,592 | 82.4% | (+939 +9%) |
| `episode:` | 1,986 | 14.1% | (+4 +0%) |
| `tr:` | 464 | 3.3% | (+6 +1%) |
| `avail:` | 13 | 0.1% | — |
| `ftree:` | 8 | 0.1% | — |
| `jikan:` | 3 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 11,592 |
| `episode:v3` | 1,653 |
| `tr:fr` | 464 |
| `episode:v5` | 203 |
| `episode:v6` | 130 |
| `ftree:v5` | 8 |
| `avail:v3` | 7 |
| `avail:v4` | 6 |
| `jikan:eps` | 3 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
