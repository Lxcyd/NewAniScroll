"""Cases de relevé PAR LECTEUR, dans l'horloge du fichier (ligne « Flux » des
stats du lecteur), pour la page « Relevé OP/ED ».

    python -m eval.cells_flux out/railgun.full.jsonl out/railgun.full.json <dossier> [--skip-eps 1,2,3,24]

Contrairement à eval.cells (un groupe de lecteurs par case, horloge du
lecteur), une case = un lecteur, chacun ayant sa propre horloge ; le lien de
la page porte `tf` (instant FICHIER = start + clock_offset). Les bornes sont
celles du thème au son : de la première à la dernière note (run.theme_bounds).
Écrit un JSON par case dans <dossier> et <dossier>/batch.json (écritures pour
ArtifactData, documents NOUVEAUX : pas de if_version).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from eval.cells import SERVER, why


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:06.3f}"


def build(batch: list[dict], anime: dict[int, dict]) -> list[dict]:
    cells = []
    for r in batch:
        a = anime[r["mal_id"]]
        for h, e in r["per_host"].items():
            if "duration" not in e or (h, r["lang"]) not in SERVER:
                continue
            off = e.get("clock_offset") or 0.0
            for slot in ("op", "ed"):
                hit = e.get(slot)
                cell = {
                    "id": f"{r['mal_id']}-{r['episode']}-{r['lang']}-{slot}{'' if hit else '-none'}-{h}",
                    "mal": r["mal_id"], "aniId": a["anilist_id"], "title": a["title"], "group": a.get("group", ""),
                    "ep": r["episode"], "lastEp": a.get("last_episode") or r["episode"], "lang": r["lang"], "kind": slot,
                    "start": None, "end": None, "duration": e["duration"], "source": "v2", "serve": bool(hit),
                    "hosts": [{"host": h, "server": SERVER[(h, r["lang"])]}], "sheetFile": None, "check": True,
                    "claude": {"v": "ok" if hit else "abstention",
                               "why": why(hit, e.get("candidates", []), slot, e["duration"])},
                }
                if hit:
                    start, end = round(hit["start"] + off, 3), round(hit["end"] + off, 3)
                    txt = cell["claude"]["why"]
                    head, tail = hit.get("declared_silence") or (0.0, 0.0)
                    if head or tail:
                        m = hit["music"]
                        txt += (f" · musique {mmss(m[0] + off)}–{mmss(m[1] + off)}"
                                f" · silence du thème déclaré : {head:.2f} s en tête, {tail:.2f} s en queue")
                    else:
                        txt += " · de la première à la dernière note"
                    if not hit.get("audio_exact"):
                        txt += " · position au son non établie (Chromaprint, ± 0,12 s)"
                    cell["claude"]["why"] = txt
                    cell |= {"start": start, "end": end, "clock": "flux", "clockOffset": off,
                             "dur": round(end - start, 3), "refDur": hit["ref_dur"]}
                cells.append(cell)
    return cells


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch"); ap.add_argument("anime"); ap.add_argument("out")
    ap.add_argument("--skip-eps", default="")
    a = ap.parse_args(argv)
    skip = {int(x) for x in a.skip_eps.split(",") if x}
    batch = [json.loads(l) for l in open(a.batch, encoding="utf-8")]
    batch = [r for r in batch if r["episode"] not in skip]
    anime = {x["mal_id"]: x for x in json.load(open(a.anime, encoding="utf-8"))}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    cells = build(batch, anime)
    writes = []
    for c in cells:
        p = out / f"{c['id']}.json"
        p.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")
        writes.append({"op": "set", "collection": "cells", "doc_id": c["id"], "file_path": str(p.resolve())})
    (out / "batch.json").write_text(json.dumps(writes, ensure_ascii=False), encoding="utf-8")
    served = sum(c["serve"] for c in cells)
    print(f"{len(cells)} cases ({served} servies, {len(cells) - served} abstentions) -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
