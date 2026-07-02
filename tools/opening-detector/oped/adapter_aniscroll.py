"""Real-episode fetch adapter: resolve stream URLs through THIS project's
extractor (Node bridge) and pull audio-only via ffmpeg.

Flow:
  resolve_sibnet.mjs  ->  [{ep, url}]  ->  load_audio(url)  ->  fingerprint
No video is ever downloaded (ffmpeg -vn in audio.py).

The resolved (signed) stream URLs are cached to disk per (slug, season, lang)
so we don't re-hit anime-sama / Sibnet on every run; the URLs carry an expiry
(`e=` param), so the cache is treated as stale after a TTL.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

BRIDGE = Path(__file__).resolve().parents[1] / "bridge" / "resolve.mjs"
URL_CACHE_TTL = 6 * 3600  # signed stream URLs expire within ~a day; refresh before


def resolve_episodes(
    slug: str,
    season_dir: str,
    lang: str,
    ep_start: int,
    ep_end: int,
    *,
    cache_dir: str | Path = "cache/urls",
    host_pref: str | None = None,
) -> list[dict]:
    """Return [{ep, url, isM3U8, host}, ...] for the requested range.

    Uses the multi-host bridge: it tries hosts in priority order until one
    resolves the whole range. `host_pref` (comma list, e.g. "embed4me,sibnet")
    pins the host order — important for the series bank, which needs ALL
    episodes from the SAME host so their cuts align (different hosts can have
    different intros/offsets and would break cross-episode matching).
    """
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    pref_tag = f"__{host_pref.replace(',', '-')}" if host_pref else ""
    key = f"{slug}__{season_dir}__{lang}__{ep_start}-{ep_end}{pref_tag}.json"
    cache_file = cache_dir / key

    if cache_file.exists() and (time.time() - cache_file.stat().st_mtime) < URL_CACHE_TTL:
        data = json.loads(cache_file.read_text("utf-8"))
        if data.get("ok"):
            return data["episodes"]

    args = ["node", str(BRIDGE), slug, season_dir, lang, str(ep_start), str(ep_end)]
    if host_pref:
        args.append(host_pref)
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"bridge failed (rc={proc.returncode}):\n{proc.stderr}")

    # The extractor prints diagnostic [sibnet] lines to stdout too; the JSON is
    # the LAST non-empty line.
    json_line = next(
        ln for ln in reversed(proc.stdout.splitlines()) if ln.strip().startswith("{")
    )
    data = json.loads(json_line)
    if not data.get("ok"):
        raise RuntimeError(f"resolution failed: {data.get('errors')}")

    cache_file.write_text(json.dumps(data), "utf-8")
    return data["episodes"]


# Hosts we can pull server-side audio from, in the same priority the bridge uses
# (vidmoly is browser-only / IP-bound, so it's excluded — ffmpeg can't fetch it).
MULTI_HOSTS = ["sibnet", "embed4me", "lpayer", "sendvid", "uqload"]


def resolve_episodes_multi(
    slug: str,
    season_dir: str,
    lang: str,
    ep_start: int,
    ep_end: int,
    *,
    hosts: list[str] | None = None,
    cache_dir: str | Path = "cache/urls",
) -> dict[int, list[dict]]:
    """Resolve the range from SEVERAL hosts and group the streams by episode.

    Returns {ep: [{ep, url, isM3U8, host}, ...]} — one entry per host that
    resolved that episode. This is the input to the multi-host detector: the
    SAME episode from different hosts is a different encode (different total
    duration), and cross-checking the OP/ED across them is what makes the
    delivered skip times robust to per-player duration differences.

    Each host is pinned individually (host_pref = that one host) so the bridge
    doesn't silently fall back to another host — we WANT one distinct encode per
    entry. A host that can't resolve the range is skipped, not fatal.
    """
    hosts = hosts or MULTI_HOSTS
    by_ep: dict[int, list[dict]] = {}
    for host in hosts:
        try:
            eps = resolve_episodes(
                slug, season_dir, lang, ep_start, ep_end,
                host_pref=host, cache_dir=cache_dir,
            )
        except Exception:
            continue  # this host is down / has no match — its peers cover us
        for e in eps:
            # The bridge tags each stream with the host it actually came from;
            # trust that over our request (it can differ on partial fallbacks).
            e.setdefault("host", host)
            by_ep.setdefault(e["ep"], []).append(e)
    return by_ep
