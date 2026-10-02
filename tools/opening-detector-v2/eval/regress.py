"""Non-regression de la DECISION, hors ligne : aucune requete, quelques minutes.

    python -m eval.regress out/all.tail.jsonl --write out/regress.json   # photo
    python -m eval.regress out/all.tail.jsonl --against out/regress.json # controle

Rejoue decide.py sur les empreintes d'episode en cache (cache/ep) pour chaque
lecteur du lot : quel theme est retenu par type, a partir de quelle seconde
(tete recouverte, fin seule), et pourquoi les autres sont ecartes. Ne rejoue
PAS le calage a l'echantillon ni la queue muette (run.theme_bounds), qui
demandent le flux.

Sans --write ni --against : compare la decision au lot lui-meme (theme servi
par type), ce qui dit si le lot est a jour avec le code.

Le 02/10/2026, chaque changement de regle a ete controle ainsi a la main,
quatre fois ; un seuil fixe deplacait 113 bornes sur 387 sans que rien ne le
signale autrement.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

import decide
import run
from fetch.episode import CACHE
from match.audio_edges import sound_span
from refs.bank import load

_lead: dict[str, float] = {}


def lead_of(theme) -> float:
    """Silence de tete de la reference (fichier audio deja en cache)."""
    if theme.key not in _lead:
        _lead[theme.key] = float(sound_span(run.ref_pcm(theme))[0])
    return _lead[theme.key]


def decision(refs, efp: np.ndarray, dur: float) -> dict:
    """La decision d'un lecteur, sans reseau. Un candidat au milieu de
    l'episode demande l'image : ici il est note `milieu_episode?`."""
    cands, served = decide.shortlist(refs, efp, dur)
    kept = []
    for c in served:
        if c.mid_episode(dur):
            c.reasons.append("milieu_episode?")
        else:
            kept.append(c)
    slots, notes = decide.pick(kept, dur)
    themes = {r.theme.key: r.theme for r in refs}
    out = {"notes": sorted(notes),
           "ecartes": sorted([c.ref, round(c.start, 1), sorted(c.reasons)] for c in cands if c.reasons)}
    for slot, c in slots.items():
        out[slot] = {"ref": c.ref, "debut": round(c.start, 1), "fin_seule": bool(c.tail_from),
                     "coupe": round(c.head_cut(lead_of(themes[c.ref])), 2), "zones": c.edge_zones}
    return out


def snapshot(batch: Path) -> dict:
    bank, snap = {}, {}
    for line in open(batch, encoding="utf-8"):
        r = json.loads(line)
        mal = r["mal_id"]
        if mal not in bank:
            bank[mal] = load(mal)
        for host, e in r["per_host"].items():
            path = CACHE / f"{mal}_{r['lang']}_ep{r['episode']}_{host}.npz"
            if "duration" not in e or not path.exists():
                continue
            z = np.load(path)
            d = decision(bank[mal], z["fp"], float(z["duration"]))
            d["lot"] = {s: e[s]["ref"] for s in ("op", "ed") if e.get(s)}
            snap[f"{mal}-{r['episode']}-{r['lang']}-{host}"] = d
    return snap


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch")
    ap.add_argument("--write")
    ap.add_argument("--against")
    a = ap.parse_args(argv)
    snap = snapshot(Path(a.batch))
    if a.write:
        Path(a.write).write_text(json.dumps(snap, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")
        print(f"{len(snap)} lecteurs-episodes -> {a.write}")
        return 0
    diffs = []
    if a.against:
        old = json.loads(Path(a.against).read_text(encoding="utf-8"))
        for k in sorted(set(old) | set(snap)):
            o, n = old.get(k), snap.get(k)
            if json.dumps(o, sort_keys=True) != json.dumps(n, sort_keys=True):
                diffs.append((k, o, n))
    else:
        for k, d in snap.items():
            now = {s: d[s]["ref"] for s in ("op", "ed") if s in d}
            if now != d["lot"]:
                diffs.append((k, d["lot"], now))
    for k, o, n in diffs:
        print(k, "\n   avant :", json.dumps(o, ensure_ascii=False), "\n   apres :", json.dumps(n, ensure_ascii=False))
    print(f"{len(snap)} lecteurs-episodes, {len(diffs)} ecart(s)")
    return 1 if diffs else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
