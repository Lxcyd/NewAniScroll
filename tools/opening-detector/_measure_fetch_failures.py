"""Taux d'échec de RÉCUPÉRATION du flux, hôte par hôte (point 2b).

POURQUOI CE DÉTOUR. La bonne façon de mesurer serait de lire `detect_error`,
posé le 07/08 dans `oped/multi_host.py` : jusque-là les deux `except Exception:
hits = []` jetaient l'exception sans rien écrire, donc une panne de transport et
un épisode réellement sans générique produisaient le MÊME objet — une liste
vide. Aucun run passé ne porte donc l'information. En attendant un run
instrumenté, on l'approche par l'absence de fenêtre audio en cache : un hôte
présent dans `per_host` a été TENTÉ ; s'il n'a laissé aucune fenêtre, la
récupération a échoué.

C'est une approximation, et elle se trompe dans un sens connu : un hôte peut
avoir été servi depuis un cache purgé depuis. Elle sous-estime donc jamais
l'échec, elle le SURESTIME. À lire comme une borne haute.

DEUX PIÈGES, tous deux rencontrés le 07/08 et payés cher :
  1. Le glob doit être ancré sur la frontière `__`. Un `absa__*__ep{N}__{host}`
     sans slug exact attrape n'importe quel anime ayant ce numéro d'épisode —
     c'est ce qui avait produit le chiffre bidon « 45 sur 50 ».
  2. Une cellule est rejouée par plusieurs lots. Il faut garder la ligne du lot
     le PLUS RÉCENT (mtime), pas le premier par ordre alphabétique : `audit.jsonl`
     précède `audit6.jsonl`, et j'ai ainsi diagnostiqué pendant une heure une
     cellule déjà réparée.

Le script se VALIDE sur un cas dont la réponse est connue avant d'imprimer quoi
que ce soit (voir CONTROLE).

Usage : python tools/opening-detector/_measure_fetch_failures.py
"""
from __future__ import annotations

import glob
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache/audio"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def slug_map() -> dict[int, str]:
    """mal_id -> slug, lu depuis les listes d'entrée (les lignes n'ont pas le slug)."""
    out: dict[int, str] = {}
    for p in ROOT.glob("anime*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for a in data:
            if isinstance(a, dict) and a.get("mal_id") and a.get("slug"):
                out.setdefault(int(a["mal_id"]), a["slug"])
    return out


def latest_rows() -> dict[tuple, dict]:
    """La ligne la plus RÉCENTE par cellule (mal_id, ep, lang) — cf. piège 2."""
    rows: dict[tuple, dict] = {}
    files = sorted(ROOT.glob("out/*.jsonl"), key=lambda p: p.stat().st_mtime)
    for p in files:                      # du plus ancien au plus récent
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if "per_host" not in r:
                continue
            rows[(r["mal_id"], r["episode"], r["lang"])] = r  # le récent écrase
    return rows


def has_window(slug: str, lang: str, ep: int, host: str) -> bool:
    """Une fenêtre audio a-t-elle été obtenue pour CE couple exact ?"""
    # Slug ancré entre `absa__` et `__` : `charlotte` ne peut pas attraper
    # `charlotte-2`, et aucun autre anime ne peut entrer par le numéro d'épisode.
    pat = f"absa__{glob.escape(slug)}__*__{lang}__ep{ep}__{host}.*.fp.npz"
    return any(CACHE.glob(pat))


def main() -> int:
    slugs = slug_map()
    rows = latest_rows()

    # --- CONTROLE : le script doit retrouver un fait déjà établi ------------
    # Charlotte ep2 vostfr / vidmoly-va est la cellule REPAREE par le lot du
    # 06/08 : `op: None` dans audit..audit5, puis OP1 a 32.21 dans audit7, avec
    # ses fenetres en cache. Ce temoin teste les DEUX pieges d'un coup :
    #   - si le glob est casse, la fenetre n'est pas trouvee ;
    #   - si le tri rend la ligne la plus ancienne, l'OP ressort a None.
    # (Premiere ecriture de ce controle : j'y avais encode la croyance d'AVANT
    #  la correction — « vidmoly-va n'a pas de fenetre ». Il a refuse de
    #  publier, ce qui est exactement son travail.)
    checks = []
    ch = next((r for (m, e, l), r in rows.items()
               if slugs.get(m) == "charlotte" and e == 2 and l == "vostfr"), None)
    if ch is None:
        checks.append("cellule temoin charlotte ep2 vostfr introuvable")
    else:
        if not has_window("charlotte", "vostfr", 2, "vidmoly-va"):
            checks.append("charlotte ep2 : fenetre vidmoly-va introuvable — le "
                          "glob est casse")
        op = (ch["per_host"].get("vidmoly-va") or {}).get("op")
        if not op or abs(op.get("start", 0) - 32.21) > 1.0:
            checks.append(f"charlotte ep2 : OP vidmoly-va = {op and op.get('start')}, "
                          "attendu ~32.21 — le tri ne rend pas le lot le plus recent")
    if checks:
        print("CONTROLE ECHOUE — la mesure n'est pas publiee :")
        for c in checks:
            print(f"  - {c}")
        return 1
    print("controle ok (charlotte ep2 vostfr se comporte comme etabli le 07/08)\n")

    # --- Mesure -------------------------------------------------------------
    attempted: dict[str, int] = defaultdict(int)
    missing: dict[str, int] = defaultdict(int)
    skipped_no_slug = 0

    for (mal_id, ep, lang), r in rows.items():
        slug = slugs.get(mal_id)
        if not slug:
            skipped_no_slug += 1
            continue
        for host in r["per_host"]:
            attempted[host] += 1
            if not has_window(slug, lang, ep, host):
                missing[host] += 1

    print(f"{len(rows)} cellules a jour, {skipped_no_slug} sans slug connu (ignorees)\n")
    hdr = f"{'hote':<14}{'tente':>8}{'sans fenetre':>15}{'taux':>9}"
    print(hdr)
    print("-" * len(hdr))
    tot_a = tot_m = 0
    for host in sorted(attempted, key=lambda h: -(missing[h] / max(attempted[h], 1))):
        a, m = attempted[host], missing[host]
        tot_a += a
        tot_m += m
        print(f"{host:<14}{a:>8}{m:>15}{m / a:>8.1%}")
    print("-" * len(hdr))
    print(f"{'TOTAL':<14}{tot_a:>8}{tot_m:>15}{tot_m / max(tot_a, 1):>8.1%}")
    print("\nBorne HAUTE : un cache purge compte ici comme un echec.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
