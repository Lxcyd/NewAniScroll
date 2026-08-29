"""Per-anime results page: every title, every panel, every episode, classified.

Same visual system as the verification sheet. One card per anime; inside it one
row per (language) panel and one cell per episode, split OP / ED. The cell's
colour is the CLASSIFICATION, not merely presence — an empty cell that
AnimeThemes says should be empty must not read like a failure.

Usage: python _build_par_anime.py [tag ...] > out/par_anime.html
"""
from __future__ import annotations

import html
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from oped.animethemes import fetch_themes, resolve_slug  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
TAGS = sys.argv[1:] or ["hard", "hard2"]

rows, eps_of, slug_of, lot_of = [], {}, {}, {}
for tag in TAGS:
    f = HERE / f"out/{tag}.jsonl"
    if f.exists():
        for line in open(f, encoding="utf-8"):
            if line.strip():
                r = json.loads(line)
                r["_lot"] = tag
                rows.append(r)
    lf = HERE / f"datasets/anime.{tag}.json"
    if lf.exists():
        for a in json.loads(lf.read_text("utf-8")):
            slug_of[a["mal_id"]] = a["slug"]
            lot_of[a["mal_id"]] = tag
            for s in a["seasons"]:
                eps_of[(a["mal_id"], s["lang"])] = s.get("episodes") or []

_tc: dict[int, object] = {}


def themes_for(mal_id):
    if mal_id not in _tc:
        try:
            s = resolve_slug(mal_id=mal_id)
            _tc[mal_id] = fetch_themes(s) if s else None
        except Exception:
            _tc[mal_id] = None
    return _tc[mal_id]


def state(r, kind):
    v = r.get(kind)
    if v:
        return ("servi", v) if v.get("serve") else ("retenu", v)
    pre = (r.get("expected_absent") or {}).get(kind)
    if pre is True:
        return "attendue", None
    if pre is False:
        return "lacune", None
    ts = themes_for(r["mal_id"])
    if not ts:
        return "indecidable", None
    want, saw = kind.upper(), False
    for t in ts:
        if not str(getattr(t, "slug", "")).upper().startswith(want):
            continue
        saw = True
        for e in t.entries:
            if not getattr(e, "episodes_spec", None) or e.covers(r["episode"]):
                return "lacune", None
    return ("attendue" if saw else "indecidable"), None


def mmss(x):
    if x is None:
        return "—"
    m, s = divmod(int(round(x)), 60)
    return f"{m}:{s:02d}"


by_anime: dict[int, dict] = defaultdict(lambda: defaultdict(dict))
totals: dict[int, Counter] = defaultdict(Counter)
grand = Counter()
for r in rows:
    by_anime[r["mal_id"]][r["lang"]][r["episode"]] = r
    for kind in ("op", "ed"):
        st, _ = state(r, kind)
        totals[r["mal_id"]][st] += 1
        grand[st] += 1

ABBR = {"servi": "s-servi", "retenu": "s-retenu", "attendue": "s-att",
        "lacune": "s-lac", "indecidable": "s-ind"}
LABEL = {"servi": "servi", "retenu": "retenu", "attendue": "attendue",
         "lacune": "LACUNE", "indecidable": "indéc."}

order = sorted(by_anime, key=lambda m: (-totals[m]["lacune"], slug_of.get(m, "")))

out = []
w = out.append
w(f"<p class='sub'>{len(by_anime)} anime, {len(rows)} épisode-langues. "
  "Triés par nombre de <strong>lacunes réelles</strong> — les titres qui posent "
  "problème en premier. Une case vide n'est un échec que si un générique existe "
  "vraiment sur cet épisode.</p>")

w("<div class='stats'>")
for key, cls in (("servi", "ok"), ("retenu", "warn"), ("attendue", "mute"),
                 ("lacune", "bad"), ("indecidable", "")):
    w(f"<div class='stat {cls}'><b>{grand[key]}</b><span>{LABEL[key]}</span></div>")
w("</div>")

w("<div class='filters'>"
  "<button type='button' data-f='all' aria-pressed='true'>Tout</button>"
  "<button type='button' data-f='lac' aria-pressed='false'>Avec lacunes seulement</button>"
  "</div>")

for mal in order:
    lacs = totals[mal]["lacune"]
    w(f"<section class='anime' data-lac='{lacs}'>")
    w("<header class='ah'>"
      f"<h2>{html.escape(slug_of.get(mal, str(mal)))}</h2>"
      f"<span class='mal'>mal {mal}</span>")
    if lacs:
        w(f"<span class='fc'>{lacs} lacune{'s' if lacs > 1 else ''}</span>")
    w("</header>")
    for lang in sorted(by_anime[mal]):
        eps = eps_of.get((mal, lang)) or sorted(by_anime[mal][lang])
        w("<div class='tw'><table><thead><tr>"
          f"<th scope='col'>{html.escape(lang)}</th>")
        for e in eps:
            w(f"<th scope='col' class='num'>ep {e}</th>")
        w("</tr></thead><tbody>")
        for kind in ("op", "ed"):
            w(f"<tr><th scope='row' class='{kind}'>{kind.upper()}</th>")
            for e in eps:
                r = by_anime[mal][lang].get(e)
                if not r:
                    w("<td class='num quiet'>—</td>")
                    continue
                st, v = state(r, kind)
                t = (f"{mmss(v['start'])}–{mmss(v['end'])}" if v else "")
                w(f"<td class='num'><span class='st {ABBR[st]}'>{LABEL[st]}</span>"
                  + (f"<br><span class='t'>{t}</span>" if t else "") + "</td>")
            w("</tr>")
        w("</tbody></table></div>")
    w("</section>")

print("\n".join(out))
