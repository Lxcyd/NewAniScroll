# Usage Monitor — 2026-10-03

_Generated 2026-10-03T11:43:14.608Z_

## ⚠️ Flags
- Key prefix `anime:` **doubled** (5,484 → 12,411) — possible key-explosion or a cache-key bump.
- Key prefix `episode:` **doubled** (2,336 → 5,657) — possible key-explosion or a cache-key bump.
- Key prefix `src:` **doubled** (880 → 3,400) — possible key-explosion or a cache-key bump.
- Key prefix `ftree:` **doubled** (430 → 3,004) — possible key-explosion or a cache-key bump.
- Key prefix `avail:` **doubled** (61 → 319) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **25,643** | scanned: 25,598 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 12,411 | 48.5% | (+6,927 +126%) |
| `episode:` | 5,657 | 22.1% | (+3,321 +142%) |
| `src:` | 3,400 | 13.3% | (+2,520 +286%) |
| `ftree:` | 3,004 | 11.7% | (+2,574 +599%) |
| `anilist:` | 564 | 2.2% | (-654 -54%) |
| `avail:` | 319 | 1.2% | (+258 +423%) |
| `tr:` | 176 | 0.7% | (+12 +7%) |
| `asSlug:` | 50 | 0.2% | (-46 -48%) |
| `asEps:` | 7 | 0.0% | (-7 -50%) |
| `lock:` | 5 | 0.0% | (-17 -77%) |
| `jikan:` | 3 | 0.0% | (=) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 11,792 |
| `episode:v12` | 5,642 |
| `src:v15` | 3,386 |
| `ftree:v5` | 3,004 |
| `anime:v5` | 619 |
| `anilist:resp` | 562 |
| `avail:v5` | 319 |
| `tr:fr` | 176 |
| `asSlug:v1` | 50 |
| `episode:v11` | 15 |
| `src:v15f2` | 14 |
| `asEps:v1` | 7 |
| `lock:src` | 5 |
| `jikan:eps` | 3 |
| `anilist:list` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
