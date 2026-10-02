"""Les 4 images d'avant et les 4 d'apres chaque borne, pour la page « Relevé
OP/ED » : Luc juge une borne en la VOYANT, pas en ouvrant le lecteur dessus.

    python -m eval.edge_strips out/snk.tail.jsonl out/snk.all.json out/strips

Une planche par borne servie (<mal>-<ep>-<lang>-<slot>-<host>.jpg, le meme
identifiant que la case) : une rangee pour le debut, une pour la fin, 8 images
consecutives a la cadence native, le trait rouge entre la 4e et la 5e = la
borne. Les temps sont ceux de la ligne « Flux » du lecteur (PTS absolus).
Ces images ne servent qu'a RELIRE : les bornes restent posees au son.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from fetch.episode import resolve
from spike.sheet import frames

W, H = 256, 144
N = 4
SPAN = 0.6          # s de part et d'autre : 4 images a 23,976 i/s = 0,17 s
LABEL, TITLE, GAP = 18, 22, 10


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:06.3f}"


def around(stream: dict, t: float):
    """(images, pts) : les N dernieres images avant t, les N premieres a partir de t."""
    fr, pts = frames(stream["url"], stream.get("referer"), max(0.0, t - SPAN), 2 * SPAN, None, size=(W, H))
    before = np.flatnonzero(pts < t - 1e-3)[-N:]
    after = np.flatnonzero(pts >= t - 1e-3)[:N]
    return [(fr[i], float(pts[i])) for i in before], [(fr[i], float(pts[i])) for i in after]


def strip(rows: list[tuple[str, float, list, list]], out: Path) -> None:
    img = Image.new("RGB", (2 * N * W + GAP, len(rows) * (TITLE + H + LABEL)), (18, 18, 22))
    d = ImageDraw.Draw(img)
    for r, (name, t, before, after) in enumerate(rows):
        y = r * (TITLE + H + LABEL)
        d.text((4, y + 5), f"{name}  {mmss(t)}   (4 images avant | 4 images apres)", fill=(235, 235, 235))
        # Cales a droite pour « avant », a gauche pour « apres » : la borne reste au milieu.
        for k, (f, p) in enumerate(before):
            x = (N - len(before) + k) * W
            img.paste(Image.fromarray(f), (x, y + TITLE)); d.text((x + 4, y + TITLE + H + 3), mmss(p), fill=(170, 170, 180))
        for k, (f, p) in enumerate(after):
            x = N * W + GAP + k * W
            img.paste(Image.fromarray(f), (x, y + TITLE)); d.text((x + 4, y + TITLE + H + 3), mmss(p), fill=(170, 170, 180))
        if len(after) < N:
            d.text((N * W + GAP + len(after) * W + 8, y + TITLE + H // 2), "fin du fichier", fill=(170, 170, 180))
        d.rectangle([N * W, y + TITLE, N * W + GAP - 1, y + TITLE + H - 1], fill=(255, 30, 30))
    img.save(out, quality=82)


def main(argv: list[str]) -> int:
    batch, lst, out = argv[0], argv[1], Path(argv[2])
    out.mkdir(parents=True, exist_ok=True)
    anime = {e["mal_id"]: e for e in json.load(open(lst, encoding="utf-8"))}
    done = failed = 0
    for r in (json.loads(l) for l in open(batch, encoding="utf-8")):
        hosts = [h for h, e in r["per_host"].items() if e.get("op") or e.get("ed")]
        todo = [(h, s) for h in hosts for s in ("op", "ed") if r["per_host"][h].get(s)
                and not (out / f"{r['mal_id']}-{r['episode']}-{r['lang']}-{s}-{h}.jpg").exists()]
        if not todo:
            continue
        entry = anime[r["mal_id"]]
        season = next(s for s in entry["seasons"] if s["lang"] == r["lang"])
        streams = {s["host"]: s for s in resolve(entry, season, r["episode"], hosts=sorted({h for h, _ in todo}))}
        for h, slot in todo:
            e = r["per_host"][h]; x, off = e[slot], e["clock_offset"]
            name = f"{r['mal_id']}-{r['episode']}-{r['lang']}-{slot}-{h}.jpg"
            try:
                rows = [(f"{slot.upper()} debut", x["start"] + off, *around(streams[h], x["start"] + off)),
                        (f"{slot.upper()} fin", x["end"] + off, *around(streams[h], x["end"] + off))]
                strip(rows, out / name)
                done += 1
                print(name, [len(b) + len(a) for _, _, b, a in rows], flush=True)
            except Exception as err:
                failed += 1
                print(name, "ECHEC", str(err)[:160].replace("\n", " "), flush=True)
    print(done, "planches,", failed, "echecs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
