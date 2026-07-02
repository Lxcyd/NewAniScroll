"""AnimeThemes.moe client — resolve an anime to its OP/ED themes and the
exact episodes each theme covers.

AnimeThemes gives us, per theme:
  - the SONG (title + artists) and which EPISODES it plays in ("1-13"),
  - a clean, downloadable NC video (`https://v.animethemes.moe/...webm`).

It does NOT give the in-episode timestamp (where the OP starts/ends). That is
exactly what our fingerprint matcher recovers: fingerprint the KNOWN theme
audio once, then match each episode against it — the offset-histogram peak is
the OP's start inside that episode. See `theme_bank.py`.

Lookup path:
  MAL/AniList id  --/resource-->  anime slug  --/anime/{slug}-->  themes.

The `episodes` field is free-form and messy in the real catalog — ranges,
comma lists with gaps, single episodes, or None:
    "1-13"            single range
    "2-18, 20-25"     list of ranges/points (ep 19 has a different ED)
    "1000"            single episode
    None              a version with no episode mapping (skipped)
`parse_episode_spec` turns any of these into an inclusive-membership test.
"""

from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

API = "https://api.animethemes.moe"
VIDEO_HOST = "https://v.animethemes.moe"
CACHE_TTL = 24 * 3600  # theme metadata is static; be a good API citizen
USER_AGENT = "NewAniScroll-oped/1.0 (+skip-detector)"


# ── episode-spec parsing ─────────────────────────────────────────────────────


def parse_episode_spec(spec: str | None) -> list[tuple[int, int]]:
    """Parse an AnimeThemes `episodes` string into inclusive (lo, hi) ranges.

    "2-18, 20-25" -> [(2, 18), (20, 25)];  "1000" -> [(1000, 1000)];
    None / "" / unparseable fragments -> [] (a version with no mapping).
    """
    if not spec:
        return []
    ranges: list[tuple[int, int]] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        if m:
            lo, hi = int(m.group(1)), int(m.group(2))
            ranges.append((min(lo, hi), max(lo, hi)))
            continue
        m = re.fullmatch(r"\d+", part)
        if m:
            n = int(part)
            ranges.append((n, n))
    return ranges


def spec_covers(spec: str | None, episode: int) -> bool:
    return any(lo <= episode <= hi for lo, hi in parse_episode_spec(spec))


# ── data model ───────────────────────────────────────────────────────────────


@dataclass
class ThemeEntry:
    """One version of a theme, mapped to a set of episodes, with its video."""

    version: int
    episodes_spec: str | None
    video_url: str | None
    nc: bool
    resolution: int | None
    source: str | None  # "BD", "WEB", ...

    def covers(self, episode: int) -> bool:
        return spec_covers(self.episodes_spec, episode)


@dataclass
class Theme:
    """An OP or ED, e.g. slug='OP1', with one or more versioned entries."""

    slug: str                 # "OP1", "ED2"
    kind: str                 # "op" | "ed"
    sequence: int
    song: str | None
    artists: list[str] = field(default_factory=list)
    entries: list[ThemeEntry] = field(default_factory=list)

    def entry_for_episode(self, episode: int) -> ThemeEntry | None:
        """The best playable entry whose episode mapping covers `episode`.

        Prefer an entry with an actual video, then NC (clean, no on-screen
        credits/subs — cleaner audio anchor), then higher resolution.
        """
        matches = [e for e in self.entries if e.covers(episode) and e.video_url]
        if not matches:
            return None
        matches.sort(key=lambda e: (e.nc, e.resolution or 0), reverse=True)
        return matches[0]


# ── HTTP ─────────────────────────────────────────────────────────────────────


def _get(path: str, params: dict) -> dict:
    qs = urllib.parse.urlencode(params, safe="[],.")
    url = f"{API}{path}?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _cached_get(path: str, params: dict, cache_dir: Path, key: str) -> dict:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{key}.json"
    if cache_file.exists() and (time.time() - cache_file.stat().st_mtime) < CACHE_TTL:
        return json.loads(cache_file.read_text("utf-8"))
    data = _get(path, params)
    cache_file.write_text(json.dumps(data), "utf-8")
    return data


# ── public API ───────────────────────────────────────────────────────────────

_SITE = {"mal": "MyAnimeList", "anilist": "AniList"}


def resolve_slug(
    *,
    slug: str | None = None,
    mal_id: int | None = None,
    anilist_id: int | None = None,
    cache_dir: str | Path = "cache/animethemes",
) -> str | None:
    """Return the AnimeThemes anime slug for the given identity, or None.

    A slug is returned as-is. A MAL/AniList id is resolved through the
    `/resource` endpoint (external_id + site), which is the canonical mapping.
    """
    if slug:
        return slug
    if mal_id is not None:
        site, ext = _SITE["mal"], mal_id
    elif anilist_id is not None:
        site, ext = _SITE["anilist"], anilist_id
    else:
        raise ValueError("resolve_slug needs slug, mal_id, or anilist_id")

    data = _cached_get(
        "/resource",
        {
            "filter[site]": site,
            "filter[external_id]": ext,
            "include": "anime",
            "fields[anime]": "slug,name",
            "fields[resource]": "site,external_id",
        },
        Path(cache_dir),
        key=f"resource__{site}__{ext}",
    )
    for r in data.get("resources", []):
        for a in r.get("anime", []):
            if a.get("slug"):
                return a["slug"]
    return None


def fetch_themes(
    slug: str, *, cache_dir: str | Path = "cache/animethemes"
) -> list[Theme]:
    """Fetch normalized OP/ED themes for an anime slug."""
    data = _cached_get(
        f"/anime/{slug}",
        {
            "include": "animethemes.animethemeentries.videos,animethemes.song.artists",
            "fields[anime]": "slug,name",
            "fields[animetheme]": "type,sequence,slug",
            "fields[animethemeentry]": "episodes,version,nsfw,spoiler",
            "fields[video]": "link,nc,resolution,source",
            "fields[song]": "title",
            "fields[artist]": "name",
        },
        Path(cache_dir),
        key=f"anime__{slug}",
    )
    anime = data.get("anime") or {}
    out: list[Theme] = []
    for t in anime.get("animethemes", []):
        song = (t.get("song") or {}).get("title")
        artists = [a["name"] for a in (t.get("song") or {}).get("artists", [])]
        entries: list[ThemeEntry] = []
        for e in t.get("animethemeentries", []):
            vids = e.get("videos") or []
            # Best video for this entry: NC then highest resolution.
            vids = sorted(
                vids,
                key=lambda v: (bool(v.get("nc")), v.get("resolution") or 0),
                reverse=True,
            )
            v = vids[0] if vids else {}
            entries.append(
                ThemeEntry(
                    version=e.get("version") or 1,
                    episodes_spec=e.get("episodes"),
                    video_url=v.get("link"),
                    nc=bool(v.get("nc")),
                    resolution=v.get("resolution"),
                    source=v.get("source"),
                )
            )
        out.append(
            Theme(
                slug=t.get("slug") or f"{t.get('type')}{t.get('sequence')}",
                kind=(t.get("type") or "").lower(),  # "OP" -> "op"
                sequence=t.get("sequence") or 0,
                song=song,
                artists=artists,
                entries=entries,
            )
        )
    return out


def themes_for_episode(themes: list[Theme], episode: int) -> dict[str, Theme]:
    """The OP and ED theme (if any) whose mapping covers `episode`.

    Returns {"op": Theme|None, "ed": Theme|None}. If two themes of the same
    kind both claim the episode (rare data conflict), the lower sequence wins.
    """
    picked: dict[str, Theme] = {"op": None, "ed": None}
    for kind in ("op", "ed"):
        cands = [
            t
            for t in themes
            if t.kind == kind and t.entry_for_episode(episode) is not None
        ]
        cands.sort(key=lambda t: t.sequence)
        picked[kind] = cands[0] if cands else None
    return picked
