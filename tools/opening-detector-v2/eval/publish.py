"""Mettre la page « Relevé OP/ED » a jour apres une relance.

    python -m eval.publish out/all.tail.jsonl out/all.list.json [--merge out/relance.jsonl]

1. --merge : les lecteurs de la relance remplacent ceux du lot (une panne de
   la relance ne remplace rien) ; l'ancien lot est garde en .prev.
2. Les planches des bornes qui ont bouge sont retirees, puis refaites
   (eval.edge_strips, seul passage par le reseau).
3. out/cells.js est reconstruit, dans l'ordre de la page.
4. out/publish_files.json liste ce qu'il faut republier : cells.js et les
   planches (re)faites pendant ce passage.

Remplace le script jetable recopie a chaque relance du 02/10/2026.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

from eval import edge_strips
from eval.cells_flux import build

PREFIX = "window.RELEVE_CELLS = "
MOVED_S = 0.002


def load(path: Path) -> list[dict]:
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def merge(batch: Path, rerun: Path, strips: Path) -> int:
    new = {(r["mal_id"], r["episode"], r["lang"]): r for r in load(rerun)}
    out, stale = [], 0
    for r in load(batch):
        n = new.get((r["mal_id"], r["episode"], r["lang"]))
        for host, e in (n["per_host"].items() if n else ()):
            if "detect_error" in e:
                continue
            old = r["per_host"].get(host) or {}
            for slot in ("op", "ed"):
                x, o = e.get(slot), old.get(slot)
                same = (x is None and o is None) or (x and o and abs(x["start"] - o["start"]) < MOVED_S
                                                      and abs(x["end"] - o["end"]) < MOVED_S)
                sheet = strips / f"{r['mal_id']}-{r['episode']}-{r['lang']}-{slot}-{host}.jpg"
                if not same and sheet.exists():
                    sheet.unlink()
                    stale += 1
            r["per_host"][host] = e
        out.append(r)
    shutil.copy(batch, batch.with_suffix(".prev.jsonl"))
    batch.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in out), encoding="utf-8")
    return stale


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch")
    ap.add_argument("anime")
    ap.add_argument("--merge")
    a = ap.parse_args(argv)
    batch, out = Path(a.batch), Path(a.batch).parent
    strips, cells_js = out / "strips", out / "cells.js"
    if a.merge:
        print(merge(batch, Path(a.merge), strips), "planche(s) perimee(s) retiree(s)")
    began = time.time()
    edge_strips.main([str(batch), a.anime, str(strips)])

    old = []
    if cells_js.exists():
        old = json.loads(cells_js.read_text(encoding="utf-8")[len(PREFIX):].rstrip().rstrip(";"))
    anime = {x["mal_id"]: x for x in json.load(open(a.anime, encoding="utf-8"))}
    cells = build(load(batch), anime, strips)
    # Ordre de la page : une case garde sa place quand elle passe d'abstention
    # a servie, ou l'inverse (son identifiant change).
    pos = {c["id"]: k for k, c in enumerate(old)}

    def place(c: dict) -> float:
        k = f"-{c['kind']}-"
        i = c["id"]
        return pos.get(i, pos.get(i.replace(k, k + "none-"), pos.get(i.replace(k + "none-", k), 1e9)))

    cells.sort(key=place)
    cells_js.write_text(PREFIX + json.dumps(cells, ensure_ascii=False) + ";\n", encoding="utf-8")
    before = {c["id"]: c for c in old}
    changed = [c for c in cells if before.get(c["id"]) != c]
    files = {"cells.js": str(cells_js)} | {c["sheet"]: str(out / c["sheet"]) for c in cells
                                           if c.get("sheet") and (out / c["sheet"]).stat().st_mtime >= began}
    (out / "publish_files.json").write_text(json.dumps(files, ensure_ascii=False, indent=0), encoding="utf-8")
    served = sum(c["serve"] for c in cells)
    print(f"{len(cells)} cases ({served} servies), {len(changed)} changee(s), "
          f"{len(files)} fichier(s) a publier -> {out / 'publish_files.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
