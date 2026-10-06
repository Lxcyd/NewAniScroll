"""Range sous la bonne fiche les episodes qu'anime-sama numerote d'un seul tenant.

    python -m eval.renumerote            # montre ce qui serait ecrit
    python -m eval.renumerote --write    # ajoute les lignes dans out/catalogue/<cible>.jsonl

Regles : renumerotation.json. Ajout seul, comme le lot : la ligne source reste,
la cible recoit une copie avec `mal_id` et `episode` corriges et `renumerote_de`
pour la trace. A lancer quand le lot a FINI la fiche source (sinon les episodes
pas encore faits manquent ; relancer plus tard ne duplique rien d'utile, la
derniere ligne d'un episode fait foi).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import lot

HERE = Path(__file__).resolve().parent.parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out/catalogue")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    base = Path(a.out)
    rules = json.loads((HERE / "renumerotation.json").read_text(encoding="utf-8"))["regles"]
    for r in rules:
        src = lot.read_anime(base / f"{r['source_mal']}.jsonl")
        src.pop("sans_reference", None)
        dst_path = base / f"{r['cible_mal']}.jsonl"
        have = lot.read_anime(dst_path) if dst_path.exists() else {}
        n = 0
        for (ep, lang), rec in sorted(src.items(), key=lambda kv: (kv[0][1], kv[0][0])):
            if not r["de"] <= ep <= r["a"]:
                continue
            new_ep = ep - r["decalage"]
            old = have.get((new_ep, lang))
            if old and (old.get("renumerote_de") or {}).get("ligne_at") == rec.get("at"):
                continue
            out = dict(rec, mal_id=r["cible_mal"], episode=new_ep,
                       renumerote_de={"mal_id": r["source_mal"], "episode": ep, "ligne_at": rec.get("at")})
            if a.write:
                lot.append(dst_path, out)
            n += 1
        print(f"{r['titre']} : {n} episodes-langues {'ecrits' if a.write else 'a ecrire'} "
              f"({r['source_mal']} ep {r['de']}-{r['a']} -> {r['cible_mal']} ep 1-{r['a'] - r['decalage']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
