"""Lot v2 : liste d'animes -> JSONL par episode, par lecteur.

    python run.py --anime-list ../opening-detector/datasets/anime.gt10.json --out out/gt10.jsonl

Reprend la ou il s'est arrete (episodes deja ecrits sautes). Le format
per_host est celui de scripts/oped/import-oped-host-skips.mjs ; en plus,
chaque lecteur porte ses `candidates` (tout ce qui a ete vu, retenu ou non,
avec la raison) pour le diagnostic.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

import decide
from fetch import SAMPLE_RATE, stats
from fetch.clock import stream_origin
from fetch.episode import CACHE, fingerprint_stream, resolve
from fp.chroma import decode_file
from match.audio_edges import PIECE_S, mute_end, refine_offset, sound_span
from match.ber import occurrences
from match.image import MATCH_NCC, SHIFT_MAX_S, best_shift, compare, episode_frames, ref_frames
from refs.animethemes import download
from refs.bank import load

ALGO_VERSION = 100  # v2 ; la v1 est en 1-2
_write = threading.Lock()
RETRY_DELAY_S = 15
# --hosts : ne repasser que ces lecteurs (megaplay ecarte d'un lot par des 403
# transitoires : on le refait seul, lentement, puis on fusionne).
ONLY_HOSTS: list[str] | None = None


def image_score(stream: dict, cand: decide.Candidate, videos):
    """(part des images concordantes, decalage image/son). Decalage nul
    d'abord ; sinon meilleur decalage a +/- 3 s.

    Pour INFORMATION seulement : le son seul decide de servir (Luc,
    02/10/2026). Ce controle faisait s'abstenir sur des generiques valides :
    Railgun S ep6, ED lance sur la fin de la scene (15 premieres secondes
    d'images non conformes) ; Cyberpunk ep1, chanson de l'OP sur les credits
    deroulants de fin (6 %)."""
    ef, et = episode_frames(stream["url"], cand.start - SHIFT_MAX_S, cand.ref_dur + 2 * SHIFT_MAX_S,
                            referer=stream.get("referer"))
    refs = [ref_frames(download(v.link, "video")) for v in videos]
    shift = 0.0
    sim = compare(ef, et, cand.start, refs)
    valid = sim[~np.isnan(sim)]
    frac = float((valid >= MATCH_NCC).mean()) if len(valid) else 0.0
    if frac < decide.MIN_IMAGE:
        shift, frac = best_shift(ef, et, cand.start, refs)
    return frac, shift


_pcm: dict[str, np.ndarray] = {}
_pcm_lock = threading.Lock()


def ref_pcm(theme) -> np.ndarray:
    with _pcm_lock:
        if theme.key not in _pcm:
            _pcm[theme.key] = decode_file(download(theme.audio_link, "audio"))
        return _pcm[theme.key]


SILENCES = Path(__file__).parent / "refs" / "silences.json"


def declared_silence(key: str) -> tuple[float, float]:
    """(tete, queue) : silence qui fait PARTIE du theme, declare a la main dans
    refs/silences.json. Le son ne permet pas de le deviner — cf. theme_bounds."""
    try:
        d = json.loads(SILENCES.read_text(encoding="utf-8")).get(key) or {}
        return float(d.get("tete", 0.0)), float(d.get("queue", 0.0))
    except (OSError, ValueError):
        return 0.0, 0.0


def theme_bounds(stream: dict, c: decide.Candidate, theme) -> dict:
    """Bornes du generique AU SON, horloge detecteur : de la premiere a la
    derniere note de la reference, placee dans l'episode.

    Pas le fichier de reference entier : les clips AnimeThemes sont rembourres
    de silence, et ce silence n'est pas dans l'episode. SnK OP1 : 0,57 s en
    tete du fichier ; dans l'episode, ces 0,57 s sont la fin de la scene
    d'avant (ep1 : 2 a 5 % du niveau de la chanson, ep2 : 13 a 60 %). Luc,
    01/10/2026 : « on a un peu avant le debut de la musique, pour SnK l'OP
    commence directement avec la musique ». Tester si l'episode est muet a cet
    endroit ne tranche pas non plus (l'ep1 passerait pour muet).

    La QUEUE du fichier, elle, compte quand l'episode y est muet lui aussi :
    c'est le dernier carton du generique, tenu a l'ecran sans musique (SnK OP1,
    1,13 s). Luc, 02/10/2026, lien pose sur la derniere note : « on n'a pas les
    1:31 d'OP, on coupe trop tot ». Si l'episode a du son dans cette queue,
    c'est la scene suivante : la borne reste a la derniere note. La tete, non :
    c'est lui qui l'a ecartee sur l'ep1, pourtant quasi muet a cet endroit.

    Un theme qui contient un VRAI silence (« OP de 8 s : 1 s sans musique puis
    musique jusqu'a 1:30, il commence a 1:22 ») se declare dans
    refs/silences.json ; rien ne permet de le reconnaitre au son.

    La position vient de la correlation des formes d'onde (refine_offset, a
    quelques ms) ; si ses tranches ne concordent pas, on garde celle de
    Chromaprint (0,12 s) et `exact` le dit. Le decalage image ne sert ici que
    d'indice de recherche : Chromaprint peut etre a 2 s de la chanson (Railgun
    S ep1 frembed)."""
    try:
        pcm = ref_pcm(theme)
        length, (lead, last) = len(pcm) / SAMPLE_RATE, sound_span(pcm)
    except Exception:
        return {"start": c.start, "end": c.start + c.ref_dur, "music": None, "exact": False,
                "length": c.ref_dur, "lead": None, "tail": None, "declared": (0.0, 0.0), "mute_tail": None,
                "mixed_head": 0.0}
    try:
        # Indice de recherche seulement, et seulement si les images concordent.
        hint = c.img_shift if (c.img or 0.0) >= decide.MIN_IMAGE else 0.0
        tail_from = getattr(c, "tail_from", 0.0)
        # Fin seule : les tranches de calage viennent du bout propre.
        pieces = [tail_from + 1.0, (tail_from + last - PIECE_S) / 2, last - PIECE_S - 1.0] if tail_from else None
        t0 = refine_offset(stream["url"], stream.get("referer"), c.start + hint, pcm, pieces)
    except Exception:
        t0 = None
    file_start = c.start if t0 is None else t0
    first, final = file_start + lead, file_start + last
    head, tail = declared_silence(theme.key)
    quiet = None if t0 is None else mute_end(stream["url"], stream.get("referer"), final, file_start + length)
    end = final + tail if tail else (quiet or final)
    # mute_tail : l'episode est muet jusqu'au BOUT du fichier (la fin peut
    # aussi s'arreter avant, au retour du son : cf. mute_end).
    mute = None if quiet is None else bool(quiet >= file_start + length)
    # Son de l'episode par-dessus la tete : le debut attend que la chanson soit
    # seule (cf. Candidate.mixed_head). Temps de l'empreinte, donc depuis c.start.
    mixed = getattr(c, "tail_from", 0.0) or c.mixed_head(lead)
    start = max(first - head, c.start + mixed) if mixed else first - head
    return {"start": start, "end": end, "music": [first, final], "exact": t0 is not None,
            "length": length, "lead": lead, "tail": length - last, "declared": (head, tail), "mute_tail": mute,
            "mixed_head": float(start - (first - head))}


def detect_host(mal: int, lang: str, ep: int, stream: dict, refs) -> dict:
    """Detection + ce qu'elle a coute : temps reel par etape et reseau. Les
    octets sont ceux du lot entier pendant ce lecteur : exacts avec
    --workers 1, melanges entre episodes sinon."""
    t0, net, steps = time.perf_counter(), stats.snapshot(), {}
    entry = _detect_host(mal, lang, ep, stream, refs, steps)
    entry["timing"] = {**{k: round(v, 2) for k, v in steps.items()},
                       "total_s": round(time.perf_counter() - t0, 2), "reseau": stats.since(net)}
    return entry


def _detect_host(mal: int, lang: str, ep: int, stream: dict, refs, steps: dict) -> dict:
    t = time.perf_counter()
    cached = (CACHE / f"{mal}_{lang}_ep{ep}_{stream['host']}.npz").exists()
    dur, efp = fingerprint_stream(mal, lang, ep, stream)
    steps["empreinte_s"], steps["empreinte_en_cache"] = time.perf_counter() - t, cached
    t = time.perf_counter()
    cands: list[decide.Candidate] = []
    for r in refs:
        for o in occurrences(r.fp, efp):
            c = decide.Candidate(r.theme.key, r.theme.kind, r.duration, o)
            # Sous REPORT_COVERAGE aussi quand la fin seule est servable
            # (Railgun S ep14, ED2 : 48 %).
            if o.coverage >= decide.REPORT_COVERAGE or c.audio_ok():
                cands.append(c)
    served = []
    for c in cands:
        if not c.audio_ok():
            continue
        # La fin seule ne se sert qu'en fin d'episode : ailleurs, 15 s de
        # chanson propre sont une musique de scene.
        if c.tail_from and c.end(dur) < dur - decide.MID_TAIL_S:
            c.reasons.append("fin_seule_hors_fin_episode")
            continue
        videos = next(r.theme.videos for r in refs if r.theme.key == c.ref)
        try:
            c.img, c.img_shift = image_score(stream, c, videos)
        except Exception:
            pass  # l'image n'est qu'une information : sans elle, on sert quand meme
        # Sauf au milieu de l'episode, ou une chanson de generique est d'abord
        # une musique de scene : la, il faut les images du generique.
        if c.mid_episode(dur) and (c.img or 0.0) < decide.MIN_IMAGE:
            c.reasons.append("milieu_episode")
            continue
        served.append(c)
    steps["image_s"] = time.perf_counter() - t
    t = time.perf_counter()
    slots, notes = decide.pick(served, dur)
    entry = {"duration": round(dur, 3), "algo_version": ALGO_VERSION,
             "candidates": [c.as_dict(dur) for c in cands], "notes": notes}
    clock = None
    if slots:
        # Tous nos temps sont en PTS absolus ; le site affiche l'horloge du
        # lecteur, dont le 0 est le debut du flux. Sans lui, on ne sert rien
        # (Railgun S ep1 megaplay : flux qui commence a 1,4 s).
        clock = stream_origin(stream["url"], stream.get("referer"))
        entry["clock_offset"] = clock
        if clock is None:
            entry["notes"].append("horloge_lecteur_inconnue")
            return entry
        # La duree sondee est la fin du flux en PTS : le site affiche 23:44
        # pour megaplay ep1 (1425,48 - 1,40).
        entry["duration"] = round(dur - clock, 3)
    for slot, c in slots.items():
        theme = next(r.theme for r in refs if r.theme.key == c.ref)
        tb = theme_bounds(stream, c, theme)
        start, end = max(0.0, tb["start"]) - clock, min(tb["end"], dur) - clock
        hit = {"start": round(start, 3), "end": round(end, 3), "votes": None,
               "audio_exact": tb["exact"], "ref_dur": round(tb["length"], 3),
               # Rembourrage du FICHIER de reference, hors bornes ; pour information.
               "lead_silence": None if tb["lead"] is None else round(tb["lead"], 3),
               "tail_silence": None if tb["tail"] is None else round(tb["tail"], 3),
               "declared_silence": list(tb["declared"]), "mute_tail": tb["mute_tail"],
               "mixed_head": round(tb["mixed_head"], 3), "tail_only": bool(getattr(c, "tail_from", 0.0)),
               "audio_start": round(c.start - clock, 2), "file_end": round(c.end(dur) - clock, 2),
               "music": [round(m - clock, 3) for m in tb["music"]] if tb["music"] else None,
               "source": "v2-audio", "confirmed_by_video": (c.img or 0.0) >= decide.MIN_IMAGE, "serve": True,
               "ref": c.ref, "kind": c.kind, "coverage": round(c.occ.coverage, 3), "img": None if c.img is None else round(c.img, 3),
               "img_shift": c.img_shift}
        if slot == "ed":
            hit["from_end_start"] = round(entry["duration"] - hit["start"], 3)
            hit["from_end_end"] = round(entry["duration"] - hit["end"], 3)
        entry[slot] = hit
    steps["bords_s"] = time.perf_counter() - t
    return entry


def detect_episode(entry: dict, season: dict, ep: int) -> dict:
    mal, lang = entry["mal_id"], season["lang"]
    refs = load(mal)
    rec = {"mal_id": mal, "episode": ep, "lang": lang, "n_refs": len(refs), "per_host": {}}
    if not refs:
        rec["error"] = "aucune_reference"
        return rec
    for stream in resolve(entry, season, ep, **({"hosts": ONLY_HOSTS} if ONLY_HOSTS else {})):
        host = stream["host"]
        try:
            rec["per_host"][host] = detect_host(mal, lang, ep, stream, refs)
        except Exception as exc:
            rec["per_host"][host] = {"detect_error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    # Second essai des lecteurs en panne, URL fraiches : sur gt10, les echecs
    # etaient transitoires (ffprobe megaplay > 30 s, 502 ansembed). Une panne
    # n'est JAMAIS une absence de generique : elle reste marquee detect_error.
    failed = [h for h, e in rec["per_host"].items() if "detect_error" in e]
    if failed:
        time.sleep(RETRY_DELAY_S)
        for stream in resolve(entry, season, ep, hosts=failed, fresh=True):
            try:
                rec["per_host"][stream["host"]] = detect_host(mal, lang, ep, stream, refs) | {"retried": True}
            except Exception as exc:
                rec["per_host"][stream["host"]]["detect_error_retry"] = f"{type(exc).__name__}: {str(exc)[:200]}"
    return rec


def summary(rec: dict) -> str:
    parts = []
    for h, e in rec["per_host"].items():
        if "detect_error" in e:
            parts.append(f"{h}:ERR")
            continue
        s = "".join(k.upper() if k in e else "-" for k in ("op", "ed"))
        parts.append(f"{h}:{s}")
    return " ".join(parts) or rec.get("error", "aucun lecteur")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--anime-list", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--lang", choices=["vostfr", "vf"])
    ap.add_argument("--hosts", help="lecteurs a traiter, separes par des virgules (defaut : tous)")
    a = ap.parse_args(argv)
    if a.hosts:
        global ONLY_HOSTS
        ONLY_HOSTS = [h.strip() for h in a.hosts.split(",") if h.strip()]

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():
        for line in out.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            done.add((r["mal_id"], r["episode"], r["lang"]))

    tasks = []
    for entry in json.load(open(a.anime_list, encoding="utf-8")):
        for season in entry["seasons"]:
            if a.lang and season["lang"] != a.lang:
                continue
            eps = season.get("episodes") or range(season["ep_start"], season["ep_end"] + 1)
            for ep in eps:
                if (entry["mal_id"], ep, season["lang"]) not in done:
                    tasks.append((entry, season, ep))
    print(f"{len(tasks)} episodes a traiter ({len(done)} deja faits)", flush=True)

    def work(t):
        entry, season, ep = t
        try:
            rec = detect_episode(entry, season, ep)
        except Exception:
            print(f"!! {entry['mal_id']} ep{ep} {season['lang']}\n{traceback.format_exc()}", flush=True)
            return
        with _write, open(out, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"{entry['title'][:26]:<26} ep{ep:<3} {season['lang']:<6} {summary(rec)}", flush=True)

    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        list(pool.map(work, tasks))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
