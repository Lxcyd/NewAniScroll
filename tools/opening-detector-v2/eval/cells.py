"""Cases de relevé humain à partir d'un lot v2 (page « Relevé OP/ED »).

Une case = une place (OP ou ED) d'un épisode, pour un groupe de lecteurs qui
partagent le même fichier (durées à ±1 s) ET la même réponse de la v2 (bornes
à ±0,5 s, ou abstention des deux côtés). Un verdict couvre tout le groupe.

Les abstentions ont aussi leur case (start = None) : c'est là que Luc dit
« il en manque un ». Sans elles, on mesurerait la précision, jamais ce que la
v2 laisse passer.

    python -m eval.cells out/gt10.jsonl ../opening-detector/datasets/anime.gt10.json out/gt10.cells.json
"""
from __future__ import annotations

import json
import sys

SERVER = {  # (lecteur, langue) -> identifiant de serveur du site (lib/servers.js)
    ("ansembed", "vf"): "animesama-ansembed", ("ansembed", "vostfr"): "animesama-ansembed-vo",
    ("frembed", "vf"): "frembed", ("frembed", "vostfr"): "frembed-vo",
    ("megaplay", "vostfr"): "megaplay",
    ("sibnet", "vf"): "animesama-sibnet", ("sibnet", "vostfr"): "animesama-sibnet-vo",
    ("vidmoly-va", "vf"): "voiranime-vidmoly", ("vidmoly-va", "vostfr"): "voiranime-vidmoly-vo",
    ("uqload", "vf"): "animesama-uqload", ("uqload", "vostfr"): "animesama-uqload-vo",
}
SAME_FILE_S = 0.2  # JJK ep2 : frembed a +0,99 s de duree est un AUTRE encode (tout decale de +1 s)
SAME_EDGE_S = 0.5


def build(batch: list[dict], anime: dict[int, dict]) -> list[dict]:
    cells = []
    for r in batch:
        a = anime[r["mal_id"]]
        season = next(s for s in a["seasons"] if s["lang"] == r["lang"])
        last = max(season.get("episodes") or [season.get("ep_end", 0)])
        hosts = [(h, e) for h, e in r["per_host"].items() if "duration" in e and (h, r["lang"]) in SERVER]
        for slot in ("op", "ed"):
            groups: list[list[tuple[str, dict]]] = []
            for h, e in sorted(hosts, key=lambda x: x[1]["duration"]):
                hit = e.get(slot)
                for g in groups:
                    e0 = g[0][1]
                    h0 = e0.get(slot)
                    if abs(e0["duration"] - e["duration"]) > SAME_FILE_S or (hit is None) != (h0 is None):
                        continue
                    if hit is None or (abs(hit["start"] - h0["start"]) <= SAME_EDGE_S
                                       and abs(hit["end"] - h0["end"]) <= SAME_EDGE_S):
                        g.append((h, e))
                        break
                else:
                    groups.append([(h, e)])
            for g in groups:
                h0, e0 = g[0]
                hit = e0.get(slot)
                cells.append({
                    "id": f"{r['mal_id']}-{r['episode']}-{r['lang']}-{slot}{'' if hit else '-none'}-{h0}",
                    "mal": r["mal_id"], "aniId": a["anilist_id"], "title": a["title"], "group": a.get("group", ""),
                    "ep": r["episode"], "lastEp": last, "lang": r["lang"], "kind": slot,
                    "start": hit["start"] if hit else None, "end": hit["end"] if hit else None,
                    "duration": e0["duration"], "source": "v2", "serve": bool(hit),
                    "hosts": [{"host": h, "server": SERVER[(h, r["lang"])]} for h, _ in g],
                    "sheetFile": None,
                    # Ce que la v2 a vu, pour que Luc sache pourquoi elle sert ou s'abstient.
                    "claude": {"v": "ok" if hit else "abstention",
                               "why": why(hit, e0.get("candidates", []), slot, e0["duration"])},
                    "check": True,
                })
    return cells


def why(hit: dict | None, cands: list[dict], slot: str, dur: float) -> str:
    if hit:
        img = hit.get("img")
        return (f"{hit['ref']} : audio couvert à {hit['coverage']:.0%}"
                + ("" if img is None else f", images conformes à {img:.0%}")
                + (" (chanson jouée sur d'autres images : servi au son)" if img is not None and img < 0.8 else "")
                + (" (OP joué en fin d'épisode)" if slot == "op" and hit["start"] > dur / 2 else ""))
    # L'etiquette vient du theme : on cherche les candidats du MEME type.
    near = [c for c in cands if c["kind"] == slot]
    if not near:
        return f"aucun {slot.upper()} AnimeThemes entendu dans l'épisode"
    c = max(near, key=lambda c: c["coverage"])
    return (f"rejeté : {c['ref']} à {c['start']:.0f}-{c['end']:.0f} s, audio couvert à {c['coverage']:.0%}"
            + (f", images à {c['img']:.0%}" if c["img"] is not None else "") + f" ({', '.join(c['reasons'])})")


def main(argv: list[str]) -> int:
    batch = [json.loads(l) for l in open(argv[0], encoding="utf-8")]
    anime = {a["mal_id"]: a for a in json.load(open(argv[1], encoding="utf-8"))}
    cells = build(batch, anime)
    json.dump(cells, open(argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    served = sum(c["serve"] for c in cells)
    print(f"{len(cells)} cases ({served} servies, {len(cells) - served} abstentions) -> {argv[2]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
