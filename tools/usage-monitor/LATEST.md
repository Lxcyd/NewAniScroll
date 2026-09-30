# Usage Monitor — 2026-09-30

_Generated 2026-09-30T12:39:44.777Z_

## ⚠️ Flags
- Key prefix `anilist:` **doubled** (292 → 798) — possible key-explosion or a cache-key bump.
- Key prefix `src:` **doubled** (170 → 456) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **5,229** | scanned: 5,179 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `anime:` | 2,110 | 40.7% | (+680 +48%) |
| `episode:` | 959 | 18.5% | (+308 +47%) |
| `anilist:` | 798 | 15.4% | (+506 +173%) |
| `src:` | 456 | 8.8% | (+286 +168%) |
| `avail:` | 337 | 6.5% | (+317 +1585%) |
| `ftree:` | 241 | 4.7% | (+237 +5925%) |
| `tr:` | 135 | 2.6% | (=) |
| `asSlug:` | 93 | 1.8% | (+73 +365%) |
| `asEps:` | 37 | 0.7% | (+33 +825%) |
| `lock:` | 8 | 0.2% | (+3 +60%) |
| `jikan:` | 4 | 0.1% | (-1 -20%) |
| `new_schedule:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `anime:v6` | 1,491 |
| `episode:v12` | 944 |
| `anilist:resp` | 797 |
| `anime:v5` | 619 |
| `src:v15` | 414 |
| `avail:v5` | 337 |
| `ftree:v5` | 240 |
| `tr:fr` | 135 |
| `asSlug:v1` | 93 |
| `src:v15f2` | 42 |
| `asEps:v1` | 37 |
| `episode:v11` | 15 |
| `lock:src` | 8 |
| `jikan:eps` | 4 |
| `anilist:list` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
