"""Rejouer decisions ET bornes du lot catalogue, hors ligne.

    python -m eval.replay --only 16049                 # compare au lot, n'ecrit rien
    python -m eval.replay --only 16049 --write out/rejeu
    python -m eval.replay --limit 200 --write out/rejeu

A partir de ce que le lot a garde : l'empreinte de l'episode (cache/ep) pour
la decision, le son archive de chaque candidat (archive.py) pour les bornes,
l'horloge du lecteur et l'image notees dans la ligne. Aucune requete.

C'est l'outil qui rend une regle modifiable APRES le lot : changer decide.py
ou match/audio_edges.py, rejouer, comparer. Sans changement de code, le rejeu
doit rendre les bornes du lot a l'identique — c'est le controle fait avant le
depart (README, « Lot catalogue »).

--write ecrit dans un AUTRE dossier, jamais dans celui du lot.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

import numpy as np

import lot
import archive
import decide
import run
from fetch.episode import CACHE
from refs import animethemes
from refs.bank import load


def replay_host(mal: int, lang: str, ep: int, host: str, e: dict, refs) -> dict | None:
    path = CACHE / f"{mal}_{lang}_ep{ep}_{host}.npz"
    if not path.exists():
        return None
    with np.load(path) as z:
        dur, efp = float(z["duration"]), z["fp"]
    cands, heard = decide.shortlist(refs, efp, dur)
    seen = {(c["ref"], c["start"]): c.get("img") for c in e.get("candidates", [])}
    served = []
    for c in heard:
        c.img = seen.get((c.ref, round(c.start, 2)))
        if c.mid_episode(dur) and (c.img or 0.0) < decide.MIN_IMAGE:
            c.reasons.append("milieu_episode")
            continue
        served.append(c)
    slots, notes = decide.pick(served, dur)
    out = {"duration": round(dur, 3), "algo_version": run.ALGO_VERSION,
           "candidates": [c.as_dict(dur) for c in cands], "notes": notes}
    if not slots:
        return out
    clock = e.get("clock_offset")
    out["clock_offset"] = clock
    if clock is None:
        out["notes"].append("horloge_lecteur_inconnue")
        return out
    out["duration"] = round(dur - clock, 3)
    wins = [archive.read(m["file"], m["a0"]) for m in e.get("archive", [])]
    run.fill_hits(out, slots, refs, dur, clock, {"url": None, "referer": None}, wins)
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out/catalogue")
    ap.add_argument("--anime-list", default="out/catalogue.json")
    ap.add_argument("--only")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--write")
    a = ap.parse_args(argv)
    base = Path(a.out)
    if a.write and Path(a.write).resolve() == base.resolve():
        print("--write doit designer un autre dossier que celui du lot")
        return 2
    animethemes.EXTRA_DIRS.append(archive.ROOT / "refs")
    anime = json.load(open(a.anime_list, encoding="utf-8"))
    if a.only:
        only = {int(x) for x in a.only.split(",")}
        anime = [x for x in anime if x["mal_id"] in only]
    elif a.limit:
        anime = anime[: a.limit]

    n = same = 0
    moved, changed, missing = [], [], 0
    for entry in anime:
        mal = entry["mal_id"]
        recs = lot.read_anime(base / f"{mal}.jsonl")
        recs.pop("sans_reference", None)
        if not recs:
            continue
        refs = load(mal)
        for (ep, lang), r in sorted(recs.items(), key=lambda kv: (kv[0][1], kv[0][0])):
            new = dict(r, per_host={})
            for host, e in r["per_host"].items():
                if "detect_error" in e:
                    new["per_host"][host] = e
                    continue
                try:
                    x = replay_host(mal, lang, ep, host, e, refs)
                except archive.ArchiveError as exc:
                    x = None
                    print(f"  {mal} ep{ep} {lang} {host} : {exc}")
                if x is None:
                    missing += 1
                    new["per_host"][host] = e
                    continue
                new["per_host"][host] = x | {k: e[k] for k in ("archive", "fenetres", "timing") if k in e}
                for s in ("op", "ed"):
                    p, q = e.get(s), x.get(s)
                    if not p and not q:
                        continue
                    n += 1
                    tag = f"{mal} ep{ep} {lang} {host} {s}"
                    if (p is None) != (q is None) or p["ref"] != q["ref"]:
                        changed.append(f"{tag} : {p and p['ref']} -> {q and q['ref']}")
                        continue
                    d = max(abs(p["start"] - q["start"]), abs(p["end"] - q["end"]))
                    if d <= 0.001:
                        same += 1
                    else:
                        moved.append((d, f"{tag} : {p['start']}-{p['end']} -> {q['start']}-{q['end']}"))
            if a.write:
                lot.append(Path(a.write) / f"{mal}.jsonl", new)
        for k in [r.theme.key for r in refs]:
            run._pcm.pop(k, None)
    for line in changed[:40]:
        print("  theme change :", line)
    for d, line in sorted(moved, reverse=True)[:40]:
        print(f"  borne deplacee de {d:.3f} s :", line)
    sizes = collections.Counter("<= 50 ms" if d <= 0.05 else "<= 0,5 s" if d <= 0.5 else "> 0,5 s" for d, _ in moved)
    print(f"{n} generiques : {same} identiques au millieme, {len(moved)} deplaces {dict(sizes)}, "
          f"{len(changed)} changes ; {missing} lecteurs-episodes sans empreinte ou sans archive")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
