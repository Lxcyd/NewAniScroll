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
from fetch.clock import stream_origin
from fetch.episode import fingerprint_stream, resolve
from fp.chroma import decode_file
from match.audio_edges import refine_offset, sound_span
from match.ber import occurrences
from match.edges import HOLD_S, first_content, refine_end, refine_start
from match.image import FPS, MATCH_NCC, SHIFT_MAX_S, best_shift, compare, episode_frames, fine_align, ref_frames
from refs.animethemes import download
from refs.bank import load

ALGO_VERSION = 100  # v2 ; la v1 est en 1-2
_write = threading.Lock()
RETRY_DELAY_S = 15


def image_score(stream: dict, cand: decide.Candidate, videos):
    """(part des images concordantes, decalage image/son, sim, temps, images de
    reference). Decalage nul d'abord ; sinon meilleur decalage a +/- 3 s."""
    ef, et = episode_frames(stream["url"], cand.start - SHIFT_MAX_S, cand.ref_dur + 2 * SHIFT_MAX_S,
                            referer=stream.get("referer"))
    refs = [ref_frames(download(v.link, "video")) for v in videos]
    shift = 0.0
    sim = compare(ef, et, cand.start, refs)
    valid = sim[~np.isnan(sim)]
    frac = float((valid >= MATCH_NCC).mean()) if len(valid) else 0.0
    if frac < decide.MIN_IMAGE:
        shift, frac = best_shift(ef, et, cand.start, refs)
    return frac, shift, ef, et, refs


def zone_image(c: decide.Candidate, zone: str) -> float:
    """Part des images concordantes dans la tete ou la queue de la reference :
    la preuve qui remplace le son la ou il ne concorde pas. 0 si trop peu
    d'images comparables (on ne sert pas sur une zone non verifiee)."""
    t0 = c.start + c.img_shift
    sim = compare(c.frames, c.times, t0, c.refimgs)
    r = c.times - t0
    lo, hi = (0.0, decide.EDGE_ZONE_S) if zone == "tete" else (c.ref_dur - decide.EDGE_ZONE_S, c.ref_dur)
    v = sim[(r >= lo) & (r < hi) & ~np.isnan(sim)]
    return float((v >= MATCH_NCC).mean()) if len(v) >= 10 else 0.0


def edges(stream: dict, c: decide.Candidate, ep_dur: float) -> tuple[float, float]:
    """Bords a l'image pres : c'est a l'ecran que le generique commence et
    finit, et le son n'y est pas cale (Railgun S ep1 : megaplay montre le
    flash blanc de l'OP 0,6 s avant la musique, frembed 1,7 s apres).
    - alignement image fin (pas de 0,04 s) autour du decalage grossier ;
    - debut = premiere image de la reference qui n'est pas du noir d'amorce ;
    - fin = derniere image concordante a cadence native, le carton final
      pouvant rester affiche jusqu'a HOLD_S de plus que dans le clip.
    En cas d'echec : les bords audio."""
    t0v = c.start + c.img_shift
    fallback = (max(0.0, t0v), min(t0v + c.ref_dur, ep_dur))
    ref = stream.get("referer")
    try:
        t0v += fine_align(c.frames, c.times, t0v, c.refimgs)
        start = t0v + first_content(c.refimgs)
        start = refine_start(stream["url"], start, c.refimgs, referer=ref) or start
        sim = compare(c.frames, c.times, t0v, c.refimgs, hold=HOLD_S)
        ok = np.nan_to_num(sim, nan=0.0) >= MATCH_NCC
        last = np.flatnonzero(ok)
        cap = min(t0v + c.ref_dur + HOLD_S, ep_dur)
        coarse = min(float(c.times[last[-1]]) + 1.0 / FPS, cap) if len(last) else fallback[1]
        end = refine_end(stream["url"], t0v, coarse, c.refimgs, referer=ref) or coarse
    except Exception:
        return fallback
    return max(0.0, start), min(end, cap)


_pcm: dict[str, np.ndarray] = {}
_pcm_lock = threading.Lock()


def ref_pcm(theme) -> np.ndarray:
    with _pcm_lock:
        if theme.key not in _pcm:
            _pcm[theme.key] = decode_file(download(theme.audio_link, "audio"))
        return _pcm[theme.key]


def music_edges(stream: dict, c: decide.Candidate, theme) -> tuple[float, float] | None:
    """Debut et fin de la MUSIQUE (horloge detecteur) : position de la
    reference a l'echantillon pres + premier / dernier son de la reference.
    None si la position n'est pas etablie (tranches en desaccord)."""
    try:
        pcm = ref_pcm(theme)
        t0 = refine_offset(stream["url"], stream.get("referer"), c.start + c.img_shift, pcm)
    except Exception:
        return None
    if t0 is None:
        return None
    a, b = sound_span(pcm)
    return t0 + a, t0 + b


def detect_host(mal: int, lang: str, ep: int, stream: dict, refs) -> dict:
    dur, efp = fingerprint_stream(mal, lang, ep, stream)
    cands: list[decide.Candidate] = []
    for r in refs:
        for o in occurrences(r.fp, efp):
            if o.coverage >= decide.REPORT_COVERAGE:
                cands.append(decide.Candidate(r.theme.key, r.theme.kind, r.duration, o))
    served = []
    for c in cands:
        if not c.audio_ok():
            continue
        videos = next(r.theme.videos for r in refs if r.theme.key == c.ref)
        # Un segment injoignable pendant le controle image est une panne de
        # transport, pas un verdict : on reessaie avant de s'abstenir (SnK ep25
        # VF, ansembed : seule abstention sur une cellule jugee juste du lot gt10).
        for attempt in range(2):
            try:
                c.img, c.img_shift, c.frames, c.times, c.refimgs = image_score(stream, c, videos)
                break
            except Exception as exc:
                err = exc
                time.sleep(RETRY_DELAY_S)
        else:
            c.reasons.append(f"image_indisponible: {str(err)[:80]}")
            continue
        if c.img < decide.MIN_IMAGE:
            c.reasons.append("image")
            continue
        bad = [z for z in c.edge_zones if zone_image(c, z) < decide.MIN_IMAGE]
        if bad:
            c.reasons += [f"image_{z}" for z in bad]
            continue
        served.append(c)
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
        vs, ve = edges(stream, c, dur)
        # Le generique commence des que sa musique OU ses images commencent, et
        # finit quand les deux ont fini (Luc, 30/09/2026 : « la musique commence
        # avant tes timings » — Railgun S ep1 megaplay, chanson a 22:01.425,
        # premiere image de la reference a 22:01.55).
        theme = next(r.theme for r in refs if r.theme.key == c.ref)
        music = music_edges(stream, c, theme)
        start, end = (min(vs, music[0]), max(ve, min(music[1], dur))) if music else (vs, ve)
        start, end = start - clock, end - clock
        hit = {"start": round(start, 2), "end": round(end, 2), "votes": None,
               "audio_start": round(c.start - clock, 2), "file_end": round(c.end(dur) - clock, 2),
               "music": [round(m - clock, 3) for m in music] if music else None,
               "image": [round(vs - clock, 3), round(ve - clock, 3)],
               "source": "v2-audio+image", "confirmed_by_video": True, "serve": True,
               "ref": c.ref, "kind": c.kind, "coverage": round(c.occ.coverage, 3), "img": round(c.img, 3),
               "img_shift": c.img_shift}
        if slot == "ed":
            hit["from_end_start"] = round(entry["duration"] - hit["start"], 2)
            hit["from_end_end"] = round(entry["duration"] - hit["end"], 2)
        entry[slot] = hit
    return entry


def detect_episode(entry: dict, season: dict, ep: int) -> dict:
    mal, lang = entry["mal_id"], season["lang"]
    refs = load(mal)
    rec = {"mal_id": mal, "episode": ep, "lang": lang, "n_refs": len(refs), "per_host": {}}
    if not refs:
        rec["error"] = "aucune_reference"
        return rec
    for stream in resolve(entry, season, ep):
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
    a = ap.parse_args(argv)

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
