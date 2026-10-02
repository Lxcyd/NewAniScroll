"""Sentinelles du lot catalogue : voir un resultat qui se degrade AVANT d'avoir
passe trois semaines a le produire.

Deux familles, appelees par lot.py :

- `Sentinels` : mesures glissantes sur les lignes qui sortent. « pause »
  arrete le lot (code 3) ; « alerte » se lit dans l'etat.
  * desaccord entre lecteurs d'un meme episode : theme different, musique de
    longueur differente, ou decalage qui n'est pas le meme a l'OP et a l'ED
    (cf. `disagreements`) ;
  * part de lecteurs-episodes avec generique, par lecteur, en chute par
    rapport au palier 1 (out/catalogue.baseline.json) ;
  * part de bornes non calees a l'echantillon (`audio_exact` faux).
- `canaries` : trois lecteurs-episodes de Railgun S, valides par Luc sur la
  page de releve, refaits de bout en bout par le meme chemin que le lot.
  Bornes differentes de plus de CANARY_TOL_S : pause. C'est ce qui detecte
  une regression du code ou un lecteur qui change de comportement.
"""
from __future__ import annotations

import collections
import json
import re
import shutil
import tempfile
from pathlib import Path

SAME_FILE_S = 0.2
AGREE_S = 0.5
MAX_DISAGREE = 0.02
SERVE_DROP = 0.15
INEXACT_RISE = 0.15
INEXACT_ALONE = 0.30   # sans palier de reference
CANARY_TOL_S = 0.05

CANARY_ENTRY = {"mal_id": 16049, "slug": "a-certain-scientific-railgun"}
CANARY_SEASON = {"season_dir": "saison2", "lang": "vostfr", "frembed": "30977:2"}
CANARIES = [(2, "megaplay"), (3, "ansembed"), (8, "frembed")]


def file_clock(e: dict) -> dict:
    """Bornes dans l'horloge du FICHIER : celle du lecteur depend de la variante
    servie (ansembed : 0,101 ou 0,268 s d'origine selon le jour)."""
    c = e.get("clock_offset") or 0.0
    return {s: [round(e[s]["start"] + c, 3), round(e[s]["end"] + c, 3), e[s]["ref"]] for s in ("op", "ed") if e.get(s)}


def _theme(ref: str) -> str:
    """« OP1 » de « Serie-OP1v2-NCBD1080 » : deux versions du meme theme au
    meme endroit ne sont pas un desaccord."""
    m = re.search(r"-((?:OP|ED)\d*)", ref)
    return m.group(1) if m else ref


def disagreements(rec: dict) -> list[tuple[bool, str]]:
    """[(en desaccord, description)] pour chaque paire de lecteurs d'un episode
    et chaque type servi par les deux.

    Deux lecteurs servent rarement le MEME fichier, meme a duree egale (Mob
    Psycho 100 ep7 : megaplay et ansembed a 0,07 s de duree, themes a 1,03 s
    d'ecart — la premiere version de ce controle y voyait 23 % de desaccords).
    Ce qui ne depend pas de l'encode :
    - le theme reconnu ;
    - la longueur de la MUSIQUE (premiere a derniere note), a AGREE_S pres ;
    - a duree egale (+/- SAME_FILE_S), l'ecart entre les deux lecteurs, qui doit
      etre le meme pour l'OP et pour l'ED."""
    ok = [(h, e) for h, e in rec.get("per_host", {}).items() if "detect_error" not in e and "duration" in e]
    out = []
    tag = f"{rec['mal_id']} ep{rec['episode']} {rec['lang']}"
    for i, (h1, e1) in enumerate(ok):
        for h2, e2 in ok[i + 1:]:
            shifts = {}
            for s in ("op", "ed"):
                a, b = e1.get(s), e2.get(s)
                if not a or not b:
                    continue
                if _theme(a["ref"]) != _theme(b["ref"]):
                    out.append((True, f"{tag} {s} {h1}/{h2} : {a['ref']} contre {b['ref']}"))
                    continue
                if not (a.get("music") and b.get("music") and a.get("audio_exact") and b.get("audio_exact")):
                    continue
                la, lb = a["music"][1] - a["music"][0], b["music"][1] - b["music"][0]
                bad = abs(la - lb) > AGREE_S
                out.append((bad, f"{tag} {s} {h1}/{h2} : musique de {la:.2f} s contre {lb:.2f} s"))
                shifts[s] = b["music"][0] - a["music"][0]
            if len(shifts) == 2 and abs(e1["duration"] - e2["duration"]) <= SAME_FILE_S:
                bad = abs(shifts["op"] - shifts["ed"]) > AGREE_S
                out.append((bad, f"{tag} {h1}/{h2} : decalage de {shifts['op']:+.2f} s a l'OP et {shifts['ed']:+.2f} s a l'ED"))
    return out


class Sentinels:
    def __init__(self, baseline: Path):
        self.baseline = json.loads(baseline.read_text(encoding="utf-8")) if baseline.exists() else {}
        self.pairs: collections.deque = collections.deque(maxlen=500)
        self.serve: dict[str, collections.deque] = {}
        self.exact: collections.deque = collections.deque(maxlen=300)
        self.last_bad: str | None = None
        self.raised: set[str] = set()

    def feed(self, rec: dict) -> None:
        for bad, what in disagreements(rec):
            self.pairs.append(bad)
            if bad:
                self.last_bad = what
        for h, e in rec.get("per_host", {}).items():
            if "detect_error" in e:
                continue
            self.serve.setdefault(h, collections.deque(maxlen=200)).append(bool(e.get("op") or e.get("ed")))
            for s in ("op", "ed"):
                if e.get(s):
                    self.exact.append(bool(e[s].get("audio_exact")))

    def check(self) -> list[tuple[str, str]]:
        """Alertes NOUVELLES depuis le dernier appel."""
        found = []
        if len(self.pairs) >= 100:
            rate = sum(self.pairs) / len(self.pairs)
            if rate > MAX_DISAGREE:
                found.append(("pause", "desaccord", f"{rate:.1%} de desaccord entre lecteurs d'un meme fichier "
                                                    f"(dernier : {self.last_bad})"))
        for h, q in self.serve.items():
            ref = (self.baseline.get("serve") or {}).get(h)
            if ref is not None and len(q) >= 200 and sum(q) / len(q) < ref - SERVE_DROP:
                found.append(("pause", f"serve-{h}", f"{h} : generique trouve sur {sum(q) / len(q):.0%} des "
                                                     f"200 derniers episodes, contre {ref:.0%} au palier 1"))
        if len(self.exact) >= 200:
            inexact = 1 - sum(self.exact) / len(self.exact)
            ref = self.baseline.get("inexact")
            if ref is not None and inexact > ref + INEXACT_RISE:
                found.append(("pause", "inexact", f"{inexact:.0%} de bornes non calees a l'echantillon, contre {ref:.0%} au palier 1"))
            elif ref is None and inexact > INEXACT_ALONE:
                found.append(("alerte", "inexact", f"{inexact:.0%} de bornes non calees a l'echantillon"))
        out = [(lvl, msg) for lvl, key, msg in found if key not in self.raised]
        self.raised |= {key for _, key, _ in found}
        return out


def canaries(ref_path: Path, detect, load_refs) -> list[tuple[str, str]]:
    """Refait les temoins et les compare a leur reference (ecrite au premier
    passage, apres controle contre la page). `detect` : lot.detect."""
    from fetch.adapter_aniscroll import resolve_episodes_multi
    from fetch.episode import CACHE

    mal = CANARY_ENTRY["mal_id"]
    ref = json.loads(ref_path.read_text(encoding="utf-8")) if ref_path.exists() else {}
    out, fresh = [], dict(ref)
    refs = load_refs(mal)
    for ep, host in CANARIES:
        key = f"{ep}-{host}"
        tmp = tempfile.mkdtemp(prefix="urls-", dir="cache")
        try:
            streams = resolve_episodes_multi(
                CANARY_ENTRY["slug"], CANARY_SEASON["season_dir"], "vostfr", ep, ep, hosts=[host], cache_dir=tmp,
                mal_id=mal, va_slug=CANARY_ENTRY["slug"], frembed=CANARY_SEASON["frembed"]).get(ep, [])
        except Exception as exc:
            streams = []
            out.append(("alerte", f"{key} : resolution en echec ({str(exc)[:100]})"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        if not streams:
            out.append(("alerte", f"{key} : lecteur injoignable, temoin non verifie"))
            continue
        # « temoin » a la place de la langue : sa propre empreinte, refaite a chaque fois.
        (CACHE / f"{mal}_temoin_ep{ep}_{host}.npz").unlink(missing_ok=True)
        e = detect(mal, "temoin", ep, streams[0], refs)
        (CACHE / f"{mal}_temoin_ep{ep}_{host}.npz").unlink(missing_ok=True)
        if "detect_error" in e:
            out.append(("alerte", f"{key} : {e['detect_error'][:120]}"))
            continue
        got = {"duration": round(e["duration"] + (e.get("clock_offset") or 0.0), 3), **file_clock(e)}
        if key not in ref:
            fresh[key] = got
            out.append(("alerte", f"{key} : temoin enregistre {got}"))
            continue
        want = ref[key]
        variant = abs(want["duration"] - got["duration"]) > CANARY_TOL_S
        for s in ("op", "ed"):
            a, b = want.get(s), got.get(s)
            if (a is None) != (b is None) or (a and a[2] != b[2]):
                out.append(("pause", f"{key} {s} : attendu {a}, obtenu {b}"))
            elif a and variant:
                # Autre variante du fichier : seules les longueurs se comparent.
                if abs((a[1] - a[0]) - (b[1] - b[0])) > CANARY_TOL_S:
                    out.append(("pause", f"{key} {s} : longueur {b[1] - b[0]:.3f} s contre {a[1] - a[0]:.3f} s (autre variante du fichier)"))
            elif a and max(abs(a[0] - b[0]), abs(a[1] - b[1])) > CANARY_TOL_S:
                out.append(("pause", f"{key} {s} : {b[0]}-{b[1]} contre {a[0]}-{a[1]}"))
        if variant:
            out.append(("alerte", f"{key} : autre variante du fichier ({got['duration']} s contre {want['duration']} s)"))
    if fresh != ref:
        ref_path.write_text(json.dumps(fresh, ensure_ascii=False, indent=1), encoding="utf-8")
    return out
