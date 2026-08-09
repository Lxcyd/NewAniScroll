"""Unattended runner for batch_detect: restarts it until the list is done.

Written after an audit lot froze overnight on an unbounded ffmpeg read. The
per-call timeouts in oped/audio.py fix that specific hang; this is the layer
that assumes something ELSE will hang anyway — a wedged node bridge, a DNS
black hole, an OOM, a Python-level deadlock the timeouts cannot see.

Two independent stop conditions, because they catch different failures:
  - the child EXITS (crash, unhandled exception)  -> restart, resume
  - the child LIVES but writes nothing for STALL  -> kill the whole tree,
    restart, resume

`--resume` makes a restart nearly free: batch_detect skips every anime already
in the manifest, so the only work lost is the anime in flight.

Progress is judged on the manifest AND the results file, never on the child's
liveness: the frozen lot had three live ffmpeg processes and a live parent, and
was producing nothing. Liveness is not progress.

Usage:  python _supervise.py <anime-list.json> <tag> [stall_minutes]
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
LIST = sys.argv[1] if len(sys.argv) > 1 else "datasets/anime.hard.json"
TAG = sys.argv[2] if len(sys.argv) > 2 else "hard"
STALL_S = float(sys.argv[3]) * 60 if len(sys.argv) > 3 else 25 * 60

OUT = HERE / "out" / f"{TAG}.jsonl"
MANIFEST = HERE / "out" / f"{TAG}.manifest.jsonl"
CHILD_LOG = HERE / "out" / f"{TAG}.child.log"
SUP_LOG = HERE / "out" / f"{TAG}.supervisor.log"

MAX_RESTARTS = 60
POLL_S = 30


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(SUP_LOG, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def total_anime() -> int:
    return len(json.loads(Path(HERE / LIST).read_text("utf-8")))


def done_anime() -> int:
    if not MANIFEST.exists():
        return 0
    with open(MANIFEST, encoding="utf-8") as fh:
        return sum(1 for ln in fh if ln.strip())


def progress_stamp() -> tuple[int, int]:
    """Bytes written so far. Any change means the run is alive AND useful."""
    a = OUT.stat().st_size if OUT.exists() else 0
    b = MANIFEST.stat().st_size if MANIFEST.exists() else 0
    return a, b


def kill_tree(proc: subprocess.Popen) -> None:
    """Kill the child and everything it spawned (ffmpeg/ffprobe/node).

    /T is the point: killing only the Python parent leaves ffmpeg holding the
    sockets, and the next attempt then competes with its own zombies.
    """
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            capture_output=True, timeout=60,
        )
    except Exception as exc:  # noqa: BLE001 - last-resort cleanup
        log(f"taskkill a echoue ({exc}) — fallback proc.kill()")
        try:
            proc.kill()
        except Exception:
            pass
    # Sweep any decoder orphaned by an earlier hard kill.
    for name in ("ffmpeg.exe", "ffprobe.exe"):
        subprocess.run(["taskkill", "/F", "/IM", name], capture_output=True)


def main() -> int:
    total = total_anime()
    log(f"=== superviseur demarre : {LIST} ({total} anime), tag={TAG}, "
        f"seuil de gel={STALL_S / 60:.0f} min ===")

    for attempt in range(1, MAX_RESTARTS + 1):
        done = done_anime()
        if done >= total:
            log(f"TERMINE : {done}/{total} anime traites")
            return 0

        log(f"--- lancement #{attempt} (deja fait : {done}/{total}) ---")
        cmd = [
            sys.executable, "batch_detect.py",
            "--anime-list", LIST,
            "--out", str(OUT),
            "--manifest", str(MANIFEST),
            "--multi-host", "--resume",
        ]
        with open(CHILD_LOG, "a", encoding="utf-8") as child_log:
            child_log.write(f"\n===== lancement #{attempt} "
                            f"{time.strftime('%H:%M:%S')} =====\n")
            child_log.flush()
            proc = subprocess.Popen(
                cmd, cwd=HERE, stdout=child_log, stderr=subprocess.STDOUT,
                # Unbuffered child so its log is readable while it runs; a
                # buffered log is indistinguishable from a hung one.
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )

            last = progress_stamp()
            last_change = time.time()
            while proc.poll() is None:
                time.sleep(POLL_S)
                now = progress_stamp()
                if now != last:
                    last, last_change = now, time.time()
                    continue
                idle = time.time() - last_change
                if idle >= STALL_S:
                    log(f"GEL DETECTE : rien ecrit depuis {idle / 60:.1f} min "
                        f"— on tue l'arbre de processus et on reprend")
                    kill_tree(proc)
                    break

        rc = proc.poll()
        if rc == 0 and done_anime() >= total:
            log(f"TERMINE : {done_anime()}/{total} anime traites")
            return 0
        if rc == 2:
            # `batch_detect` sort 2 quand il s'est arrêté lui-même parce que la
            # MACHINE s'éteignait (oped.errors.ProcessKilled). Relancer serait
            # absurde — le lancement suivant mourrait pareil — et surtout ça
            # consommerait le budget de relances qui doit rester disponible
            # pour les vraies pannes transitoires. Le manifeste n'a rien
            # marqué : au prochain démarrage, le resume reprend proprement.
            log("ARRET : le lot s'est interrompu, la machine s'eteignait. "
                "Aucune relance (ce serait perdre le budget de relances).")
            return 2
        log(f"fin du lancement #{attempt} (rc={rc}) — "
            f"{done_anime()}/{total} anime, reprise dans 20 s")
        time.sleep(20)

    log(f"ABANDON apres {MAX_RESTARTS} relances — {done_anime()}/{total}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
