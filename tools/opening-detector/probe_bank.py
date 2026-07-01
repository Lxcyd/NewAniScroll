"""Probe: fetch SnK ep1-6 from a SINGLE host (embed4me), build the series bank,
and list every repeated segment per episode with corroboration — to decide
whether the ep1 sung ED recurs (bank handles it) or is unique (needs fallback).
"""
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
from concurrent.futures import ThreadPoolExecutor

from oped.adapter_aniscroll import resolve_episodes
from oped.audio import load_audio
from oped.fingerprint import fingerprint
from oped.matcher import SeriesBank

SLUG, SEASON, LANG = "shingeki-no-kyojin", "saison1", "vostfr"
HOST = "embed4me"  # homogeneous cut for the whole range


def clk(s):
    return f"{int(s)//60}:{int(s)%60:02d}"


def main():
    eps = resolve_episodes(SLUG, SEASON, LANG, 1, 6, host_pref=HOST)
    eps.sort(key=lambda e: e["ep"])
    print(f"resolved {len(eps)} eps from host={eps[0].get('host')}")

    def one(e):
        key = f"{SLUG}/{SEASON}/{LANG}/{e.get('host','x')}/ep{e['ep']}"
        s = load_audio(e["url"], cache_key=key)
        return e["ep"], fingerprint(s), len(s) / 11025

    res = {}
    with ThreadPoolExecutor(max_workers=8) as p:
        for ep, fp, dur in p.map(one, eps):
            res[ep] = (fp, dur)
            print(f"  fp ep{ep}: {dur/60:.1f} min")

    fps = [res[e["ep"]][0] for e in eps]
    bank = SeriesBank(fps)
    bank.build()

    print("\nRepeated segments per episode (corrob = how many other eps share it):")
    for i, e in enumerate(eps):
        print(f"ep{e['ep']}:")
        for s in sorted(bank.segments[i], key=lambda x: x.start):
            corr = sorted(eps[j]["ep"] for j in s.corroborating)
            print(f"   {clk(s.start)}-{clk(s.end)} ({int(s.duration)}s) "
                  f"votes={s.votes} corrob_eps={corr}")


if __name__ == "__main__":
    main()
