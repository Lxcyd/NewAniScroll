"""Sortie de batch_detect -> lignes du « Releve OP/ED » (page de verification).

Une ligne = (episode, langue, OP|ED, GROUPE D'ENCODAGE). Les lecteurs qui
servent le meme fichier (duree egale a 0,1 s pres) ET ont trouve les memes
bords (0,5 s pres) partagent une ligne : un seul verdict les couvre. Ecart
median mesure sur un meme encodage : 0,04 s (memoire oped-juge-coherence).

Lignes « rien detecte » : pour chaque (episode, langue, OP|ED), les lecteurs
qui n'ont RIEN trouve alors qu'ils ont ete analyses. Aucune n'est evidente
(Cyberpunk ep1 : AnimeThemes dit « pas d'ED », il y en a un) — toutes vont a
Luc.

Qui verifie quoi (protocole valide le 28/09) : Luc voit toutes mes lignes
FAUX / INCERTAIN, toutes les « rien detecte », et 25 % de mes OK tires au
hasard (graine fixe). Mes verdicts viennent de `claude_verdicts.json`
({cle: {v: ok|faux|incertain, why}}) ; sans verdict, la ligne va a Luc.

Usage :
  python scratch/_build_gt_cells.py out/v3/gt10.jsonl datasets/anime.gt10.json \
      out/v3/sheets out/v3/claude_verdicts.json out/v3/cells.json
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

SEED = 20260928
SAME_DUR_S = 0.1
SAME_EDGE_S = 0.5

# (hote detecteur, langue) -> id de serveur du site (inverse de
# lib/hostRegistry.js SERVER_TO_HOST).
SERVER_ID = {
    ("sibnet", "vf"): "animesama-sibnet", ("sibnet", "vostfr"): "animesama-sibnet-vo",
    ("ansembed", "vf"): "animesama-ansembed", ("ansembed", "vostfr"): "animesama-ansembed-vo",
    ("vidmoly-va", "vf"): "voiranime-vidmoly", ("vidmoly-va", "vostfr"): "voiranime-vidmoly-vo",
    ("uqload", "vf"): "animesama-uqload", ("uqload", "vostfr"): "animesama-uqload-vo",
    ("frembed", "vf"): "frembed", ("frembed", "vostfr"): "frembed-vo",
    ("megaplay", "vostfr"): "megaplay",
}


def main() -> None:
    jsonl, alist, sheets_dir, verdicts_f, out = sys.argv[1:6]
    animes = {a["mal_id"]: a for a in json.loads(Path(alist).read_text("utf-8"))}
    sheets = {}
    idx = Path(sheets_dir) / "index.json"
    if idx.exists():
        sheets = json.loads(idx.read_text("utf-8"))
    claude = json.loads(Path(verdicts_f).read_text("utf-8")) if Path(verdicts_f).exists() else {}

    cells = []
    for line in open(jsonl, encoding="utf-8"):
        if not line.strip():
            continue
        row = json.loads(line)
        a = animes.get(row["mal_id"])
        if not a:
            continue
        per = row.get("per_host") or {}
        for kind in ("op", "ed"):
            groups: list[dict] = []
            nothing: list[str] = []
            for host in sorted(per):
                ph = per[host]
                hit = ph.get(kind)
                if (host, row["lang"]) not in SERVER_ID:
                    continue
                if not hit or hit.get("start") is None:
                    nothing.append(host)
                    continue
                dur = float(ph.get("duration") or 0)
                for g in groups:
                    if (abs(g["duration"] - dur) <= SAME_DUR_S
                            and abs(g["start"] - hit["start"]) <= SAME_EDGE_S
                            and abs(g["end"] - hit["end"]) <= SAME_EDGE_S):
                        g["hosts"].append(host)
                        break
                else:
                    groups.append({"duration": dur, "start": float(hit["start"]),
                                   "end": float(hit["end"]), "hosts": [host],
                                   "source": hit.get("source"),
                                   "serve": bool((row.get(kind) or {}).get("serve"))})
            for g in groups:
                key = f"{a['mal_id']}-{row['episode']}-{row['lang']}-{kind}-{g['hosts'][0]}"
                sheet = sheets.get(f"{a['mal_id']}_{row['episode']}_{row['lang']}_{g['hosts'][0]}_{kind}")
                cells.append(_cell(a, row, kind, key, g, sheet, claude.get(key)))
            if nothing:
                key = f"{a['mal_id']}-{row['episode']}-{row['lang']}-{kind}-none-{nothing[0]}"
                durs = [float(per[h].get("duration") or 0) for h in nothing]
                g = {"duration": max(durs) if durs else None, "start": None, "end": None,
                     "hosts": nothing, "source": None, "serve": None}
                cells.append(_cell(a, row, kind, key, g, None, None))

    rng = random.Random(SEED)
    for c in cells:
        v = (c.get("claude") or {}).get("v")
        if c["start"] is None or v in (None, "faux", "incertain"):
            c["check"] = True
        else:
            c["check"] = rng.random() < 0.25
    Path(out).write_text(json.dumps(cells, ensure_ascii=False, indent=1), "utf-8")
    n_check = sum(c["check"] for c in cells)
    print(f"{len(cells)} lignes, dont {n_check} a verifier par Luc -> {out}")


def _cell(a, row, kind, key, g, sheet, claude):
    return {
        "id": key, "mal": a["mal_id"], "aniId": a["anilist_id"],
        "title": a.get("title") or a["slug"], "group": a.get("group", ""),
        "ep": row["episode"], "lastEp": a.get("last_episode"), "lang": row["lang"],
        "kind": kind, "start": g["start"], "end": g["end"], "duration": g["duration"],
        "source": g["source"], "serve": g["serve"],
        "hosts": [{"host": h, "server": SERVER_ID[(h, row["lang"])]} for h in g["hosts"]],
        "sheetFile": sheet["file"] if sheet else None,
        "claude": claude,
    }


if __name__ == "__main__":
    main()
