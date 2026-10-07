"""Lecteurs du detecteur, lus dans lib/lecteurs.json (seule source de verite).

Aucune liste de lecteurs ne s'ecrit a la main dans le detecteur : sibnet et
uqload ont tourne des jours au lot apres que Luc les a dits morts / retires,
parce que la decision vivait dans une conversation et quatre listes en dur
ne la voyaient pas (07/10/2026).
"""
from __future__ import annotations

import json
from pathlib import Path

REGISTRE = Path(__file__).resolve().parents[2] / "lib" / "lecteurs.json"


def tous() -> dict[str, dict]:
    return json.loads(REGISTRE.read_text(encoding="utf-8"))["lecteurs"]


def du_lot() -> list[str]:
    """Lecteurs que le detecteur utilise, dans l'ordre de guidage."""
    return [h for h, d in tous().items() if d.get("lot") and d.get("etat") == "actif"]


def interdits(hosts) -> list[str]:
    """Ceux de `hosts` que le registre n'autorise pas au lot (avec la raison)."""
    reg = tous()
    autorises = set(du_lot())
    out = []
    for h in hosts:
        if h not in autorises:
            d = reg.get(h)
            out.append(f"{h} ({d['etat']} depuis {d.get('depuis', '?')} : {d.get('raison', '')})" if d
                       else f"{h} (absent de lib/lecteurs.json)")
    return out
