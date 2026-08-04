"""Intra-season consistency — the check no cross-host agreement can give.

Every host of one episode runs the SAME reference through the SAME matcher, so
when they agree they may simply be reproducing the same mistake. The season is
the independent axis: an OP lands at the same place, with the same length,
episode after episode. A single episode that disagrees with its whole season is
almost certainly a false positive; an episode with no hit at all, surrounded by a
season that agrees, can be filled in.

    python season_pass.py --in results.jsonl --out results.checked.jsonl
    python season_pass.py --in results.jsonl --out out.jsonl --report

Two things it does, per (mal_id, lang, host, kind):

  1. FLAG (P5) — an interval that sits far from every consistent cluster of the
     season gets `season_outlier` in its `anomalies` and stops being served.
  2. FILL (F7) — an episode missing a kind that the rest of the season agrees on
     gets a `predicted` interval, marked as such.

Why CLUSTERS and not a median
-----------------------------
An OP's position is legitimately MULTI-MODAL. Some episodes open cold (OP at
~1:30), others start on the OP (~0:00), and the same season mixes both. A median
would sit between the two modes and flag half the season. So we cluster the
season's values and accept ANY cluster with real support; an episode is only an
outlier when it matches NONE of them.

Episode 1 is exempt from both, and so is the last episode
-------------------------------------------------------
First episodes routinely place the OP minutes in — after a long cold open, a
prologue, sometimes an entire act — or have no OP at all; finales often drop the
OP, run the ED early, or play it over the last scene. Both are NORMAL, and both
would be the first things a season-consistency rule would wrongly "correct". So
they never define a cluster, are never flagged as outliers, and are never filled
by prediction. (`--strict-first` opts into flagging them anyway, for
investigation.)

What it never does: move a timestamp. A hit is either kept as detected, flagged,
or (when absent) predicted and labelled `predicted` — never silently adjusted.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# The reason string this pass raises. Listed in validate.BLOCKING, which is what
# makes it hold a hit back everywhere else in the pipeline.
SEASON_OUTLIER = "season_outlier"

# Two episodes whose anchors differ by less than this belong to the same
# "position mode". Wide enough to absorb per-episode cold-open jitter, narrow
# enough that a genuinely different placement (a mid-episode false match) forms
# its own cluster.
CLUSTER_TOLERANCE_S = 12.0

# Episodes a cluster needs before it counts as a real habit of the season rather
# than a repeated accident. Also expressed as a share, for long seasons.
MIN_CLUSTER_EPISODES = 2
MIN_CLUSTER_SHARE = 0.15

# A season needs this many usable episodes before any of this means anything.
MIN_SEASON_EPISODES = 4

# Interval LENGTH consistency: the same OP is the same length everywhere. A
# deviation past this from the season's median length means one edge was
# mis-bounded even if the position looks right.
LENGTH_TOLERANCE_S = 8.0

# Prediction (F7) is deliberately harder to earn than flagging: filling an
# episode invents a skip the detector never saw, so the season must be strongly
# and tightly in agreement first.
PREDICT_MIN_SHARE = 0.7
PREDICT_MAX_SPREAD_S = 4.0


def _anchor(entry: dict, kind: str) -> float | None:
    """The duration-independent position of a hit within its episode.

    ED → seconds from the END (encodes differ in length; this is what
    multi_host reconciles on too). OP → absolute start.
    """
    if not entry:
        return None
    if kind == "ed":
        fe = entry.get("from_end_start")
        if fe is not None:
            return float(fe)
        dur = entry.get("duration")
        if dur:
            return float(dur) - float(entry["start"])
        return None
    return float(entry["start"])


def _clusters(values: list[float], tol: float) -> list[tuple[float, int]]:
    """Greedy 1-D clustering. Returns [(center, size), …], largest first."""
    out: list[tuple[float, int]] = []
    for v in sorted(values):
        for i, (c, n) in enumerate(out):
            if abs(v - c) <= tol:
                out[i] = ((c * n + v) / (n + 1), n + 1)
                break
        else:
            out.append((v, 1))
    out.sort(key=lambda cn: cn[1], reverse=True)
    return out


def _exempt(ep: int, episodes: list[int]) -> bool:
    """Episodes whose OP/ED placement is legitimately unlike the season's.

    The first episode very often carries a long prologue before the OP (or no OP
    at all) and the last often drops or displaces it. Treating either as an
    outlier is how a season-consistency rule breaks correct data.
    """
    return bool(episodes) and ep in (episodes[0], episodes[-1])


def analyse_group(rows: dict[int, dict], kind: str, *, strict_first: bool = False):
    """Consistency verdict for ONE (host, kind) across a season.

    `rows` = {episode: per-host entry or None}. Returns
    (outliers, predictable, model) where `model` is (center, length, share) of
    the reference cluster, or None when the season can't support a verdict.
    """
    episodes = sorted(rows)
    if len(episodes) < MIN_SEASON_EPISODES:
        return set(), {}, None

    body = [e for e in episodes if strict_first or not _exempt(e, episodes)]
    anchors = {e: _anchor(rows[e], kind) for e in body}
    have = {e: a for e, a in anchors.items() if a is not None}
    if len(have) < MIN_CLUSTER_EPISODES:
        return set(), {}, None

    clusters = _clusters(list(have.values()), CLUSTER_TOLERANCE_S)
    floor = max(MIN_CLUSTER_EPISODES, round(MIN_CLUSTER_SHARE * len(body)))
    kept = [(c, n) for c, n in clusters if n >= floor]
    if not kept:
        # No habit at all — the season is too scattered to judge anything.
        # Staying silent is the honest outcome; flagging everything here would
        # punish a season we simply don't understand.
        return set(), {}, None

    lengths = [
        float(rows[e]["end"]) - float(rows[e]["start"]) for e in have
    ]
    med_len = statistics.median(lengths)

    outliers = set()
    for e, a in have.items():
        if not any(abs(a - c) <= CLUSTER_TOLERANCE_S for c, _n in kept):
            outliers.add(e)
            continue
        length = float(rows[e]["end"]) - float(rows[e]["start"])
        if abs(length - med_len) > LENGTH_TOLERANCE_S:
            outliers.add(e)

    # Prediction model: the dominant cluster, if it is dominant enough.
    center, size = kept[0]
    share = size / len(body)
    members = [a for a in have.values() if abs(a - center) <= CLUSTER_TOLERANCE_S]
    spread = (max(members) - min(members)) if len(members) > 1 else 0.0
    model = None
    if share >= PREDICT_MIN_SHARE and spread <= PREDICT_MAX_SPREAD_S:
        model = (center, med_len, share)

    predictable = {}
    if model is not None:
        for e in body:
            if anchors.get(e) is None:
                predictable[e] = model
    return outliers, predictable, model


def _predicted_entry(kind: str, model, duration: float) -> dict:
    """A filled-in interval, explicitly labelled as never having been detected."""
    center, length, share = model
    if kind == "ed":
        start = max(0.0, duration - center)
    else:
        start = center
    return {
        "start": round(start, 2),
        "end": round(min(duration, start + length), 2) if duration else round(start + length, 2),
        "duration": round(duration, 2),
        "kind": kind,
        "slug": "PREDICTED",
        "source": "predicted",
        "votes": 0,
        "predicted": True,
        "season_share": round(share, 3),
        # Served: the season agreed strongly enough (PREDICT_MIN_SHARE /
        # PREDICT_MAX_SPREAD_S) that this position is the season's habit. It is
        # labelled `predicted` so a consumer can rank it below detected rows.
        "serve": True,
        **({"from_end_start": round(center, 2),
            "from_end_end": round(max(0.0, center - length), 2)} if kind == "ed" else {}),
    }


def run(rows: list[dict], *, strict_first: bool = False, predict: bool = True,
        log=print) -> tuple[list[dict], dict]:
    """Apply the season checks to a whole JSONL result set. Returns (rows, stats)."""
    by_group: dict[tuple, dict[int, dict]] = defaultdict(dict)
    index: dict[tuple, dict] = {}
    for r in rows:
        key = (r.get("mal_id"), r.get("lang"))
        index[(key, r.get("episode"))] = r
        for host, entry in (r.get("per_host") or {}).items():
            for kind in ("op", "ed"):
                by_group[(key, host, kind)][r["episode"]] = entry.get(kind)

    stats = {"outliers": 0, "predicted": 0, "groups": 0}
    for (key, host, kind), per_ep in by_group.items():
        outliers, predictable, model = analyse_group(
            per_ep, kind, strict_first=strict_first
        )
        stats["groups"] += 1
        for ep in outliers:
            entry = index[(key, ep)]["per_host"][host][kind]
            anomalies = list(entry.get("anomalies") or [])
            if SEASON_OUTLIER not in anomalies:
                anomalies.append(SEASON_OUTLIER)
            entry["anomalies"] = anomalies
            entry["serve"] = False
            entry["held_reason"] = "inconsistent with the rest of the season"
            stats["outliers"] += 1
            log(f"  [outlier] mal={key[0]} {key[1]} {host} {kind} ep{ep}: "
                f"{entry['start']:.1f}-{entry['end']:.1f}")
        # A self-derived hit is held by default; the season is exactly the
        # confirmation it was waiting for (multi_host.DERIVED_REQUIRES_SEASON).
        if model is not None:
            for ep, entry in per_ep.items():
                if entry and entry.get("derived") and ep not in outliers:
                    entry["serve"] = True
                    entry.pop("held_reason", None)
        if not predict:
            continue
        for ep, mdl in predictable.items():
            row = index.get((key, ep))
            if row is None:
                continue
            host_entry = (row.get("per_host") or {}).get(host)
            if host_entry is None or host_entry.get(kind) is not None:
                continue
            host_entry[kind] = _predicted_entry(
                kind, mdl, float(host_entry.get("duration") or 0.0)
            )
            stats["predicted"] += 1

    return rows, stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--in", dest="src", required=True, help="detector JSONL")
    ap.add_argument("--out", dest="dst", required=True, help="checked JSONL")
    ap.add_argument("--no-predict", action="store_true",
                    help="only flag outliers, never fill missing episodes (F7 off)")
    ap.add_argument("--strict-first", action="store_true",
                    help="also judge the first/last episode (normally exempt: a "
                         "late or absent OP there is normal, not an anomaly)")
    ap.add_argument("--report", action="store_true", help="print every verdict")
    args = ap.parse_args()

    rows = [json.loads(l) for l in Path(args.src).read_text("utf-8").splitlines() if l.strip()]
    log = print if args.report else (lambda *a, **k: None)
    rows, stats = run(rows, strict_first=args.strict_first,
                      predict=not args.no_predict, log=log)
    Path(args.dst).write_text(
        "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
    )
    print(f"{len(rows)} rows · {stats['groups']} (host,kind) groups · "
          f"{stats['outliers']} flagged season_outlier · "
          f"{stats['predicted']} predicted")


if __name__ == "__main__":
    main()
