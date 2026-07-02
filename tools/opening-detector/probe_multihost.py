"""Multi-host OP/ED detection harness — validates that cross-host reconciliation
survives per-player duration differences.

Same fixture as probe_animethemes.py (SnK S1), but instead of a single host it
resolves each episode from every audio-capable host (Sibnet, embed4me, …),
detects the OP/ED against EACH host's own encode (its own duration), and
reconciles into one robust interval per kind. The report shows, per host, the
raw recovered timecodes + each host's duration, then the reconciled consensus —
so you can see the duration spread the reconciliation is absorbing.

Run:  python probe_multihost.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from oped.adapter_aniscroll import resolve_episodes_multi
from oped.animethemes import fetch_themes, resolve_slug, themes_for_episode
from oped.audio import load_audio
from oped.fingerprint import fingerprint
from oped.multi_host import HostStream, detect_op_ed_multi
from oped.theme_bank import (
    ED_WINDOW,
    OP_WINDOW,
    ThemeReference,
    build_references,
    detect_op_ed,
)

MAL_ID = 16498
SLUG = "shingeki-no-kyojin"
SEASON = "saison1"
LANG = "vostfr"
EP_START, EP_END = 1, 2


def ms(s: float) -> str:
    return f"{int(s)//60}:{int(s)%60:02d}"


def clock(iv) -> str:
    return f"{ms(iv[0])}-{ms(iv[1])}" if iv else "—"


def _probe_duration(url: str) -> float:
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", url,
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception:
        return 24 * 60.0


def main() -> None:
    at_slug = resolve_slug(mal_id=MAL_ID)
    print(f"AnimeThemes slug for MAL {MAL_ID}: {at_slug}")
    themes = fetch_themes(at_slug)

    refs_by_theme: dict[str, list[ThemeReference]] = {}
    for t in themes:
        rs = build_references(t, slug_prefix=f"animethemes/{at_slug}")
        if rs:
            refs_by_theme[t.slug] = rs
    op_pool = [r for rs in refs_by_theme.values() for r in rs if r.kind == "op"]
    ed_pool = [r for rs in refs_by_theme.values() for r in rs if r.kind == "ed"]

    print(f"\nResolving SnK S1 ep{EP_START}-{EP_END} from ALL hosts…")
    by_ep = resolve_episodes_multi(SLUG, SEASON, LANG, EP_START, EP_END)

    for ep in sorted(by_ep):
        streams_raw = by_ep[ep]
        # Build a HostStream (with its OWN duration) per host resolution.
        streams: list[HostStream] = []
        for e in streams_raw:
            dur = _probe_duration(e["url"])
            streams.append(HostStream(host=e.get("host", "?"), url=e["url"], duration=dur))

        picked = themes_for_episode(themes, ep)
        op_refs = refs_by_theme.get(picked["op"].slug, []) if picked["op"] else []
        ed_refs = refs_by_theme.get(picked["ed"].slug, []) if picked["ed"] else []
        if not op_refs and op_pool:
            op_refs = op_pool
        if not ed_refs and ed_pool:
            ed_refs = ed_pool

        base_key = f"{SLUG}/{SEASON}/{LANG}/ep{ep}"

        def resolve_window_for(stream: HostStream, win):
            samples = load_audio(
                stream.url, cache_key=f"{base_key}/{stream.host}", window=win
            )
            return fingerprint(samples)

        # Per-host raw view (for the report) + reconciled consensus.
        print(f"\nep{ep}: {len(streams)} host(s), durations "
              f"{[f'{s.host}={s.duration/60:.2f}m' for s in streams]}")
        for s in streams:
            hits = detect_op_ed(
                lambda win, _s=s: resolve_window_for(_s, win),
                s.duration, op_refs, ed_refs,
                op_window=OP_WINDOW, ed_window=ED_WINDOW,
            )
            bk = {h.kind: h for h in hits}
            print(f"    {s.host:8}  "
                  f"OP {clock((bk['op'].start, bk['op'].end)) if 'op' in bk else '—':>13}  "
                  f"ED {clock((bk['ed'].start, bk['ed'].end)) if 'ed' in bk else '—':>13}")

        reconciled = detect_op_ed_multi(
            streams, resolve_window_for, op_refs, ed_refs,
            op_window=OP_WINDOW, ed_window=ED_WINDOW,
        )
        print("  reconciled:")
        for h in reconciled:
            fe = (f", from_end={ms(h.from_end_start)}"
                  if h.from_end_start is not None else "")
            print(f"    {h.kind.upper()} {h.slug:5} {clock((h.start, h.end))}  "
                  f"agree={h.n_hosts_agree}/{h.n_hosts_total} spread={h.spread_s:.1f}s "
                  f"votes={h.votes} conf={h.confident}{fe} "
                  f"(canon {h.canonical_duration/60:.2f}m)")


if __name__ == "__main__":
    main()
