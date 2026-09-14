# Usage Monitor — 2026-09-14

_Generated 2026-09-14T12:53:50.493Z_

## ⚠️ Flags
- Key prefix `episode:` **doubled** (207 → 1,833) — possible key-explosion or a cache-key bump.
- Key prefix `anime:` **doubled** (98 → 882) — possible key-explosion or a cache-key bump.
- Key prefix `avail:` **doubled** (68 → 294) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **3,959** | scanned: 3,701 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `episode:` | 1,833 | 49.5% | (+1,626 +786%) |
| `anime:` | 882 | 23.8% | (+784 +800%) |
| `anilist:` | 376 | 10.2% | (=) |
| `avail:` | 294 | 7.9% | (+226 +332%) |
| `ftree:` | 147 | 4.0% | (+139 +1738%) |
| `src:` | 94 | 2.5% | (-11 -10%) |
| `tr:` | 26 | 0.7% | (+17 +189%) |
| `asSlug:` | 23 | 0.6% | (+3 +15%) |
| `asEps:` | 22 | 0.6% | (+21 +2100%) |
| `lock:` | 2 | 0.1% | — |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `new_schedule:` | 1 | 0.0% | (=) |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `episode:v12` | 1,487 |
| `anime:v5` | 588 |
| `anilist:resp` | 373 |
| `episode:v11` | 346 |
| `anime:v6` | 294 |
| `avail:v5` | 294 |
| `ftree:v5` | 147 |
| `src:v14` | 94 |
| `tr:fr` | 26 |
| `asSlug:v1` | 23 |
| `asEps:v1` | 22 |
| `anilist:list` | 2 |
| `lock:src` | 2 |
| `anilist:rl` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
