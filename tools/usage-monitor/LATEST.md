# Usage Monitor — 2026-09-10

_Generated 2026-09-10T11:24:09.907Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~198% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).
- Daily commands **jumped 675%** vs yesterday — check recent deployments below.

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **146,500** (+127,607 +675%) vs yesterday
- 7-day avg/day: **33,079**
- Projected month: **992,370** / 500,000 cap — **198%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **879** | scanned: 876 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `avail:` | 325 | 37.1% | — |
| `src:` | 247 | 28.2% | — |
| `ftree:` | 235 | 26.8% | — |
| `anime:` | 39 | 4.5% | — |
| `episode:` | 18 | 2.1% | — |
| `lock:` | 7 | 0.8% | — |
| `anilist:` | 2 | 0.2% | — |
| `tr:` | 2 | 0.2% | — |
| `index_server_v3:` | 1 | 0.1% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `avail:v5` | 323 |
| `src:v14` | 244 |
| `ftree:v5` | 235 |
| `anime:v5` | 38 |
| `episode:v12` | 16 |
| `lock:src` | 7 |
| `src:v13` | 3 |
| `avail:v4` | 2 |
| `episode:v11` | 2 |
| `tr:fr` | 2 |
| `anilist:health` | 1 |
| `anilist:upcoming` | 1 |
| `anime:v6` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
