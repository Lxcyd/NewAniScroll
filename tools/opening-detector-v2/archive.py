"""Le son de chaque generique entendu, garde sans perte : rejouer une regle de
bornes ne doit jamais obliger a retelecharger le catalogue.

Le 02/10/2026 les regles de bornes ont change cinq fois dans la journee, et
chacune demandait le son autour du generique (calage a l'echantillon, queue
muette). Sur un lot de plusieurs semaines, un sixieme changement aurait coute
le lot entier. Ici, pour chaque candidat entendu, servi ou non, on garde de
MARGIN_S avant son debut a MARGIN_S apres la fin de sa reference : mono
11 kHz, FLAC 16 bits, sur le disque d'archive (OPED_ARCHIVE).

Le lot calcule ses bornes SUR CETTE FENETRE, deja ramenee a 16 bits, et non
sur le flux : le rejeu hors ligne (eval/replay.py) relit les memes
echantillons et rend donc les memes bornes, au bit pres.

Nom de fichier : <mal>/<mal>_<lang>_ep<ep>_<lecteur>_<debut en ms>.flac ; le
debut (temps absolu du premier echantillon, horloge detecteur) est AUSSI dans
la ligne de resultat (`archive`).
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import numpy as np

from fetch import SAMPLE_RATE as SR
from fetch.audio import decode_audio_abs

ROOT = Path(os.environ.get("OPED_ARCHIVE", r"H:\oped-archive"))
# 30 s pour les 44 premiers episodes du lot (SnK), 20 ensuite : le volume
# telecharge suit cette marge sur les lecteurs en 1080p seul. Les bornes ne
# lisent rien au-dela de 12 s avant la derniere note.
MARGIN_S = 20.0
# Un decodage refuse pour un paquet AAC tronque au point de depart repart
# d'ailleurs (cf. audio_edges.MUTE_BODY_S).
_MARGINS = (MARGIN_S, MARGIN_S + 3.0, MARGIN_S - 3.0)
MIN_FREE_BYTES = 10 * 1024 ** 3


class ArchiveError(RuntimeError):
    """L'archive n'a pas pu etre ecrite : le lecteur-episode n'est PAS traite."""


def available() -> str | None:
    """None si l'archive est utilisable, sinon la raison (disque debranche,
    plein). Le lot se met en pause tant que ce n'est pas None."""
    drive = Path(ROOT.anchor)
    if not drive.exists():
        return f"disque d'archive absent ({drive})"
    try:
        ROOT.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(ROOT).free
    except OSError as exc:
        return f"disque d'archive illisible ({exc})"
    if free < MIN_FREE_BYTES:
        return f"disque d'archive presque plein ({free / 1024 ** 3:.1f} Go libres)"
    return None


class Window:
    """Fenetre de son d'un episode, en 16 bits, avec son temps absolu."""

    def __init__(self, pcm16: np.ndarray, a0: float):
        self.pcm16, self.a0 = pcm16, float(a0)

    @property
    def end(self) -> float:
        return self.a0 + len(self.pcm16) / SR

    def covers(self, start: float, end: float) -> bool:
        return self.a0 <= start + 1e-6 and end <= self.end + 1e-6

    def decode(self, start: float, dur: float | None) -> tuple[np.ndarray, float]:
        """Meme contrat que fetch.audio.decode_audio_abs : (PCM float32, temps
        absolu du premier echantillon rendu)."""
        i = max(0, int(round((start - self.a0) * SR)))
        j = len(self.pcm16) if dur is None else min(len(self.pcm16), int(round((start + dur - self.a0) * SR)))
        if j <= i:
            raise RuntimeError(f"fenetre d'archive : [{start:.2f}, +{dur}] hors de [{self.a0:.2f}, {self.end:.2f}]")
        return self.pcm16[i:j].astype(np.float32) / 32767.0, self.a0 + i / SR


def spans(cands, ep_dur: float) -> list[tuple[float, float]]:
    """Intervalles a garder : un par candidat, fusionnes quand ils se touchent
    (ED1 et ED1v2 au meme endroit ne font qu'un fichier)."""
    raw = sorted((max(0.0, c.start - MARGIN_S), min(ep_dur, c.start + c.ref_dur + MARGIN_S)) for c in cands)
    out: list[list[float]] = []
    for a, b in raw:
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out if b - a > 1.0]


def _write_flac(path: Path, pcm16: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".part{os.getpid()}")
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-",
         "-c:a", "flac", "-compression_level", "8", "-f", "flac", str(tmp)],
        input=pcm16.astype("<i2").tobytes(), capture_output=True, timeout=300)
    if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        raise ArchiveError(f"ecriture FLAC {path.name}: {proc.stderr.decode(errors='replace')[-200:]}")
    tmp.replace(path)


def read(rel: str, a0: float) -> Window:
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(ROOT / rel), "-f", "s16le", "-ac", "1",
                          "-ar", str(SR), "-"], capture_output=True, timeout=300)
    if out.returncode != 0 or not out.stdout:
        raise ArchiveError(f"lecture {rel}: {out.stderr.decode(errors='replace')[-200:]}")
    return Window(np.frombuffer(out.stdout, dtype="<i2").copy(), a0)


def keep(mal: int, lang: str, ep: int, stream: dict, cands, ep_dur: float) -> tuple[list[Window], list[dict]]:
    """Decode et ecrit les fenetres de tous les candidats d'un lecteur-episode.
    Rend (fenetres, entrees `archive` de la ligne de resultat). Leve
    ArchiveError : sans archive, pas de resultat."""
    why = available()
    if why:
        raise ArchiveError(why)
    wins, meta = [], []
    for a, b in spans(cands, ep_dur):
        pcm = a0 = None
        last: Exception | None = None
        for k, margin in enumerate(_MARGINS):
            lo = max(0.0, a - (margin - MARGIN_S))
            try:
                pcm, a0 = decode_audio_abs(stream["url"], lo, b - lo, sample_rate=SR,
                                           referer=stream.get("referer"))
                break
            except Exception as exc:
                last = exc
        if pcm is None:
            raise ArchiveError(f"fenetre [{a:.0f}, {b:.0f}] illisible : {str(last)[:160]}")
        a0 = round(float(a0), 6)  # la valeur ecrite est celle qui sert : rejeu identique
        pcm16 = np.clip(np.round(pcm * 32767.0), -32768, 32767).astype(np.int16)
        rel = f"{mal}/{mal}_{lang}_ep{ep}_{stream['host']}_{int(round(a0 * 1000))}.flac"
        _write_flac(ROOT / rel, pcm16)
        wins.append(Window(pcm16, a0))
        meta.append({"file": rel, "a0": a0, "n": int(len(pcm16))})
    return wins, meta


def window_for(wins: list[Window], start: float) -> Window | None:
    """La fenetre qui contient le debut du candidat."""
    t = max(0.0, start)
    return next((w for w in wins if w.a0 - 1.0 <= t < w.end), None)
