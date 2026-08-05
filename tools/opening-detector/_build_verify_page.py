"""Build the OP/ED verification sheet (HTML) from a multi-host batch JSONL.

The terminal report (`_verify_report.py`) is 440 lines — fine to grep, useless
to scan. This renders the same data as a page you check against the player:
counters first, then one card per episode with the consensus line above the
per-host rows, and every host that deviates from its peers marked in form AND
colour so it reads at a glance.

Timings are printed in each HOST's own timeline, because that is the clock the
player shows — hosts serve differently trimmed encodes, so the consensus value
is not what you would scrub to on a given player.

Usage: python _build_verify_page.py out/audit3.jsonl out/verify.html
"""

from __future__ import annotations

import html
import json
import statistics
import sys
from collections import defaultdict

NAMES = {
    2402: "Ashita no Joe", 31043: "Erased", 20507: "Noragami",
    37521: "Vinland Saga", 4224: "Toradora!", 22199: "Akame ga Kill",
    28999: "Charlotte", 10620: "Mirai Nikki", 31478: "Bungou Stray Dogs",
    37520: "Dororo", 15809: "Hataraku Maou-sama", 9989: "Anohana",
    14813: "Oregairu", 57334: "Dandadan", 12189: "Hyouka",
}
DEV_TOL = 4.0        # seconds a host may differ from its peers before flagging


def ms(s):
    if s is None:
        return "—"
    s = round(s)
    sign = "-" if s < 0 else ""
    s = abs(s)
    return f"{sign}{s // 60}:{s % 60:02d}"


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else "out/audit3.jsonl"
    dst = sys.argv[2] if len(sys.argv) > 2 else "out/verify.html"
    rows = [json.loads(l) for l in open(src, encoding="utf-8") if l.strip()]

    # One block per ANIME; the language rides on the host name ("vidmoly-va
    # (vf)"), mirroring how the app presents its server chips. Episodes of every
    # language share one card, keyed by episode number.
    by_anime = defaultdict(lambda: defaultdict(list))
    for r in rows:
        by_anime[r["mal_id"]][r["episode"]].append(r)

    n_serve = n_held = n_absent = 0
    n_flag = 0
    cards = []

    def tag(lang: str) -> str:
        """Host suffix. VOSTFR is the unmarked default, as in the player."""
        return "" if lang == "vostfr" else f" ({lang})"

    for mal in sorted(by_anime, key=lambda m: NAMES.get(m, str(m))):
        ep_html = []
        anime_flags = 0

        for epnum in sorted(by_anime[mal]):
            langs = sorted(by_anime[mal][epnum], key=lambda r: r["lang"] != "vostfr")
            host_rows = []
            badges = []
            ep_flagged = False

            for r in langs:
                lang = r["lang"]
                for kind in ("op", "ed"):
                    h = r.get(kind)
                    if h is None:
                        n_absent += 1
                        state, txt = "absent", "absent"
                    elif h.get("serve"):
                        n_serve += 1
                        state, txt = "servi", f"{ms(h['start'])} – {ms(h['end'])}"
                    else:
                        n_held += 1
                        state, txt = "retenu", f"{ms(h['start'])} – {ms(h['end'])}"
                    reason = ""
                    if h is not None and not h.get("serve"):
                        reason = (f'<span class="why">'
                                  f'{html.escape(h.get("held_reason") or "")}</span>')
                    badges.append(
                        f'<div class="cons {kind}"><span class="k">{kind.upper()}'
                        f'{html.escape(tag(lang))}</span>'
                        f'<span class="t">{txt}</span>'
                        f'<span class="st s-{state}">{state}</span>{reason}</div>'
                    )

                hosts = sorted((r.get("per_host") or {}).items())
                # Medians are computed WITHIN a language: a VF dub is a different
                # encode (Ashita no Joe runs 1300 s in VF against ~1420 s in
                # VOSTFR), so comparing it to the VOSTFR hosts would flag a
                # legitimate difference as an error.
                op_starts = [e["op"]["start"] for _h, e in hosts if e.get("op")]
                ed_fe = [e["ed"]["from_end_start"] for _h, e in hosts
                         if e.get("ed") and e["ed"].get("from_end_start") is not None]
                med_op = statistics.median(op_starts) if op_starts else None
                med_ed = statistics.median(ed_fe) if ed_fe else None

                for host, e in hosts:
                    op, ed = e.get("op"), e.get("ed")
                    dev = []
                    if op and med_op is not None and abs(op["start"] - med_op) > DEV_TOL:
                        dev.append(("OP", op["start"] - med_op))
                    if (ed and med_ed is not None
                            and ed.get("from_end_start") is not None
                            and abs(ed["from_end_start"] - med_ed) > DEV_TOL):
                        dev.append(("ED", ed["from_end_start"] - med_ed))
                    if dev:
                        n_flag += 1
                        anime_flags += 1
                        ep_flagged = True
                    chips = "".join(
                        f'<span class="dev">{k} {d:+.0f}s</span>' for k, d in dev
                    )
                    label = html.escape(host + tag(lang))
                    host_rows.append(
                        f'<tr class="{"flag" if dev else ""}">'
                        f'<th scope="row">{label}</th>'
                        f'<td class="num">{e.get("duration", 0):.0f}s</td>'
                        f'<td class="num op">{ms(op["start"]) + " – " + ms(op["end"]) if op else "—"}</td>'
                        f'<td class="num ed">{ms(ed["start"]) + " – " + ms(ed["end"]) if ed else "—"}</td>'
                        f'<td class="num">{ms(ed["from_end_start"]) if ed and ed.get("from_end_start") is not None else "—"}</td>'
                        f'<td class="num quiet">{(op or {}).get("votes", "—")} / {(ed or {}).get("votes", "—")}</td>'
                        f"<td>{chips}</td></tr>"
                    )

            ep_html.append(
                f'<article class="ep" data-flags="{1 if ep_flagged else 0}">'
                f"<h3>Épisode {epnum}</h3>"
                f'<div class="consrow">{"".join(badges)}</div>'
                f'<div class="tw"><table>'
                f'<thead><tr><th scope="col">Lecteur</th><th scope="col">Durée</th>'
                f'<th scope="col">OP</th><th scope="col">ED</th>'
                f'<th scope="col">ED depuis la fin</th><th scope="col">Votes OP/ED</th>'
                f'<th scope="col"></th></tr></thead>'
                f"<tbody>{''.join(host_rows)}</tbody></table></div></article>"
            )

        cards.append(
            f'<section class="anime" data-flags="{anime_flags}">'
            f'<header class="ah"><h2>{html.escape(NAMES.get(mal, str(mal)))}</h2>'
            f'<span class="mal">mal {mal}</span>'
            + (f'<span class="fc">{anime_flags} à vérifier</span>' if anime_flags else "")
            + f"</header>{''.join(ep_html)}</section>"
        )

    total = n_serve + n_held + n_absent
    page = TEMPLATE.format(
        serve=n_serve, held=n_held, absent=n_absent, total=total,
        flag=n_flag, eps=len(rows), anime=len(by_anime),
        pct=round(100 * n_serve / total) if total else 0,
        panels=len({(r["mal_id"], r["lang"]) for r in rows}),
        body="".join(cards),
    )
    with open(dst, "w", encoding="utf-8") as f:
        f.write(page)
    print(f"{dst}: {len(rows)} episodes, {total} cellules, {n_flag} lignes marquees")


TEMPLATE = """<title>OP/ED — feuille de vérification</title>
<style>
:root {{
  --bg:#F5F7F8; --surface:#FFFFFF; --line:#DCE3E7; --line-soft:#EDF1F3;
  --ink:#0F171D; --ink-2:#4A5A66; --ink-3:#7C8B96;
  --accent:#2F6B8F;
  --op:#A9501E; --ed:#25675F;
  --ok:#2E7049; --warn:#8A5F10; --bad:#9E3535;
  --ok-bg:#E4F0E8; --warn-bg:#F6EEDC; --bad-bg:#F6E4E4; --flag-bg:#FBF4E6;
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --bg:#0F1419; --surface:#171E25; --line:#2A343D; --line-soft:#212A32;
    --ink:#E2E9EE; --ink-2:#A3B1BC; --ink-3:#75848F;
    --accent:#7FB4D6;
    --op:#E0906A; --ed:#6FC3B6;
    --ok:#77C795; --warn:#DCAE55; --bad:#E58A8A;
    --ok-bg:#17301F; --warn-bg:#2F2716; --bad-bg:#31201F; --flag-bg:#2A2417;
  }}
}}
:root[data-theme="dark"] {{
  --bg:#0F1419; --surface:#171E25; --line:#2A343D; --line-soft:#212A32;
  --ink:#E2E9EE; --ink-2:#A3B1BC; --ink-3:#75848F; --accent:#7FB4D6;
  --op:#E0906A; --ed:#6FC3B6;
  --ok:#77C795; --warn:#DCAE55; --bad:#E58A8A;
  --ok-bg:#17301F; --warn-bg:#2F2716; --bad-bg:#31201F; --flag-bg:#2A2417;
}}
:root[data-theme="light"] {{
  --bg:#F5F7F8; --surface:#FFFFFF; --line:#DCE3E7; --line-soft:#EDF1F3;
  --ink:#0F171D; --ink-2:#4A5A66; --ink-3:#7C8B96; --accent:#2F6B8F;
  --op:#A9501E; --ed:#25675F;
  --ok:#2E7049; --warn:#8A5F10; --bad:#9E3535;
  --ok-bg:#E4F0E8; --warn-bg:#F6EEDC; --bad-bg:#F6E4E4; --flag-bg:#FBF4E6;
}}
* {{ box-sizing:border-box; }}
body {{
  margin:0; background:var(--bg); color:var(--ink);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:15px; line-height:1.5;
}}
.wrap {{ max-width:1120px; margin:0 auto; padding:32px 20px 72px; }}
h1 {{ font-size:26px; letter-spacing:-.02em; margin:0 0 4px; text-wrap:balance; }}
.sub {{ color:var(--ink-2); margin:0 0 24px; max-width:62ch; }}
.stats {{ display:flex; flex-wrap:wrap; gap:10px; margin-bottom:14px; }}
.stat {{
  background:var(--surface); border:1px solid var(--line); border-radius:8px;
  padding:10px 14px; min-width:104px;
}}
.stat b {{ display:block; font-size:22px; font-variant-numeric:tabular-nums; }}
.stat span {{ font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--ink-3); }}
.stat.ok b {{ color:var(--ok); }} .stat.warn b {{ color:var(--warn); }}
.stat.bad b {{ color:var(--bad); }} .stat.flag b {{ color:var(--accent); }}
.filters {{ display:flex; gap:8px; flex-wrap:wrap; margin:18px 0 26px; }}
.filters button {{
  font:inherit; font-size:13px; cursor:pointer; padding:6px 13px;
  border-radius:999px; border:1px solid var(--line);
  background:var(--surface); color:var(--ink-2);
}}
.filters button[aria-pressed="true"] {{
  background:var(--accent); border-color:var(--accent); color:#fff;
}}
.filters button:focus-visible {{ outline:2px solid var(--accent); outline-offset:2px; }}
.anime {{ margin-bottom:34px; }}
.ah {{ display:flex; align-items:baseline; gap:12px; flex-wrap:wrap;
  border-bottom:2px solid var(--line); padding-bottom:7px; margin-bottom:14px; }}
.ah h2 {{ font-size:19px; margin:0; letter-spacing:-.01em; }}
.mal {{ font-size:12px; color:var(--ink-3); font-variant-numeric:tabular-nums; }}
.fc {{ margin-left:auto; font-size:12px; color:var(--warn);
  background:var(--warn-bg); padding:2px 9px; border-radius:999px; }}
.ep {{ background:var(--surface); border:1px solid var(--line);
  border-radius:9px; padding:14px 16px; margin-bottom:11px; }}
.ep h3 {{ font-size:13px; margin:0 0 9px; text-transform:uppercase;
  letter-spacing:.07em; color:var(--ink-3); }}
.consrow {{ display:flex; gap:10px; flex-wrap:wrap; margin-bottom:11px; }}
.cons {{ display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  border:1px solid var(--line-soft); border-radius:7px; padding:6px 11px;
  border-left:3px solid var(--line); }}
.cons.op {{ border-left-color:var(--op); }}
.cons.ed {{ border-left-color:var(--ed); }}
.cons .k {{ font-size:11px; font-weight:700; letter-spacing:.06em; }}
.cons.op .k {{ color:var(--op); }} .cons.ed .k {{ color:var(--ed); }}
.cons .t {{ font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;
  font-variant-numeric:tabular-nums; font-size:13px; }}
.st {{ font-size:11px; padding:1px 8px; border-radius:999px; text-transform:uppercase;
  letter-spacing:.05em; }}
.s-servi {{ background:var(--ok-bg); color:var(--ok); }}
.s-retenu {{ background:var(--warn-bg); color:var(--warn); }}
.s-absent {{ background:var(--bad-bg); color:var(--bad); }}
.why {{ font-size:12px; color:var(--ink-3); }}
.tw {{ overflow-x:auto; }}
table {{ border-collapse:collapse; width:100%; min-width:640px; }}
th, td {{ text-align:left; padding:5px 9px; border-bottom:1px solid var(--line-soft); }}
thead th {{ font-size:11px; text-transform:uppercase; letter-spacing:.05em;
  color:var(--ink-3); font-weight:600; border-bottom:1px solid var(--line); }}
tbody th {{ font-weight:600; font-size:13px; }}
.num {{ font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;
  font-variant-numeric:tabular-nums; font-size:13px; }}
td.op {{ color:var(--op); }} td.ed {{ color:var(--ed); }}
.quiet {{ color:var(--ink-3); font-size:12px; }}
tr.flag {{ background:var(--flag-bg); }}
tr.flag th {{ box-shadow:inset 3px 0 0 var(--warn); }}
.dev {{ display:inline-block; font-family:ui-monospace,Consolas,monospace;
  font-size:11px; background:var(--warn-bg); color:var(--warn);
  padding:1px 7px; border-radius:4px; margin-right:4px; }}
.hidden {{ display:none; }}
footer {{ margin-top:40px; color:var(--ink-3); font-size:13px;
  border-top:1px solid var(--line); padding-top:14px; max-width:70ch; }}
</style>
<div class="wrap">
<h1>OP/ED — feuille de vérification</h1>
<p class="sub">{eps} épisodes, {anime} anime, {panels} panneaux langue. Un lecteur suffixé
<strong>(vf)</strong> sert le doublage — sans suffixe, c'est la VOSTFR. Les minutages
sont donnés dans l'horloge <strong>propre à chaque lecteur</strong>, c'est ce que le
player affiche.</p>

<div class="stats">
  <div class="stat ok"><b>{serve}</b><span>servi</span></div>
  <div class="stat warn"><b>{held}</b><span>retenu</span></div>
  <div class="stat bad"><b>{absent}</b><span>absent</span></div>
  <div class="stat"><b>{pct}%</b><span>servi</span></div>
  <div class="stat flag"><b>{flag}</b><span>à vérifier</span></div>
</div>

<div class="filters">
  <button type="button" data-f="all" aria-pressed="true">Tout</button>
  <button type="button" data-f="flags" aria-pressed="false">À vérifier seulement</button>
</div>

{body}

<footer>
<strong>Comment lire.</strong> <em>Servi</em> = envoyé au lecteur (bouton « Passer »).
<em>Retenu</em> = mesuré et stocké, mais pas servi : un garde-fou n'est pas satisfait.
<em>Absent</em> = rien trouvé. La colonne <em>ED depuis la fin</em> est l'ancre
indépendante de la durée : c'est <strong>elle</strong> qui doit concorder entre lecteurs,
pas le minutage absolu. Une pastille <span class="dev">ED +14s</span> signale un lecteur
qui s'écarte de plus de 4 s de ses pairs — soit un encodage réellement différent,
soit une erreur de détection, et seule l'image tranche.
</footer>
</div>
<script>
const btns = document.querySelectorAll('.filters button');
btns.forEach(b => b.addEventListener('click', () => {{
  btns.forEach(o => o.setAttribute('aria-pressed', String(o === b)));
  const only = b.dataset.f === 'flags';
  document.querySelectorAll('.ep').forEach(e => {{
    e.classList.toggle('hidden', only && e.dataset.flags === '0');
  }});
  document.querySelectorAll('.anime').forEach(a => {{
    a.classList.toggle('hidden', only && a.dataset.flags === '0');
  }});
}}));
</script>
"""


if __name__ == "__main__":
    main()
