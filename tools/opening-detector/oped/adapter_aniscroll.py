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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BRIDGE = Path(__file__).resolve().parents[1] / "bridge" / "resolve.mjs"
URL_CACHE_TTL = 6 * 3600  # signed stream URLs expire within ~a day; refresh before

# Hosts whose embed is NOT derived from (slug, season, lang) at all, so
# pinning them under a non-default `lang` is not guaranteed to actually
# change what's served — the bridge may silently keep returning the same
# encode regardless of the requested language.
#
# megaplay: per resolve_episodes' docstring below, its embed URL is built
# directly from a MAL id + episode number ("it isn't scraped from
# anime-sama's episodes.js like the other hosts"). There is no `lang` input
# anywhere in that construction. Confirmed empirically on SnK ep3: a
# `--lang vf` run against megaplay returned a stream with the EXACT same
# probed duration (1466.5s, to the decimal) as the `--lang vostfr` run —
# i.e. the same VOSTFR encode served back under a VF request, not a real
# French track. Until bridge/resolve.mjs is confirmed to branch on language
# for this host, treat it as VOSTFR-only and exclude it from VF runs rather
# than silently poisoning cross-host reconciliation with a mislabeled
# stream.
VF_INCOMPATIBLE_HOSTS = {"megaplay"}


def resolve_episodes(
    slug: str,
    season_dir: str,
    lang: str,
    ep_start: int,
    ep_end: int,
    *,
    cache_dir: str | Path = "cache/urls",
    host_pref: str | None = None,
    mal_id: int | str | None = None,
    va_slug: str | None = None,
) -> list[dict]:
    """Return [{ep, url, isM3U8, host}, ...] for the requested range.

    Uses the multi-host bridge: it tries hosts in priority order until one
    resolves the whole range. `host_pref` (comma list, e.g. "sibnet,sendvid")
    pins the host order — important for the series bank, which needs ALL
    episodes from the SAME host so their cuts align (different hosts can have
    different intros/offsets and would break cross-episode matching).

    `mal_id` is required if "megaplay" appears anywhere in `host_pref` (or in
    the bridge's default priority, when `host_pref` is omitted) — megaplay's
    embed URL is built directly from a MAL id + episode number, it isn't
    scraped from anime-sama's episodes.js like the other hosts. Without it,
    the bridge skips megaplay silently (logged in its `errors`, not raised).
    NOTE: this also means megaplay's embed carries no `lang` signal at all —
    see `VF_INCOMPATIBLE_HOSTS` above. Callers that need a specific language
    guarantee should not rely on megaplay for anything but VOSTFR.

    `va_slug` is required if "vidmoly-va" appears in `host_pref` — voir-anime is
    a separate site with its own per-season slugs (e.g.
    "shingeki-no-kyojin-vostfr"), so its embeds can't be derived from the
    anime-sama slug. Without it, the bridge skips vidmoly-va (logged, not raised).
    """
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    pref_tag = f"__{host_pref.replace(',', '-')}" if host_pref else ""
    mal_tag = f"__mal{mal_id}" if mal_id else ""
    va_tag = f"__va{va_slug}" if va_slug else ""
    key = f"{slug}__{season_dir}__{lang}__{ep_start}-{ep_end}{pref_tag}{mal_tag}{va_tag}.json"
    cache_file = cache_dir / key

    if cache_file.exists() and (time.time() - cache_file.stat().st_mtime) < URL_CACHE_TTL:
        data = json.loads(cache_file.read_text("utf-8"))
        if data.get("ok"):
            return data["episodes"]

    args = ["node", str(BRIDGE), slug, season_dir, lang, str(ep_start), str(ep_end)]
    if host_pref:
        args.append(host_pref)
        # The bridge reads malId as the 7th positional arg and vaSlug as the 8th,
        # both only when host_pref (6th) is present. vaSlug at position 8 needs
        # SOMETHING at position 7 — pass an empty string for malId when vaSlug is
        # given without one, so the positions don't shift.
        if mal_id or va_slug:
            args.append(str(mal_id) if mal_id else "")
        if va_slug:
            args.append(str(va_slug))
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


# Hosts we can pull server-side audio from, in the same priority the bridge uses.
# Kept in sync with DEFAULT_PRIORITY in bridge/resolve.mjs — see that file's
# comment for details:
#   - vidmoly (anime-sama source) & vidmoly-va (voir-anime source): the master
#     m3u8 token is IP-bound to whoever extracted the embed (the CF Worker). We
#     keep it valid by routing the ffmpeg pull THROUGH the Worker, which rewrites
#     every nested segment URL back through itself (wrapWorkerM3U8). vidmoly-va
#     additionally needs a voir-anime slug passed as `va_slug`.
#   - embed4me / lpayer: literally the SAME host (its URLs contain both
#     substrings, e.g. lpayer.embed4me.com) — listing both resolves the
#     identical stream twice under two different labels. Also IP-bound.
#   - uqload: no extractor registered for it at all; always fails — so it is
#     NOT in the default list. Including it only spent a Node resolve subprocess
#     per episode that could never yield a hit; over a 33k-episode backfill that
#     is pure wasted CDN/handshake load. Kept documented here so nobody re-adds
#     it expecting it to work; add an extractor first, then put it back.
MULTI_HOSTS = ["sibnet", "sendvid", "megaplay", "vidmoly", "vidmoly-va"]


def resolve_episodes_multi(
    slug: str,
    season_dir: str,
    lang: str,
    ep_start: int,
    ep_end: int,
    *,
    hosts: list[str] | None = None,
    cache_dir: str | Path = "cache/urls",
    mal_id: int | str | None = None,
    va_slug: str | None = None,
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

    Hosts are resolved IN PARALLEL (one Node subprocess + network round-trip
    per host, all independent of each other) — this is the dominant cost at
    the start of a multi-host run, so serializing it needlessly stalls
    everything downstream.

    Pass `mal_id` if "megaplay" is in `hosts` (or the default list) — without
    it, megaplay is skipped cleanly (its resolution needs a MAL id, not a
    slug/season, so there's nothing meaningful to try). Likewise pass `va_slug`
    if "vidmoly-va" is in `hosts` — voir-anime needs its own slug.

    When `lang != "vostfr"`, hosts in `VF_INCOMPATIBLE_HOSTS` are dropped
    before resolving anything: their embed construction has no `lang` input,
    so pinning them under e.g. "vf" risks silently re-serving the VOSTFR
    encode under a VF label, which would corrupt reconciliation rather than
    just be absent from it.
    """
    hosts = hosts or MULTI_HOSTS
    if lang != "vostfr":
        dropped = [h for h in hosts if h in VF_INCOMPATIBLE_HOSTS]
        if dropped:
            print(f"  [info] lang={lang!r}: skipping {dropped} — no lang signal "
                  f"in their embed construction, would risk a mislabeled stream")
        hosts = [h for h in hosts if h not in VF_INCOMPATIBLE_HOSTS]

    # Hosts that can't possibly resolve (missing mal_id/va_slug) are filtered
    # out BEFORE spinning up threads, so we don't waste a worker on something
    # that's a guaranteed no-op.
    eligible = [
        h for h in hosts
        if not (h == "megaplay" and not mal_id)
        and not (h == "vidmoly-va" and not va_slug)
    ]

    def _resolve_one(host: str) -> tuple[str, list[dict]]:
        try:
            eps = resolve_episodes(
                slug, season_dir, lang, ep_start, ep_end,
                host_pref=host, cache_dir=cache_dir, mal_id=mal_id,
                va_slug=va_slug,
            )
        except Exception:
            eps = []  # this host is down / has no match — its peers cover us
        return host, eps

    by_ep: dict[int, list[dict]] = {}
    if eligible:
        with ThreadPoolExecutor(max_workers=len(eligible)) as pool:
            for host, eps in pool.map(_resolve_one, eligible):
                for e in eps:
                    # The bridge tags each stream with the host it actually
                    # came from; trust that over our request (it can differ
                    # on partial fallbacks).
                    e.setdefault("host", host)
                    by_ep.setdefault(e["ep"], []).append(e)
    return by_ep