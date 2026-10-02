"""Cases de la page « Relevé OP/ED » : une par lecteur et par type, dans
l'horloge du FICHIER (ligne « Flux » des stats du lecteur), chaque lecteur
ayant la sienne. Le texte de la case dit ce que la v2 a vu et quelle règle a
posé chaque borne. Assemblage et publication : eval.publish.
"""
from __future__ import annotations

from pathlib import Path

SERVER = {  # (lecteur, langue) -> identifiant de serveur du site (lib/servers.js)
    ("ansembed", "vf"): "animesama-ansembed", ("ansembed", "vostfr"): "animesama-ansembed-vo",
    ("frembed", "vf"): "frembed", ("frembed", "vostfr"): "frembed-vo",
    ("megaplay", "vostfr"): "megaplay",
    ("sibnet", "vf"): "animesama-sibnet", ("sibnet", "vostfr"): "animesama-sibnet-vo",
    ("vidmoly-va", "vf"): "voiranime-vidmoly", ("vidmoly-va", "vostfr"): "voiranime-vidmoly-vo",
    ("uqload", "vf"): "animesama-uqload", ("uqload", "vostfr"): "animesama-uqload-vo",
}


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
            + (f", images à {c['img']:.0%}" if c.get("img") is not None else "") + f" ({', '.join(c['reasons'])})")


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:06.3f}"


def build(batch: list[dict], anime: dict[int, dict], strips: Path | None = None) -> list[dict]:
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
                    elif hit.get("mute_tail"):
                        m = hit["music"]
                        txt += (f" · de la première note à la fin du thème (dernière note à {mmss(m[1] + off)},"
                                f" puis {end - (m[1] + off):.2f} s de carton muet)")
                    elif end - (hit["music"][1] + off) >= 0.05:
                        m = hit["music"]
                        txt += (f" · de la première note au retour du son (dernière note à {mmss(m[1] + off)},"
                                f" puis {end - (m[1] + off):.2f} s de silence)")
                    else:
                        txt += " · de la première à la dernière note"
                    if hit.get("tail_only"):
                        txt += (f" · fin seule servie : l'épisode recouvre la chanson jusque-là"
                                f" (première note à {mmss(hit['music'][0] + off)})")
                        if hit.get("dirty_ref"):
                            txt += (" · la référence contient elle-même du dialogue : début = première plage"
                                    " propre, à vérifier")
                    elif hit.get("mixed_head"):
                        txt += (f" · début retardé de {hit['mixed_head']:.1f} s : le son de l'épisode recouvre"
                                f" la chanson jusque-là (première note à {mmss(hit['music'][0] + off)})")
                    if not hit.get("audio_exact"):
                        txt += " · position au son non établie (Chromaprint, ± 0,12 s)"
                    cell["claude"]["why"] = txt
                    cell |= {"start": start, "end": end, "clock": "flux", "clockOffset": off,
                             "dur": round(end - start, 3), "refDur": hit["ref_dur"]}
                    # Planche de eval.edge_strips : 4 images avant / apres chaque borne.
                    if strips is not None and (strips / f"{cell['id']}.jpg").exists():
                        cell["sheet"] = f"strips/{cell['id']}.jpg"
                cells.append(cell)
    return cells
