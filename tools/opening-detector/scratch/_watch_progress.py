"""Avancement d'un lot EN COURS, lu dans le cache — pas dans le JSONL.

    python scratch/_watch_progress.py cyberpunk-edgerunners out/cyberpunk.jsonl 20

`batch_detect` n'ecrit le JSONL qu'a la FIN de l'anime : le surveiller donne 0
jusqu'au bout, puis 20 d'un coup. Une sonde branchee dessus crie « bloque »
pendant que le lot travaille normalement — c'est arrive deux fois.

Le signal honnete est le cache par fenetre : `cache/audio/absa__<slug>__<saison>__
<lang>__ep<N>__<host>…`. Chaque nouveau couple (lang, ep) qui apparait est une
unite reellement traitee.
"""
import re
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

slug = sys.argv[1]
out = Path(sys.argv[2])
total = int(sys.argv[3]) if len(sys.argv) > 3 else 0
CACHE = Path("cache/audio")
STALL_TICKS = 30          # 30 x 20 s = 10 min sans AUCUN fichier neuf

pat = re.compile(rf"absa__{re.escape(slug)}__[^_]+__(\w+?)__ep(\d+)__([\w-]+)\.")

seen: set[tuple[str, int]] = set()
hosts: dict[tuple[str, int], set[str]] = {}
stale = 0
while True:
    fresh = False
    for f in CACHE.glob(f"absa__{slug}__*"):
        m = pat.match(f.name)
        if not m:
            continue
        lang, ep, host = m.group(1), int(m.group(2)), m.group(3)
        key = (lang, ep)
        hosts.setdefault(key, set())
        if host not in hosts[key]:
            hosts[key].add(host)
            fresh = True
        if key not in seen and len(hosts[key]) >= 2:
            seen.add(key)
            print(f"ep{ep:>2} {lang:<6} traite — lecteurs: {', '.join(sorted(hosts[key]))}"
                  f"   ({len(seen)} unites vues)")
    stale = 0 if fresh else stale + 1

    if out.exists() and out.stat().st_size > 0:
        n = len([l for l in out.read_text('utf-8').splitlines() if l.strip()])
        if not total or n >= total:
            print(f"JSONL ECRIT — {n} cellules, lot termine")
            break

    # Le silence n'est pas un succes, mais ici il se mesure sur le CACHE.
    if stale >= STALL_TICKS:
        print(f"BLOQUE — aucun fichier de cache neuf depuis 10 min ({len(seen)} unites)")
        break
    time.sleep(20)
