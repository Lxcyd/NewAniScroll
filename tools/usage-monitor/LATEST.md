# Usage Monitor — 2026-08-14

_Generated 2026-08-14T07:52:49.805Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **789** (-6,080 -89%) vs yesterday
- 7-day avg/day: **6,150**
- Projected month: **184,500** / 500,000 cap — **37%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **11,971** | scanned: 11,965 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 9,665 | 80.8% | (+128 +1%) |
| `episode:` | 1,931 | 16.1% | (+3 +0%) |
| `tr:` | 365 | 3.1% | (+7 +2%) |
| `avail:` | 2 | 0.0% | (=) |
| `jikan:` | 2 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 9,665 |
| `episode:v3` | 1,653 |
| `tr:fr` | 365 |
| `episode:v5` | 201 |
| `episode:v6` | 77 |
| `avail:v3` | 2 |
| `jikan:eps` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
