"""AniSkip sur les memes cellules que la v2 : la ligne de base a battre.

AniSkip (api.aniskip.com, participatif) donne UN intervalle par episode, mesure
sur l'encode d'un contributeur ; nos lecteurs ont chacun le leur (decalages de
plusieurs secondes). On le juge donc lecteur par lecteur, comme le site le
servirait : juste si les deux bords tombent a +/- TOL_S de la cellule jugee
juste pour ce lecteur.

    python -m eval.aniskip out/gt10.jsonl
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from eval.crosscheck import to_player, TOL_S, V1, human, load_v2, ov, served
from eval.wilson import line

CACHE = Path("cache/aniskip")
API = "https://api.aniskip.com/v2/skip-times/{mal}/{ep}?types[]=op&types[]=ed&episodeLength=0"


def fetch(mal: int, ep: int) -> dict:
    """{'op': (debut, fin, duree_episode) | None, 'ed': ...}, en cache."""
    path = CACHE / f"{mal}_{ep}.json"
    if path.exists():
        return json.loads(path.read_text())
    out = {"op": None, "ed": None}
    req = urllib.request.Request(API.format(mal=mal, ep=ep), headers={"User-Agent": "AniScroll-oped-v2"})
    data = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:  # personne n'a soumis de mesure pour cet episode
                data = {"results": []}
                break
            time.sleep(5 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError):
            time.sleep(5 * (attempt + 1))
    if data is None:
        return {"op": None, "ed": None, "unknown": True}  # jamais mis en cache
    for x in data.get("results", []):
        k = x["skipType"]
        if k in out:
            iv = x["interval"]
            out[k] = (iv["startTime"], iv["endTime"], x.get("episodeLength"))
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out))
    time.sleep(0.6)  # < 120 requetes / minute
    return out


def main(argv: list[str]) -> int:
    v2 = load_v2(argv[0])
    cells = json.load(open(V1 / "cells.json", encoding="utf-8"))
    luc = human()
    score = {"aniskip": [0, 0, 0], "v2": [0, 0, 0]}  # [servies justes, servies fausses, abstentions]
    for c in cells:
        if c["start"] is None:
            continue
        verdict = luc.get(c["id"], {}).get("v") or (c.get("claude") or {}).get("v")
        if verdict not in ("ok", "juste"):
            continue
        ask = fetch(c["mal"], c["ep"])
        if ask.get("unknown"):
            continue
        for h in c["hosts"]:
            e = v2.get((c["mal"], c["ep"], c["lang"], h["host"]))
            if e is None or "duration" not in e:
                continue
            c0, c1 = to_player(c, e)
            # La v2 sur ce lecteur
            hits = [x for x in served(e) if ov(c0, c1, x[1], x[2]) > 0.3]
            if not hits:
                score["v2"][2] += 1
            else:
                ok = abs(hits[0][1] - c0) <= TOL_S and abs(hits[0][2] - c1) <= TOL_S
                score["v2"][0 if ok else 1] += 1
            # AniSkip sur ce lecteur : la place (op/ed) de la cellule
            slot = "op" if (c0 + c1) / 2 < c["duration"] / 2 else "ed"
            iv = ask.get(slot)
            if not iv:
                score["aniskip"][2] += 1
            else:
                ok = abs(iv[0] - c0) <= TOL_S and abs(iv[1] - c1) <= TOL_S
                score["aniskip"][0 if ok else 1] += 1
    print(f"Cellules jugees justes (Claude + Luc), lecteur par lecteur, bords a +/- {TOL_S} s :")
    for k, (good, bad, none) in score.items():
        n = good + bad
        print(f"  {k:<8} servies {n:>3} ({line(bad, n)}), abstentions {none}")
    print("\nAttention : ces cellules sont celles que la v1 avait TROUVEES et que Claude a jugees ;\n"
          "ce n'est pas une verite humaine, et elle favorise ce que la v1 et la v2 savent faire.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
