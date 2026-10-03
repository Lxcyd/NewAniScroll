"""Lot v2 : liste d'animes -> JSONL par episode, par lecteur.

    python run.py --anime-list ../opening-detector/datasets/anime.gt10.json --out out/gt10.jsonl

Reprend la ou il s'est arrete (episodes deja ecrits sautes) : supprimer le
fichier de sortie pour recalculer. Le format per_host est celui de
scripts/oped/import-oped-host-skips.mjs ; en plus, chaque lecteur porte ses
`candidates` (tout ce qui a ete vu, retenu ou non, avec la raison).

Le son decide seul. L'image n'est calculee que pour un candidat au milieu de
l'episode (decide.MID_*), ou partout avec --images (page de releve) : elle
coutait plus de la moitie du temps d'un lot pour ne plus rien decider.
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

import archive
import decide
from fetch import SAMPLE_RATE, stats
from fetch.clock import stream_origin
from fetch.episode import CACHE, GUIDE_GUARD_S, cached_windows, fingerprint_stream, resolve
from fp.chroma import decode_file
from match.audio_edges import PIECE_S, mute_end, refine, sound_span
from match.image import MATCH_NCC, SHIFT_MAX_S, best_shift, compare, episode_frames, ref_frames
from refs.animethemes import download
from refs.bank import load

# v2 ; la v1 est en 1-2. 101 (02/10/2026) : son seul, queue muette jusqu'au
# retour du son, tete recouverte, fin seule, references avec dialogue.
# 102 (03/10/2026) : calage confirme par l'enveloppe quand le mixage differe.
# 103 (03/10/2026) : l'enveloppe fait foi quand la forme d'onde est trop faible
# pour situer, et vitesse estimee quand les trois tranches derivent sur une
# droite (doublage accelere 1000/1001).
ALGO_VERSION = 103
_write = threading.Lock()
RETRY_DELAY_S = 15
# --hosts : ne repasser que ces lecteurs (megaplay ecarte d'un lot par des 403
# transitoires : on le refait seul, lentement, puis on fusionne).
ONLY_HOSTS: list[str] | None = None
IMAGES = False  # --images : part d'images conformes de chaque candidat, pour information
# Lot catalogue (lot.py). KEEP : le son de chaque candidat est archive et les
# bornes sont calculees sur l'archive. PARTIAL : tete et fin d'abord, le milieu
# seulement si aucun OP n'a ete trouve (fetch.episode.HEAD_S).
KEEP = False
PARTIAL = False


def image_score(stream: dict, cand: decide.Candidate, videos) -> float:
    """Part des images de l'episode qui sont celles de la video de reference,
    au meme temps relatif ; decalage nul d'abord, sinon le meilleur a +/- 3 s.

    Ne decide qu'au milieu de l'episode (decide.mid_episode). Exigee partout
    jusqu'au 02/10/2026, elle faisait s'abstenir sur des generiques valides :
    Railgun S ep6, ED lance sur la fin de la scene ; Cyberpunk ep1, chanson
    de l'OP sur les credits deroulants de fin (6 %)."""
    ef, et = episode_frames(stream["url"], cand.start - SHIFT_MAX_S, cand.ref_dur + 2 * SHIFT_MAX_S,
                            referer=stream.get("referer"))
    refs = [ref_frames(download(v.link, "video")) for v in videos]
    sim = compare(ef, et, cand.start, refs)
    valid = sim[~np.isnan(sim)]
    frac = float((valid >= MATCH_NCC).mean()) if len(valid) else 0.0
    if frac < decide.MIN_IMAGE:
        frac = best_shift(ef, et, cand.start, refs)[1]
    return frac


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


def theme_bounds(stream: dict, c: decide.Candidate, theme, src=None) -> dict:
    """Bornes du generique AU SON, horloge detecteur. Regles et cas d'origine :
    README, « Regles de bornes ».

    Debut = premiere note de la reference dans l'episode (le silence de tete
    des clips AnimeThemes est du rembourrage), ou plus tard si le son de
    l'episode recouvre encore la chanson (decide.head_cut). Fin = derniere
    note, prolongee tant que l'episode reste muet, au plus jusqu'au bout du
    fichier de reference (audio_edges.mute_end). Un theme qui contient un VRAI
    silence se declare dans refs/silences.json.

    La position vient de la correlation des formes d'onde (refine_offset, a
    quelques ms) ; si ses tranches ne concordent pas, on garde celle de
    Chromaprint (0,12 s), sans queue muette, et `exact` le dit.

    `src` : fenetre de son archivee (archive.Window) a lire a la place du
    flux ; c'est le chemin du lot catalogue et du rejeu hors ligne."""
    src, referer, env = src or stream["url"], stream.get("referer"), {}
    try:
        pcm = ref_pcm(theme)
        length, (lead, last) = len(pcm) / SAMPLE_RATE, sound_span(pcm)
    except Exception:
        return {"start": c.start, "end": c.start + c.ref_dur, "music": None, "exact": False,
                "length": c.ref_dur, "lead": None, "tail": None, "declared": (0.0, 0.0), "mute_tail": None,
                "head_cut": 0.0, "env": env}
    # Fin seule : les tranches de calage viennent du bout propre.
    pieces = ([c.tail_from + 1.0, (c.tail_from + last - PIECE_S) / 2, last - PIECE_S - 1.0]
              if c.tail_from else None)
    try:
        t0, rate = refine(src, referer, c.start, pcm, pieces) or (None, 1.0)
    except Exception:
        t0, rate = None, 1.0
    file_start = c.start if t0 is None else t0
    # Positions de la reference ramenees au temps episode (vitesse != 1 : cf. RATE_MAX).
    first, final = file_start + lead * rate, file_start + last * rate
    head, tail = declared_silence(theme.key)
    quiet = None if t0 is None else mute_end(src, referer, final, file_start + length * rate, env)
    end = final + tail if tail else (quiet or final)
    # Temps de l'empreinte, donc compte depuis c.start et non file_start.
    cut = c.head_cut(lead)
    start = max(first - head, c.start + cut) if cut else first - head
    return {"start": start, "end": end, "music": [first, final], "exact": t0 is not None,
            "length": length, "lead": lead, "tail": length - last, "declared": (head, tail),
            # L'episode est muet jusqu'au BOUT du fichier de reference.
            "mute_tail": None if quiet is None else bool(quiet >= file_start + length * rate),
            "head_cut": float(start - (first - head)), "env": env}


def detect_host(mal: int, lang: str, ep: int, stream: dict, refs, plan: dict | None = None) -> dict:
    """Detection + ce qu'elle a coute : temps reel par etape et reseau. Les
    octets sont ceux du lot entier pendant ce lecteur : exacts avec
    --workers 1, melanges entre episodes sinon."""
    t0, net, steps = time.perf_counter(), stats.snapshot(), {}
    entry = _detect_host(mal, lang, ep, stream, refs, steps, plan)
    entry["timing"] = {**{k: round(v, 2) if isinstance(v, float) else v for k, v in steps.items()},
                       "total_s": round(time.perf_counter() - t0, 2), "reseau": stats.since(net)}
    return entry


def plan_from(entry: dict) -> dict | None:
    """Ce qu'un lecteur deja traite apprend aux autres lecteurs du meme
    episode : ou ecouter (autour de chaque candidat) et quels types attendre.
    None s'il n'a rien entendu : les autres ecoutent tete et fin."""
    cands = entry.get("candidates") or []
    if "detect_error" in entry or not cands:
        return None
    g = GUIDE_GUARD_S
    return {"windows": [(c["start"] - g, c["end"] + g) for c in cands],
            "kinds": sorted({c["kind"] for c in cands if not c["reasons"]})}


def _detect_host(mal: int, lang: str, ep: int, stream: dict, refs, steps: dict, plan: dict | None = None) -> dict:
    t = time.perf_counter()
    host = stream["host"]
    cached = (CACHE / f"{mal}_{lang}_ep{ep}_{host}.npz").exists()
    # Du moins cher au plus cher ; on s'arrete des que ce qu'on cherche est la.
    # - guide : fenetres autour des themes entendus sur un autre lecteur du
    #   meme episode ; suffit si tous les types qu'il a entendus sont entendus ici.
    # - tete_fin : suffit si un OP est entendu (ou si la serie n'a pas d'OP).
    # - entier : un OP peut suivre un tres long prologue.
    levels = [("entier", None)]
    if PARTIAL or plan:
        levels.insert(0, ("tete_fin", "std"))
    if plan:
        levels.insert(0, ("guide", plan["windows"]))
        # Le guide a deja cherche partout : ce qu'il a trouve est dans les
        # premieres et dernieres minutes. Un lecteur qui n'y retrouve rien sert
        # un autre contenu (Death Note, vidmoly-va : le meme fichier de 21:11
        # pour tous les episodes, telecharge EN ENTIER, en 1080p, a chaque fois
        # la nuit du 03/10/2026). Il s'abstient.
        levels.pop()
    has_op = any(r.theme.kind == "op" for r in refs)
    for level, windows in levels:
        dur, efp = fingerprint_stream(mal, lang, ep, stream, windows=windows)
        cands, heard = decide.shortlist(refs, efp, dur)
        kinds = {c.kind for c in heard}
        if level == "guide" and set(plan["kinds"]) <= kinds:
            break
        # Pas la moindre trace, meme partielle, la ou le guide a entendu ses
        # themes : fichier sans generique (Hunter x Hunter chez ansembed et
        # vidmoly-va : 1 min de moins, rien en tete ni en fin). Le relire en
        # tete + fin coutait ~1 Go par episode en 1080p pour ne rien trouver.
        # Un meme generique decale de plus de GUIDE_GUARD_S d'un lecteur a
        # l'autre serait perdu ; mesure jusqu'ici : 17 s au plus.
        if level == "guide" and not cands:
            steps["guide_sans_trace"] = True
            break
        # Aucune trace d'aucun theme en tete ni en fin, meme partielle : fichier
        # sans generique (Hunter x Hunter chez ansembed et vidmoly-va, 1 min plus
        # court que chez megaplay) ; le telecharger en entier ne trouverait rien.
        if level == "tete_fin" and ("op" in kinds or not has_op or not cands):
            break
    steps["niveau"] = level
    steps["empreinte_s"], steps["empreinte_en_cache"] = time.perf_counter() - t, cached
    t = time.perf_counter()
    served = []
    for c in heard:
        if IMAGES or c.mid_episode(dur):
            videos = next(r.theme.videos for r in refs if r.theme.key == c.ref)
            try:
                c.img = image_score(stream, c, videos)
            except Exception:
                pass  # sans image : servi quand meme, sauf au milieu de l'episode
        # Au milieu de l'episode, une chanson de generique est d'abord une
        # musique de scene : la, il faut les images du generique.
        if c.mid_episode(dur) and (c.img or 0.0) < decide.MIN_IMAGE:
            c.reasons.append("milieu_episode")
            continue
        served.append(c)
    steps["image_s"] = time.perf_counter() - t
    t = time.perf_counter()
    slots, notes = decide.pick(served, dur)
    entry = {"duration": round(dur, 3), "algo_version": ALGO_VERSION,
             "candidates": [c.as_dict(dur) for c in cands], "notes": notes,
             # Ce que l'empreinte couvre : [] = l'episode entier.
             "fenetres": [[round(a, 1), round(b, 1)] for a, b in cached_windows(mal, lang, ep, host) or []]}
    wins = []
    if KEEP and cands:
        # Avant tout calcul de bornes : elles se lisent sur l'archive.
        wins, entry["archive"] = archive.keep(mal, lang, ep, stream, cands, dur)
        steps["archive_s"] = time.perf_counter() - t
    clock = None
    if slots:
        # Tous nos temps sont en PTS absolus ; le site affiche l'horloge du
        # lecteur, dont le 0 est le debut du flux. Sans lui, on ne sert rien
        # (Railgun S ep1 megaplay : flux qui commence a 1,4 s).
        # Second essai : une lecture d'horloge ratee faisait perdre un OP deja
        # trouve (Railgun S ep22 ansembed, jour ou l'hote ramait).
        clock = (stream_origin(stream["url"], stream.get("referer"))
                 or stream_origin(stream["url"], stream.get("referer")))
        entry["clock_offset"] = clock
        if clock is None:
            entry["notes"].append("horloge_lecteur_inconnue")
            return entry
        # La duree sondee est la fin du flux en PTS : le site affiche 23:44
        # pour megaplay ep1 (1425,48 - 1,40).
        entry["duration"] = round(dur - clock, 3)
    fill_hits(entry, slots, refs, dur, clock, stream, wins if KEEP else None)
    steps["bords_s"] = time.perf_counter() - t
    return entry


def fill_hits(entry: dict, slots: dict, refs, dur: float, clock: float, stream: dict, wins) -> None:
    """Pose les generiques retenus dans `entry`, horloge du lecteur. `wins` :
    fenetres d'archive sur lesquelles lire les bornes (lot catalogue et rejeu
    hors ligne, eval/replay.py), ou None pour lire le flux."""
    for slot, c in slots.items():
        theme = next(r.theme for r in refs if r.theme.key == c.ref)
        src = None
        if wins is not None:
            src = archive.window_for(wins, c.start)
            if src is None:
                raise archive.ArchiveError(f"pas de fenetre d'archive pour {c.ref} a {c.start:.1f} s")
        tb = theme_bounds(stream, c, theme, src)
        start, end = max(0.0, tb["start"]) - clock, min(tb["end"], dur) - clock
        hit = {"start": round(start, 3), "end": round(end, 3),
               "audio_exact": tb["exact"], "ref_dur": round(tb["length"], 3),
               # Rembourrage du FICHIER de reference, hors bornes ; pour information.
               "lead_silence": None if tb["lead"] is None else round(tb["lead"], 3),
               "tail_silence": None if tb["tail"] is None else round(tb["tail"], 3),
               "declared_silence": list(tb["declared"]), "mute_tail": tb["mute_tail"],
               "mixed_head": round(tb["head_cut"], 3), "tail_only": bool(c.tail_from), "dirty_ref": c.dirty,
               "audio_start": round(c.start - clock, 2),
               "music": [round(m - clock, 3) for m in tb["music"]] if tb["music"] else None,
               "source": "v2-audio", "confirmed_by_video": (c.img or 0.0) >= decide.MIN_IMAGE, "serve": True,
               "ref": c.ref, "kind": c.kind, "coverage": round(c.occ.coverage, 3),
               "img": None if c.img is None else round(c.img, 3)}
        if wins is not None:
            hit["env"] = tb["env"]
        if slot == "ed":
            hit["from_end_start"] = round(entry["duration"] - hit["start"], 3)
            hit["from_end_end"] = round(entry["duration"] - hit["end"], 3)
        entry[slot] = hit


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
    ap.add_argument("--images", action="store_true", help="image de chaque candidat, pour information")
    a = ap.parse_args(argv)
    global IMAGES
    IMAGES = a.images
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
        print(f"{(entry.get('title') or entry['slug'])[:26]:<26} ep{ep:<3} {season['lang']:<6} {summary(rec)}", flush=True)

    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        list(pool.map(work, tasks))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
