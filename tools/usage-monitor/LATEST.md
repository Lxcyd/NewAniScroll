# Usage Monitor — 2026-08-06

_Generated 2026-08-06T09:08:31.513Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~135% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **3,994** (-10,139 -72%) vs yesterday
- 7-day avg/day: **22,498**
- Projected month: **674,940** / 500,000 cap — **135%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **7,756** | scanned: 7,749 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 5,776 | 74.5% | (+739 +15%) |
| `episode:` | 1,783 | 23.0% | (+32 +2%) |
| `tr:` | 123 | 1.6% | (+30 +32%) |
| `src:` | 33 | 0.4% | — |
| `jikan:` | 21 | 0.3% | (-19 -47%) |
| `anilist:` | 6 | 0.1% | (=) |
| `avail:` | 6 | 0.1% | (+5 +500%) |
| `new_schedule:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 5,776 |
| `episode:v3` | 1,653 |
| `episode:v5` | 130 |
| `tr:fr` | 123 |
| `src:v11` | 33 |
| `jikan:eps` | 21 |
| `anilist:resp` | 6 |
| `avail:v1` | 6 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
