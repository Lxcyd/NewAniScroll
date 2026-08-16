# Usage Monitor — 2026-08-16

_Generated 2026-08-16T07:00:51.232Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **1,465** (-921 -39%) vs yesterday
- 7-day avg/day: **4,071**
- Projected month: **122,130** / 500,000 cap — **24%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **12,153** | scanned: 12,088 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 9,747 | 80.6% | (+70 +1%) |
| `episode:` | 1,943 | 16.1% | (+2 +0%) |
| `tr:` | 383 | 3.2% | (+2 +1%) |
| `anilist:` | 12 | 0.1% | (+8 +200%) |
| `avail:` | 1 | 0.0% | (-2 -67%) |
| `jikan:` | 1 | 0.0% | (-1 -50%) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 9,747 |
| `episode:v3` | 1,653 |
| `tr:fr` | 383 |
| `episode:v5` | 202 |
| `episode:v6` | 88 |
| `anilist:resp` | 12 |
| `avail:v1` | 1 |
| `jikan:eps` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
