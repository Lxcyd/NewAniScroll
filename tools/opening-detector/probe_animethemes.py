"""End-to-end validation of AnimeThemes-anchored OP/ED detection (windowed).

Pipeline (SnK S1 as the fixture):
  MAL id --> AnimeThemes slug --> themes (OP1/OP2/ED1/ED2 + episode maps)
  build a fingerprinted REFERENCE per theme VERSION from its clean NC .webm
  resolve real episodes (anime-sama -> Sibnet)
  for each episode, decode only the OP window (first 4 min) + ED window
    (last 3 min) via ffmpeg seek — NOT the whole 24 min — and match against
    the themes AnimeThemes says cover that episode
  -> recovered (start,end) in ABSOLUTE episode time

Speed: two short windows replace a full-episode download. AniSkip is NOT used
as a source of truth (poor coverage); it's printed only as a loose sanity
reference where present.

Fallback:
  - episode with NO mapped theme (hole in `episodes`, e.g. Kimetsu ep19) ->
    match against the cour's OP/ED refs anyway, marked `inferred`.
  - expected theme not found in the window -> theme_bank retries full episode.

Run:  python probe_animethemes.py
"""

from __future__ import annotations

import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.adapter_aniscroll import resolve_episodes
from oped.animethemes import Theme, fetch_themes, resolve_slug, themes_for_episode
from oped.audio import load_audio
from oped.fingerprint import fingerprint
from oped.theme_bank import (
    ED_WINDOW,
    OP_WINDOW,
    ThemeReference,
    build_references,
    detect_op_ed,
)

MAL_ID = 16498            # Shingeki no Kyojin S1
SLUG = "shingeki-no-kyojin"   # anime-sama slug (our extractor)
SEASON = "saison1"
LANG = "vostfr"
EP_START, EP_END = 1, 2
MAX_WORKERS = 4          # be gentle on Sibnet


def aniskip(ep: int) -> dict:
    """Loose sanity reference only (NOT ground truth — coverage is poor)."""
    url = (
        f"https://api.aniskip.com/v2/skip-times/{MAL_ID}/{ep}"
        "?types=op&types=ed&episodeLength=0"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "oped-detector"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.load(r)
    except Exception:
        return {}
    out = {}
    for res in data.get("results", []):
        iv = res["interval"]
        out[res["skipType"]] = (iv["startTime"], iv["endTime"])
    return out


def ms(s: float) -> str:
    return f"{int(s)//60}:{int(s)%60:02d}"


def clock(iv) -> str:
    return f"{ms(iv[0])}-{ms(iv[1])}" if iv else "—"


def main() -> None:
    # 1. AnimeThemes: id -> slug -> themes
    at_slug = resolve_slug(mal_id=MAL_ID)
    print(f"AnimeThemes slug for MAL {MAL_ID}: {at_slug}")
    themes = fetch_themes(at_slug)
    for t in themes:
        eps = " | ".join(f"v{e.version}:{e.episodes_spec}" for e in t.entries)
        print(f"  {t.slug:4} {t.kind}  {t.song!r} — {eps}")

    # 2. Build one fingerprinted reference per theme version (cached once each).
    print("\nBuilding theme references (clean NC audio, fingerprinted once)…")
    refs_by_theme: dict[str, list[ThemeReference]] = {}
    for t in themes:
        rs = build_references(t, slug_prefix=f"animethemes/{at_slug}")
        if rs:
            refs_by_theme[t.slug] = rs
            print(f"  {t.slug}: {len(rs)} version(s), "
                  f"{[f'{r.duration:.0f}s' for r in rs]}")

    # Cour fallback pools: all OP refs and all ED refs across the anime, so an
    # UNMAPPED episode can still be matched against the season's themes.
    op_pool = [r for rs in refs_by_theme.values() for r in rs if r.kind == "op"]
    ed_pool = [r for rs in refs_by_theme.values() for r in rs if r.kind == "ed"]

    # 3. Resolve real episodes (URLs only — no full decode here).
    print(f"\nResolving SnK S1 ep{EP_START}-{EP_END} (anime-sama→Sibnet)…")
    eps = resolve_episodes(SLUG, SEASON, LANG, EP_START, EP_END)
    eps.sort(key=lambda e: e["ep"])

    def process(e: dict):
        ep = e["ep"]
        url = e["url"]
        base_key = f"{SLUG}/{SEASON}/{LANG}/ep{ep}"

        # Episode duration converts the ED end-of-file window (-sseof) into an
        # absolute offset. ffprobe reads only the container header, not the
        # whole stream, so this is cheap.
        ep_dur = _probe_duration(url)

        def resolve_window(win):
            # load_audio folds the window into the cache filename, so the OP
            # window, ED window, and full-episode fallback cache separately.
            samples = load_audio(url, cache_key=base_key, window=win)
            return fingerprint(samples)

        # Which themes does AnimeThemes map to this episode?
        picked = themes_for_episode(themes, ep)
        op_refs = refs_by_theme.get(picked["op"].slug, []) if picked["op"] else []
        ed_refs = refs_by_theme.get(picked["ed"].slug, []) if picked["ed"] else []

        inferred_op = inferred_ed = False
        if not op_refs and op_pool:      # hole in mapping -> cour fallback
            op_refs, inferred_op = op_pool, True
        if not ed_refs and ed_pool:
            ed_refs, inferred_ed = ed_pool, True

        hits = detect_op_ed(
            resolve_window, ep_dur, op_refs, ed_refs,
            op_window=OP_WINDOW, ed_window=ED_WINDOW,
        )
        for h in hits:
            if (h.kind == "op" and inferred_op) or (h.kind == "ed" and inferred_ed):
                h.inferred = True
        return ep, ep_dur, hits

    results = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for ep, dur, hits in pool.map(process, eps):
            results.append((ep, dur, hits))
            print(f"  ep{ep}: {dur/60:.1f} min, {len(hits)} hit(s)")

    # 4. Report.
    print("\nRecovered OP/ED (windowed, absolute episode time):\n")
    hdr = f"{'ep':>3}  {'kind':>4}  {'theme':>6}  {'recovered':>13}  {'votes':>6}  {'aniskip?':>13}"
    print(hdr)
    print("-" * len(hdr))
    for ep, _dur, hits in sorted(results):
        truth = aniskip(ep)
        by_kind = {h.kind: h for h in hits}
        for kind in ("op", "ed"):
            h = by_kind.get(kind)
            gt = truth.get(kind)
            if h is None and gt is None:
                continue
            theme = f"{h.slug}{'*' if h and h.inferred else ''}" if h else "—"
            rec = (h.start, h.end) if h else None
            votes = h.votes if h else 0
            print(f"{ep:>3}  {kind:>4}  {theme:>6}  {clock(rec):>13}  "
                  f"{votes:>6}  {clock(gt):>13}")
    print("\n(* = matched via cour fallback; aniskip column is a loose sanity "
          "check only, not ground truth)")


def _probe_duration(url: str) -> float:
    """Episode duration in seconds via ffprobe (header-only, no full read)."""
    import subprocess
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", url,
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception:
        return 24 * 60.0  # sane default; ED offset just becomes approximate


if __name__ == "__main__":
    main()
