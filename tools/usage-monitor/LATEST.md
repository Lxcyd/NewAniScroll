# Usage Monitor — 2026-08-13

_Generated 2026-08-13T07:55:30.890Z_

## ⚠️ Flags
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **3,464** (-556 -14%) vs yesterday
- 7-day avg/day: **6,746**
- Projected month: **202,380** / 500,000 cap — **40%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **11,957** | scanned: 11,884 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 9,537 | 80.3% | (+325 +4%) |
| `episode:` | 1,928 | 16.2% | (+12 +1%) |
| `tr:` | 358 | 3.0% | (+58 +19%) |
| `anilist:` | 55 | 0.5% | (+27 +96%) |
| `avail:` | 2 | 0.0% | (+1 +100%) |
| `jikan:` | 2 | 0.0% | (+1 +100%) |
| `new_schedule:` | 1 | 0.0% | (=) |
| `recent-episode-v2:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 9,537 |
| `episode:v3` | 1,653 |
| `tr:fr` | 358 |
| `episode:v5` | 200 |
| `episode:v6` | 75 |
| `anilist:resp` | 55 |
| `avail:v3` | 2 |
| `jikan:eps` | 2 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
