"""Emet UNE ligne par cellule (episode, langue) des qu'elle tombe dans le JSONL.

    python scratch/_watch_cells.py out/cyberpunk.jsonl 20

Sert de flux d'evenements a un Monitor : chaque ligne imprimee devient une
notification. On resume ce qui compte vraiment par lecteur — trouve/pas trouve,
et si l'IMAGE a confirme — plutot que le seul compteur d'avancement, qui ne dit
pas si ce qui tombe est bon.
"""
import json
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

path = Path(sys.argv[1])
total = int(sys.argv[2]) if len(sys.argv) > 2 else 0
STALL_TICKS = 45          # 45 x 20 s = 15 min sans rien

MARK = {"ok": "+", "rejected": "!", "absent": "?"}


def summary(row: dict) -> str:
    """Un mot par lecteur : OP/ED trouves, et le verdict de l'image."""
    out = []
    for host, entry in sorted((row.get("per_host") or {}).items()):
        if not isinstance(entry, dict):
            continue
        bits = []
        for kind in ("op", "ed"):
            h = entry.get(kind)
            if isinstance(h, dict) and isinstance(h.get("start"), (int, float)):
                # `+` image confirme, `!` image REFUSE (preuve contre), `?` rien vu.
                bits.append(kind.upper() + MARK.get(h.get("align_status"), ""))
            else:
                bits.append(kind + ":--")
        out.append(f"{host}[{' '.join(bits)}]")
    return "  ".join(out) or "aucun lecteur"


seen = 0
stale = 0
while True:
    lines = path.read_text("utf-8").splitlines() if path.exists() else []
    if len(lines) > seen:
        stale = 0
        for raw in lines[seen:]:
            if not raw.strip():
                continue
            r = json.loads(raw)
            print(f"ep{r['episode']:>2} {r['lang']:<6} ({len(lines)}/{total})  {summary(r)}")
        seen = len(lines)
    else:
        stale += 1
    if total and seen >= total:
        print(f"TERMINE — {seen}/{total} cellules")
        break
    # Le silence n'est pas un succes : un lot mort ressemble a un lot lent.
    if stale >= STALL_TICKS:
        print(f"BLOQUE — rien depuis 15 min ({seen}/{total})")
        break
    time.sleep(20)
