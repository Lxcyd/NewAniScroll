# Usage Monitor — 2026-09-07

_Generated 2026-09-07T12:39:13.829Z_

## ⚠️ Flags
- **Upstash on track to blow the free cap** (~360% of 500,000) → cache will die mid-month. Split dev/prod or go pay-as-you-go.
- Only **1 Upstash DB** on the account → dev & prod likely share it (see DEVLOG 2026-07-30).
- Key prefix `episode:` **doubled** (1,228 → 4,010) — possible key-explosion or a cache-key bump.
- Key prefix `ftree:` **doubled** (725 → 1,972) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> DBs on account: **1** — dev (Preview) & prod SHARE this DB; the number below mixes both.

- DB: `aniscroll-cache`
- Today: **16,631** (-147,260 -90%) vs yesterday
- 7-day avg/day: **60,022**
- Projected month: **1,800,660** / 500,000 cap — **360%**

## Redis keyspace census (where the load comes from)
- DBSIZE: **20,762** | scanned: 20,758 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 14,023 | 67.6% | (+2,562 +22%) |
| `episode:` | 4,010 | 19.3% | (+2,782 +227%) |
| `ftree:` | 1,972 | 9.5% | (+1,247 +172%) |
| `tr:` | 433 | 2.1% | (=) |
| `src:` | 212 | 1.0% | (+208 +5200%) |
| `avail:` | 100 | 0.5% | (+89 +809%) |
| `jikan:` | 7 | 0.0% | (-3 -30%) |
| `anilist:` | 1 | 0.0% | (-111 -99%) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v5` | 14,023 |
| `episode:v11` | 3,778 |
| `ftree:v5` | 1,971 |
| `tr:fr` | 433 |
| `src:v14` | 212 |
| `episode:v6` | 147 |
| `avail:v5` | 96 |
| `episode:v5` | 62 |
| `episode:v7` | 13 |
| `episode:v8` | 7 |
| `jikan:eps` | 7 |
| `avail:v4` | 4 |
| `episode:v9` | 2 |
| `anilist:list` | 1 |
| `episode:v10` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
