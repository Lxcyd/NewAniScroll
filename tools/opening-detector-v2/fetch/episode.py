"""Resolution des lecteurs d'un episode et empreinte audio de l'episode complet."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import numpy as np

from . import SAMPLE_RATE
from .adapter_aniscroll import resolve_episodes_multi
from .audio import decode_audio_abs
from .probe import probe_duration

CACHE = Path(os.environ.get("OPED_EP_CACHE", "cache/ep"))  # variable : mesurer un lot a froid sans vider le cache

# Tete et fin d'abord (lot catalogue, 03/10/2026). Sur les 410 generiques servis
# de la page, tout ED commence dans les 5 dernieres minutes et tout OP finit
# avant 8 min ou se joue en fin d'episode : le milieu (~30 % des octets) ne
# sert qu'a un OP place apres un tres long prologue. On ne le telecharge que
# si aucun OP n'a ete trouve (run._detect_host). Le milieu est du SILENCE dans
# l'empreinte : les temps restent absolus, rien ne change en aval.
HEAD_S = 600.0
TAIL_S = 420.0
# Fenetres GUIDEES : autour de chaque theme deja entendu sur un autre lecteur
# du meme episode (lot.py). Mesure du 02/10/2026 : ansembed ne propose parfois
# que du 1080p a 8 Mb/s (Mob Psycho 100, 1,2 Go par episode) ; lire 10 + 7 min
# de chaque lecteur ferait plus de 15 To sur le catalogue. Les lecteurs d'un
# meme episode placent le theme a moins de 20 s les uns des autres (frembed :
# +17,6 s sur Railgun S) ; au-dela, le theme sort de la fenetre, n'est pas
# reconnu, et le lecteur repasse en tete + fin.
# 45 s au depart ; 30 depuis le 03/10/2026 : sur SnK, megaplay et ansembed (un
# seul rendu, 1080p, 190 et 405 Mo par episode) pesaient 85 % du volume, et
# les ecarts mesures entre lecteurs y vont de -16,6 a +16,0 s.
GUIDE_GUARD_S = 30.0


def season_of(entry: dict, lang: str) -> dict:
    return next(s for s in entry["seasons"] if s["lang"] == lang)


def resolve(entry: dict, season: dict, ep: int, hosts: list[str] | None = None,
            *, fresh: bool = False) -> list[dict]:
    """Flux de l'episode par lecteur. `fresh` ignore le cache d'URL (6 h) :
    pour un second essai, une URL signee perimee ou un CDN tournant
    (megaplay) se regle souvent par une nouvelle resolution."""
    extra = {"cache_dir": tempfile.mkdtemp(prefix="urls-", dir="cache")} if fresh else {}
    return resolve_episodes_multi(
        entry["slug"], season["season_dir"], season["lang"], ep, ep, hosts=hosts, **extra,
        mal_id=entry["mal_id"],
        va_slug=season.get("va_slug") or entry.get("va_slug") or entry["slug"],
        frembed=season.get("frembed")).get(ep, [])


def cached_windows(mal: int, lang: str, ep: int, host: str):
    """Ce que couvre l'empreinte en cache : None (pas d'empreinte), [] (flux
    entier) ou la liste des fenetres (debut, fin) telechargees."""
    path = CACHE / f"{mal}_{lang}_ep{ep}_{host}.npz"
    if not path.exists():
        return None
    # `with` : np.load garde le fichier OUVERT ; sous Windows, le remplacement
    # d'une empreinte partielle par une plus large etait alors refuse (Railgun S
    # ep24, 02/10/2026 : les trois lecteurs en PermissionError).
    with np.load(path) as z:
        if "windows" in z.files:
            return [(float(a), float(b)) for a, b in z["windows"]]
        if "partial" in z.files and bool(z["partial"]):
            d = float(z["duration"])
            return [(0.0, HEAD_S), (d - TAIL_S, d)]
        return []


def is_partial(mal: int, lang: str, ep: int, host: str) -> bool:
    return bool(cached_windows(mal, lang, ep, host))


def _normalize(windows, dur: float) -> list[tuple[float, float]]:
    """Fenetres bornees a l'episode, triees, fusionnees ; [] si elles couvrent
    presque tout (autant prendre le flux entier, en un seul decodage)."""
    if windows == "std":
        windows = [(0.0, HEAD_S), (dur - TAIL_S, dur)] if dur > HEAD_S + TAIL_S + 60.0 else []
    out: list[list[float]] = []
    for a, b in sorted((max(0.0, a), min(dur, b)) for a, b in windows):
        if b - a < 1.0:
            continue
        if out and a <= out[-1][1] + 5.0:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    if sum(b - a for a, b in out) > dur - 60.0:
        return []
    return [(a, b) for a, b in out]


def _covered(have, want) -> bool:
    if have is None:
        return False
    if have == []:
        return True
    if want == []:
        return False
    return all(any(a0 <= a + 0.5 and b <= b0 + 0.5 for a0, b0 in have) for a, b in want)


def _place(pcm_all: np.ndarray, pcm: np.ndarray, t0: float) -> None:
    """Pose `pcm`, dont le premier echantillon est au temps absolu t0, dans
    le tableau de l'episode (echantillon 0 = t 0)."""
    i = int(round(t0 * SAMPLE_RATE))
    if i < 0:
        pcm, i = pcm[-i:], 0
    n = min(len(pcm), len(pcm_all) - i)
    if n > 0:
        pcm_all[i:i + n] = pcm[:n]


def fingerprint_stream(mal: int, lang: str, ep: int, stream: dict, *,
                       partial: bool = False, windows=None) -> tuple[float, np.ndarray]:
    """(duree, empreinte chromaprint) du flux, temps absolus, en cache.

    Sans option : le flux entier. `windows` : seulement ces fenetres (debut,
    fin) en secondes, ou "std" pour la tete et la fin (HEAD_S, TAIL_S) ; le
    reste est du silence dans l'empreinte. `partial=True` vaut windows="std".
    Une empreinte en cache convient si elle couvre ce qui est demande ; sinon
    elle est refaite et remplacee."""
    from fp.chroma import fingerprint

    if partial and windows is None:
        windows = "std"
    path = CACHE / f"{mal}_{lang}_ep{ep}_{stream['host']}.npz"
    have = cached_windows(mal, lang, ep, stream["host"])
    if have is not None:
        with np.load(path) as z:
            dur, fp = float(z["duration"]), z["fp"]
        if _covered(have, [] if windows is None else _normalize(windows, dur)):
            return dur, fp
    url, referer = stream["url"], stream.get("referer")
    dur = probe_duration(url, referer)
    wins = [] if windows is None else _normalize(windows, dur)
    if wins:
        pcm = np.zeros(int(round(dur * SAMPLE_RATE)) + SAMPLE_RATE, np.float32)
        for a, b in wins:
            part, t0 = decode_audio_abs(url, a, None if b >= dur - 1.0 else b - a,
                                        sample_rate=SAMPLE_RATE, referer=referer)
            _place(pcm, part, t0)
    else:
        pcm, t0 = decode_audio_abs(url, 0.0, dur, sample_rate=SAMPLE_RATE, referer=referer)
        # Recaler l'echantillon 0 sur t=0 : les temps de l'empreinte sont alors absolus.
        if t0 > 0.01:
            pcm = np.concatenate([np.zeros(int(round(t0 * SAMPLE_RATE)), np.float32), pcm])
        elif t0 < -0.01:
            pcm = pcm[int(round(-t0 * SAMPLE_RATE)):]
    fp = fingerprint(pcm)
    CACHE.mkdir(parents=True, exist_ok=True)
    # Ecriture atomique : un arret brutal ne doit pas laisser une empreinte
    # tronquee que la reprise prendrait pour bonne.
    tmp = path.with_name(path.stem + f".part{os.getpid()}.npz")
    np.savez(tmp, fp=fp, duration=dur, partial=bool(wins), windows=np.array(wins, dtype=np.float64).reshape(-1, 2))
    tmp.replace(path)
    return dur, fp
