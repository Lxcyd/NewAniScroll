"""Ou en est le lot catalogue, sans le toucher.

    python -m eval.status                      # l'etat, tel que le lot l'ecrit
    python -m eval.status --wait 110           # attend un evenement ou 110 min, puis l'etat
    python -m eval.status --rebuild            # registre refait depuis les fichiers par anime
    python -m eval.status --palier 20          # bilan des 20 premiers animes
    python -m eval.status --palier 20 --baseline   # ... et le fige comme reference des sentinelles

--wait rend la main des que l'etat n'est plus « en_cours », qu'une alerte
nouvelle apparait, qu'un lecteur passe en pause, ou que le battement de coeur
s'arrete (lot mort) : c'est ce qui reveille la session qui suit le lot.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import statistics
import sys
import time
from pathlib import Path

import lot
from eval import sentinels

STALE_S = 600


def load_status(base: Path) -> dict:
    p = base.with_name(base.name + ".status.json")
    for _ in range(5):
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            time.sleep(0.3)
    return {}


def stale(d: dict) -> bool:
    try:
        return (dt.datetime.now() - dt.datetime.fromisoformat(d["battement"])).total_seconds() > STALE_S
    except (KeyError, ValueError):
        return True


def wait(base: Path, minutes: float) -> None:
    first = load_status(base)
    seen = (len(first.get("alertes") or []), (first.get("alertes") or [None])[-1], sorted(first.get("lecteurs_en_pause") or {}))
    end = time.time() + minutes * 60
    while time.time() < end:
        time.sleep(30)
        d = load_status(base)
        now = (len(d.get("alertes") or []), (d.get("alertes") or [None])[-1], sorted(d.get("lecteurs_en_pause") or {}))
        if d.get("etat") not in ("en_cours", "demarrage") or now != seen or stale(d):
            return


def show(base: Path) -> None:
    d = load_status(base)
    if not d:
        print("pas d'etat : le lot n'a jamais tourne ici")
        return
    print(lot.text_status(d), end="")
    if d.get("etat") in ("en_cours", "attente", "demarrage") and stale(d):
        print(f"  !! battement de coeur arrete depuis {d.get('battement')} : le lot ne tourne plus")
    if d.get("pid") and d.get("etat") in ("en_cours", "attente") and not lot.pid_alive(d["pid"]):
        print(f"  !! le processus {d['pid']} n'existe plus")


def rebuild(base: Path, anime: list[dict]) -> dict:
    ledger = {}
    for entry in anime:
        path = base / f"{entry['mal_id']}.jsonl"
        if path.exists():
            ledger[str(entry["mal_id"])] = lot.ledger_entry(entry, lot.read_anime(path))
    return ledger


def palier(base: Path, anime: list[dict], n: int, write_baseline: bool) -> None:
    hosts: dict = collections.defaultdict(lambda: collections.Counter())
    pairs, bad, inexact, themes = 0, [], 0, 0
    states = collections.Counter()
    notes = collections.Counter()
    lengths: dict = collections.defaultdict(list)
    for entry in anime[:n]:
        recs = lot.read_anime(base / f"{entry['mal_id']}.jsonl")
        states[lot.ledger_entry(entry, recs)["etat"] if recs else "pas_commence"] += 1
        for key, r in recs.items():
            if key == "sans_reference":
                continue
            for b, what in sentinels.disagreements(r):
                pairs += 1
                if b:
                    bad.append(what)
            for h, e in r.get("per_host", {}).items():
                c = hosts[h]
                if "detect_error" in e:
                    c["pannes"] += 1
                    continue
                c["ok"] += 1
                c["avec_generique"] += bool(e.get("op") or e.get("ed"))
                c["niveau_" + str((e.get("timing") or {}).get("niveau"))] += 1
                c["mo"] += ((e.get("timing") or {}).get("reseau") or {}).get("octets", 0) / 1e6
                c["secondes"] += (e.get("timing") or {}).get("total_s", 0)
                for note in e.get("notes", []):
                    notes[note] += 1
                for s in ("op", "ed"):
                    if e.get(s):
                        c[s] += 1
                        themes += 1
                        inexact += not e[s].get("audio_exact")
                        lengths[(entry["mal_id"], e[s]["ref"])].append(round(e[s]["end"] - e[s]["start"], 2))
            for h in r.get("absent", {}):
                hosts[h]["absents"] += 1
    print(f"Palier : {n} premiers animes — {dict(states)}")
    print(f"{'lecteur':<12}{'traites':>8}{'generique':>10}{'OP':>6}{'ED':>6}{'pannes':>8}{'absents':>8}{'s/ep':>7}"
          f"{'guide':>7}{'tete+fin':>9}{'entier':>7}")
    base_serve = {}
    for h, c in sorted(hosts.items()):
        ok = c["ok"]
        rate = c["avec_generique"] / ok if ok else 0
        if ok >= 50:
            base_serve[h] = round(rate, 3)
        print(f"{h:<12}{ok:>8}{rate:>10.0%}{c['op']:>6}{c['ed']:>6}{c['pannes']:>8}{c['absents']:>8}"
              f"{(c['secondes'] / ok if ok else 0):>7.0f}{c['niveau_guide']:>7}{c['niveau_tete_fin']:>9}{c['niveau_entier']:>7}")
    print(f"accord entre lecteurs d'un meme fichier : {pairs - len(bad)} / {pairs}")
    for what in bad[:20]:
        print("  desaccord :", what)
    print(f"bornes non calees a l'echantillon : {inexact} / {themes}")
    print("abstentions notees :", dict(notes.most_common(8)))
    # Un meme theme doit avoir la meme longueur d'un episode a l'autre : les
    # ecarts sont les cas a relire (tete recouverte, fin seule, queue muette).
    odd = []
    for (mal, ref), xs in lengths.items():
        if len(xs) >= 6:
            med = statistics.median(xs)
            far = [x for x in xs if abs(x - med) > 1.0]
            if far:
                odd.append((len(far) / len(xs), mal, ref, med, len(far), len(xs)))
    print("themes dont la longueur varie de plus de 1 s (les plus touches) :")
    for share, mal, ref, med, k, m in sorted(odd, reverse=True)[:15]:
        print(f"  {mal} {ref} : {k} / {m} a plus de 1 s de la mediane ({med:.2f} s)")
    if write_baseline:
        out = base.with_name(base.name + ".baseline.json")
        out.write_text(json.dumps({"serve": base_serve, "inexact": round(inexact / themes, 3) if themes else 0,
                                   "palier": n, "le": lot.now()}, ensure_ascii=False, indent=1), encoding="utf-8")
        print("reference des sentinelles ->", out)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out/catalogue")
    ap.add_argument("--anime-list", default="out/catalogue.json")
    ap.add_argument("--wait", type=float)
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--palier", type=int)
    ap.add_argument("--baseline", action="store_true")
    a = ap.parse_args(argv)
    base = Path(a.out)
    if a.wait:
        wait(base, a.wait)
    if a.rebuild or a.palier:
        anime = json.load(open(a.anime_list, encoding="utf-8"))
        if a.rebuild:
            ledger = rebuild(base, anime)
            lot.write_atomic(base.with_name(base.name + ".ledger.json"), json.dumps(ledger, ensure_ascii=False, indent=0))
            print(f"{len(ledger)} animes au registre :", dict(collections.Counter(x["etat"] for x in ledger.values())))
        if a.palier:
            palier(base, anime, a.palier, a.baseline)
        return 0
    show(base)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
