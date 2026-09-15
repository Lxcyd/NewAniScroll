# Usage Monitor — 2026-09-15

_Generated 2026-09-15T11:48:15.671Z_

## ⚠️ Flags
- Key prefix `anilist:` **doubled** (376 → 907) — possible key-explosion or a cache-key bump.
- Key prefix `src:` **doubled** (94 → 419) — possible key-explosion or a cache-key bump.

## Upstash — daily commands
> _skipped: Upstash mgmt 401 on /v2/redis/databases: {"error":"Unauthorized"}_

## Redis keyspace census (where the load comes from)
- DBSIZE: **7,960** | scanned: 6,509 keys

| prefix | keys | % | Δ vs prev |
|---|---:|---:|---:|
| `episode:` | 2,879 | 44.2% | (+1,046 +57%) |
| `anime:` | 1,648 | 25.3% | (+766 +87%) |
| `anilist:` | 907 | 13.9% | (+531 +141%) |
| `src:` | 419 | 6.4% | (+325 +346%) |
| `avail:` | 367 | 5.6% | (+73 +25%) |
| `ftree:` | 133 | 2.0% | (-14 -10%) |
| `asSlug:` | 97 | 1.5% | (+74 +322%) |
| `tr:` | 27 | 0.4% | (+1 +4%) |
| `asEps:` | 25 | 0.4% | (+3 +14%) |
| `lock:` | 3 | 0.0% | (+1 +50%) |
| `index_server_v3:` | 1 | 0.0% | (=) |
| `jikan:` | 1 | 0.0% | — |
| `new_schedule:` | 1 | 0.0% | (=) |
| `recent-episode-v2:` | 1 | 0.0% | — |

<details><summary>Top 2-segment namespaces</summary>

| namespace | keys |
|---|---:|
| `episode:v12` | 2,533 |
| `anime:v5` | 1,027 |
| `anilist:resp` | 905 |
| `anime:v6` | 621 |
| `src:v14` | 419 |
| `avail:v5` | 365 |
| `episode:v11` | 346 |
| `ftree:v5` | 133 |
| `asSlug:v1` | 97 |
| `tr:fr` | 27 |
| `asEps:v1` | 25 |
| `lock:src` | 3 |
| `avail:v4` | 2 |
| `anilist:list` | 1 |
| `anilist:rl` | 1 |

</details>

## Vercel — recent deployments
> _no VERCEL_TOKEN — deployment correlation unavailable_
