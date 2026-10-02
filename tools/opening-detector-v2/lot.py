"""Lot CATALOGUE : tout le catalogue, sur des semaines, sans rien pouvoir perdre.

    python lot.py --anime-list out/catalogue.json --out out/catalogue [--limit 20]

Lance par le superviseur lot.ps1, qui le relance s'il tombe. Ce que ce fichier
garantit (plan du 03/10/2026) :

- UN FICHIER PAR ANIME (out/catalogue/<mal>.jsonl), en ajout seul : une ligne
  par episode-langue ; une reprise ajoute une ligne, la derniere fait foi.
  Rien ici ne supprime un resultat.
- Reprise : relancer la meme commande. Sont faits les episodes absents ; les
  lecteurs restes en panne sont repris en fin d'anime et avec --retry-errors.
- Le son de chaque candidat est archive (archive.py) et les bornes sont
  calculees dessus : toute regle se rejoue hors ligne (eval/replay.py).
- Les telechargements sont supprimes des qu'un lecteur-episode est ecrit.
- Une panne n'est jamais une absence : `detect_error`, essais repetes (cf.
  ATTEMPTS), reprise en fin d'anime et avec --retry-errors.
- Un lecteur en panne 10 episodes d'affilee est mis en pause (30 min, 1 h,
  2 h), jamais exclu ; les autres continuent.
- Sentinelles et temoins (eval/sentinels.py) : sortie en pause, code 3.
- Etat lisible a tout instant : out/catalogue.status.json et .txt.
- Aucun appel a aniscroll.com ; le Worker Cloudflare est contourne
  (bridge/resolve.mjs, OPED_DIRECT), plafond quotidien si repli.

Codes de sortie : 0 fini, 2 arret demande (fichier .stop, --max-minutes),
3 pause sur sentinelle (ne pas relancer sans regarder), autre : plantage.
"""
from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import faulthandler
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.chdir(HERE)  # tous les caches sont relatifs au dossier du detecteur

# Avant d'importer la couche de telechargement : elle lit ces variables a
# l'import. Temporaires sur D: (13 To de passage, pas sur le SSD), repli C:.
TMP_ROOT = Path(os.environ.get("OPED_TMP", r"D:\oped-tmp"))
if "OPED_HLS_CACHE" not in os.environ:
    try:
        (TMP_ROOT / "hls").mkdir(parents=True, exist_ok=True)
        os.environ["OPED_HLS_CACHE"] = str(TMP_ROOT / "hls")
    except OSError:
        pass
os.environ.setdefault("OPED_DIRECT", "1")
# Plafond de debit, en Mo/s, modifiable pendant que le lot tourne : ecrire un
# nombre dans out/debit.txt (vide ou absent : pas de plafond). Relu toutes les 30 s.
os.environ.setdefault("OPED_RATE_FILE", str(HERE / "out" / "debit.txt"))

import archive  # noqa: E402
import run  # noqa: E402
from eval import sentinels  # noqa: E402
from fetch import hls_cache, stats  # noqa: E402
from fetch.adapter_aniscroll import MULTI_HOSTS, resolve_episodes_multi  # noqa: E402
from fetch.episode import CACHE as EP_CACHE  # noqa: E402
from fetch.errors import ProcessKilled  # noqa: E402
from refs import animethemes  # noqa: E402
from refs.bank import load as load_refs  # noqa: E402

# Essais d'un lecteur en panne : 2 sur le champ (15 s d'ecart), puis 2 passes
# de reprise en fin d'anime, a 2 essais chacune — 6 au plus, etales dans le
# temps. Mesure du 02/10/2026 (Railgun S, ansembed en 504) : attendre 60 puis
# 180 s DANS l'episode tenait un des 3 fils du lot et divisait le debit par
# trois, pour une panne que la reprise, quelques minutes plus tard, regle mieux.
ATTEMPTS = 2
WAITS_S = (15,)
RETRY_PASSES = 2
HOST_TIMEOUT_S = 900          # plafond d'un lecteur-episode, tous essais ffmpeg compris
BREAKER_FAILS = 10
BREAKER_PAUSE_S = (1800, 3600, 7200)
MIN_FREE_BYTES = 10 * 1024 ** 3
WORKER_DAILY_CAP = 5000
CANARY_EVERY_S = 2 * 3600
BACKUPS = [Path(p) for p in os.environ.get("OPED_BACKUPS", r"D:\oped-backup;H:\oped-backup").split(";") if p]

_io = threading.Lock()


def now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


LOG: Path | None = None


def log(msg: str) -> None:
    line = f"{now()} {msg}"
    print(line, flush=True)
    if LOG:
        try:
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass


# ── Fichiers par anime ───────────────────────────────────────────────────────

def read_anime(path: Path) -> dict:
    """{(episode, langue): derniere ligne}. Une ligne illisible (arret brutal en
    pleine ecriture) est ignoree : l'episode sera refait."""
    out: dict = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("sans_reference"):
            out["sans_reference"] = r
        elif "episode" in r:
            out[(r["episode"], r["lang"])] = r
    return out


def append(path: Path, rec: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with _io, open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + f".part{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    for _ in range(5):  # un lecteur de l'etat peut tenir le fichier une fraction de seconde
        try:
            tmp.replace(path)
            return
        except PermissionError:
            time.sleep(0.2)
    tmp.unlink(missing_ok=True)


def episodes_of(entry: dict) -> list[tuple[dict, int]]:
    out = []
    for season in entry["seasons"]:
        for ep in season.get("episodes") or range(season["ep_start"], season["ep_end"] + 1):
            out.append((season, ep))
    return out


def errors_of(rec: dict) -> list[str]:
    return [h for h, e in rec.get("per_host", {}).items() if "detect_error" in e]


def ledger_entry(entry: dict, recs: dict) -> dict:
    """Etat d'un anime, calcule depuis son fichier : jamais la seule trace."""
    title = entry.get("title") or entry["slug"]
    if "sans_reference" in recs:
        return {"mal_id": entry["mal_id"], "titre": title, "etat": "sans_reference", "le": recs["sans_reference"].get("at")}
    langs: dict = {}
    hosts: dict = {}
    versions, last = set(), None
    todo = episodes_of(entry)
    for season, ep in todo:
        lg = langs.setdefault(season["lang"], {"attendus": 0, "faits": 0, "a_reprendre": 0})
        lg["attendus"] += 1
        r = recs.get((ep, season["lang"]))
        if not r:
            continue
        lg["faits"] += 1
        lg["a_reprendre"] += bool(errors_of(r))
        last = max(last or "", r.get("at") or "")
        for h, e in r.get("per_host", {}).items():
            x = hosts.setdefault(h, {"ok": 0, "op": 0, "ed": 0, "pannes": 0, "absents": 0})
            if "detect_error" in e:
                x["pannes"] += 1
            else:
                x["ok"] += 1
                x["op"] += "op" in e
                x["ed"] += "ed" in e
                versions.add(e.get("algo_version"))
        for h in r.get("absent", {}):
            hosts.setdefault(h, {"ok": 0, "op": 0, "ed": 0, "pannes": 0, "absents": 0})["absents"] += 1
    done = sum(x["faits"] for x in langs.values())
    redo = sum(x["a_reprendre"] for x in langs.values())
    state = "partiel" if done < len(todo) else "a_reprendre" if redo else "fait"
    return {"mal_id": entry["mal_id"], "titre": title, "etat": state, "langues": langs, "lecteurs": hosts,
            "algo_versions": sorted(v for v in versions if v), "le": last}


def sha1(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def backup(files: list[tuple[Path, str]]) -> list[str]:
    """Copie (source, chemin relatif) vers chaque disque de sauvegarde, verifiee
    par somme de controle. Rend les problemes rencontres ; une sauvegarde qui
    echoue n'arrete pas le lot mais se voit dans l'etat."""
    problems = []
    for root in BACKUPS:
        if not Path(root.anchor).exists():
            problems.append(f"sauvegarde : {root.anchor} absent")
            continue
        for src, rel in files:
            if not src.exists():
                continue
            dst = root / rel
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                if dst.exists() and dst.stat().st_size == src.stat().st_size and rel.endswith(".npz"):
                    continue
                tmp = dst.with_name(dst.name + ".part")
                shutil.copyfile(src, tmp)
                if sha1(tmp) != sha1(src):
                    raise OSError("somme de controle differente")
                tmp.replace(dst)
            except OSError as exc:
                problems.append(f"sauvegarde {root}: {rel}: {exc}")
                break
    return problems


# ── Disjoncteur par lecteur ──────────────────────────────────────────────────

class Hosts:
    def __init__(self):
        self.lock = threading.Lock()
        self.streak: dict[str, int] = {}
        self.level: dict[str, int] = {}
        self.until: dict[str, float] = {}
        self.last_error: dict[str, str] = {}
        self.errors: dict[str, int] = {}

    def paused(self, host: str) -> bool:
        with self.lock:
            return time.time() < self.until.get(host, 0)

    def flaky(self, host: str) -> bool:
        """En panne plusieurs episodes d'affilee : inutile d'attendre 4 essais."""
        with self.lock:
            return self.streak.get(host, 0) >= 3

    def note(self, host: str, error: str | None) -> None:
        with self.lock:
            if error is None:
                self.streak[host] = 0
                self.level[host] = 0
                return
            self.errors[host] = self.errors.get(host, 0) + 1
            self.last_error[host] = error[:200]
            self.streak[host] = self.streak.get(host, 0) + 1
            if self.streak[host] >= BREAKER_FAILS:
                lvl = self.level.get(host, 0)
                pause = BREAKER_PAUSE_S[min(lvl, len(BREAKER_PAUSE_S) - 1)]
                self.until[host] = time.time() + pause
                self.level[host] = lvl + 1
                self.streak[host] = 0
                log(f"[pause] {host} : {BREAKER_FAILS} episodes d'affilee en panne, pause {pause // 60} min — {error[:120]}")

    def paused_view(self) -> dict:
        with self.lock:
            t = time.time()
            return {h: dt.datetime.fromtimestamp(u).isoformat(timespec="minutes")
                    for h, u in self.until.items() if u > t}


# ── Etat ─────────────────────────────────────────────────────────────────────

class Status:
    def __init__(self, base: Path, hosts: Hosts):
        self.base, self.hosts = base, hosts
        self.lock = threading.Lock()
        self.d = {"etat": "demarrage", "raison": None, "pid": os.getpid(), "demarre": now(),
                  "code": git_sha(), "algo_version": run.ALGO_VERSION, "alertes": [], "sauvegarde": []}
        self.t0 = time.time()
        self.done0 = 0
        self.net0 = stats.snapshot()

    def set(self, **kw) -> None:
        with self.lock:
            self.d.update(kw)
        self.write()

    def alert(self, msg: str) -> None:
        with self.lock:
            line = f"{now()} {msg}"
            self.d["alertes"] = (self.d["alertes"] + [line])[-30:]
        log(f"[alerte] {msg}")

    def write(self) -> None:
        with self.lock:
            d = dict(self.d)
        d["battement"] = now()
        d["lecteurs_en_pause"] = self.hosts.paused_view()
        d["pannes_par_lecteur"] = {h: {"n": n, "derniere": self.hosts.last_error.get(h)}
                                   for h, n in sorted(self.hosts.errors.items())}
        total, done = d.get("total_episodes") or 0, d.get("episodes_faits") or 0
        d["pct"] = round(100 * done / total, 2) if total else None
        hours = (time.time() - self.t0) / 3600
        rate = (done - self.done0) / hours if hours > 0.05 else None
        d["episodes_par_heure"] = round(rate, 1) if rate else None
        d["fin_estimee"] = (dt.datetime.now() + dt.timedelta(hours=(total - done) / rate)).isoformat(timespec="minutes") \
            if rate and total > done else None
        net = stats.since(self.net0)
        d["telecharge_go"] = round(net["octets"] / 1024 ** 3, 2)
        d["worker"] = worker_calls(self.base)
        d["disques_go_libres"] = {str(p): free_gb(p) for p in (HERE, TMP_ROOT, archive.ROOT)}
        with _io:
            write_atomic(self.base.with_name(self.base.name + ".status.json"),
                         json.dumps(d, ensure_ascii=False, indent=1))
            write_atomic(self.base.with_name(self.base.name + ".status.txt"), text_status(d))


def text_status(d: dict) -> str:
    L = [f"Lot catalogue OP/ED — {d.get('etat')}" + (f" ({d['raison']})" if d.get("raison") else ""),
         f"  maj {d.get('battement')}   demarre {d.get('demarre')}   code {d.get('code')}",
         f"  {d.get('pct')} % : {d.get('episodes_faits')} / {d.get('total_episodes')} episodes-langues"
         f"   animes {d.get('animes_faits')} / {d.get('total_animes')}"
         + (f"   palier : {d['palier']} premiers" if d.get("palier") else ""),
         f"  en cours : {d.get('anime_en_cours')}",
         f"  debit : {d.get('episodes_par_heure')} episodes/h   fin estimee : {d.get('fin_estimee')}",
         f"  generiques servis ce lancement : OP {d.get('op_servis')}  ED {d.get('ed_servis')}"
         f"   lecteurs-episodes traites : {d.get('lecteurs_faits')}   a reprendre : {d.get('a_reprendre')}",
         f"  telecharge ce lancement : {d.get('telecharge_go')} Go   appels Worker : {d.get('worker')}",
         f"  disques (Go libres) : {d.get('disques_go_libres')}"]
    for h, x in (d.get("pannes_par_lecteur") or {}).items():
        L.append(f"  pannes {h} : {x['n']} — {x['derniere']}")
    for h, u in (d.get("lecteurs_en_pause") or {}).items():
        L.append(f"  EN PAUSE {h} jusqu'a {u}")
    for p in d.get("sauvegarde") or []:
        L.append(f"  ! {p}")
    for a in (d.get("alertes") or [])[-8:]:
        L.append(f"  ! {a}")
    return "\n".join(L) + "\n"


def free_gb(p: Path) -> float | None:
    try:
        return round(shutil.disk_usage(p if p.exists() else Path(p.anchor)).free / 1024 ** 3, 1)
    except OSError:
        return None


def git_sha() -> str:
    try:
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=HERE).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "."], capture_output=True, text=True, cwd=HERE).stdout.strip()
        return sha + ("+modifie" if dirty else "")
    except OSError:
        return "?"


def worker_calls(base: Path) -> dict:
    path = base.with_name(base.name + ".worker.log")
    if not path.exists():
        return {"aujourd_hui": 0, "total": 0}
    lines = path.read_text(encoding="utf-8", errors="replace").split()
    today = dt.datetime.utcnow().date().isoformat()
    return {"aujourd_hui": sum(x.startswith(today) for x in lines), "total": len(lines)}


def pid_alive(pid: int) -> bool:
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not h:
        return False
    code = ctypes.c_ulong()
    ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(h)
    return code.value == 259


# ── Un episode ───────────────────────────────────────────────────────────────

def resolve(entry: dict, season: dict, ep: int, hosts: list[str], fresh: bool, failures: dict) -> list[dict]:
    tmp = tempfile.mkdtemp(prefix="urls-", dir="cache") if fresh else None
    try:
        return resolve_episodes_multi(
            entry["slug"], season["season_dir"], season["lang"], ep, ep, hosts=hosts,
            mal_id=entry["mal_id"], va_slug=season.get("va_slug") or entry.get("va_slug") or entry["slug"],
            frembed=season.get("frembed"), failures=failures,
            **({"cache_dir": tmp} if tmp else {})).get(ep, [])
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


# Ordre de passage des lecteurs d'un episode : le moins cher d'abord, il sert
# de GUIDE aux autres (run.plan_from). frembed a une piste son a part (~18 Mo
# par episode) ; megaplay et la famille Vidmoly portent la video avec.
GUIDE_ORDER = ["frembed", "megaplay", "sibnet", "uqload", "ansembed", "vidmoly-va"]


def detect(mal: int, lang: str, ep: int, stream: dict, refs, plan: dict | None = None) -> dict:
    try:
        return run.detect_host(mal, lang, ep, stream, refs, plan)
    except ProcessKilled:
        raise
    except Exception as exc:
        return {"detect_error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    finally:
        hls_cache.release(stream["url"])


class Lot:
    def __init__(self, a, base: Path, anime: list[dict]):
        self.a, self.base, self.anime = a, base, anime
        self.hosts = Hosts()
        self.status = Status(base, self.hosts)
        self.sent = sentinels.Sentinels(base.with_name(base.name + ".baseline.json"))
        self.stop = threading.Event()
        self.pause_reason: str | None = None
        self.counts = {"op": 0, "ed": 0, "hosts": 0}
        self.done = 0
        self.redo = 0
        self.deadline = time.time() + a.max_minutes * 60 if a.max_minutes else None
        self.run_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        self.code = self.status.d["code"]

    # -- gardes -------------------------------------------------------------
    def should_stop(self) -> bool:
        if self.stop.is_set():
            return True
        if self.base.with_name(self.base.name + ".stop").exists():
            self.stop_reason = "fichier .stop"
            self.stop.set()
        elif self.deadline and time.time() > self.deadline:
            self.stop_reason = "--max-minutes"
            self.stop.set()
        return self.stop.is_set()

    def wait_resources(self) -> None:
        """Archive debranchee ou disque plein : attendre, sans rien traiter."""
        while not self.should_stop():
            why = None if self.a.no_archive else archive.available()
            if not why:
                for p in (HERE, Path(os.environ.get("OPED_HLS_CACHE", "cache/hls"))):
                    free = shutil.disk_usage(p if p.exists() else HERE).free
                    if free < MIN_FREE_BYTES:
                        why = f"moins de 10 Go libres sur {Path(p).anchor}"
            if not why:
                if self.status.d.get("etat") == "attente":
                    self.status.set(etat="en_cours", raison=None)
                return
            if self.status.d.get("raison") != why:
                self.status.alert(f"en attente : {why}")
            self.status.set(etat="attente", raison=why)
            time.sleep(60)

    def worker_env(self) -> None:
        os.environ["OPED_WORKER_LOG"] = str(self.base.with_name(self.base.name + ".worker.log").resolve())
        os.environ["OPED_WORKER_OK"] = "1" if worker_calls(self.base)["aujourd_hui"] < WORKER_DAILY_CAP else "0"

    # -- un episode ---------------------------------------------------------
    def episode(self, entry: dict, season: dict, ep: int, prev: dict | None, refs) -> dict:
        mal, lang = entry["mal_id"], season["lang"]
        rec = {"mal_id": mal, "episode": ep, "lang": lang, "n_refs": len(refs),
               "per_host": dict((prev or {}).get("per_host", {})), "absent": dict((prev or {}).get("absent", {}))}
        pending = errors_of(prev) if prev else list(MULTI_HOSTS)
        for attempt in range(ATTEMPTS):
            self.worker_env()
            live = [h for h in pending if not self.hosts.paused(h)]
            for h in pending:
                if h not in live:
                    rec["per_host"][h] = {"detect_error": "lecteur_en_pause"}
            failures: dict = {}
            streams = resolve(entry, season, ep, live, attempt > 0, failures) if live else []
            got = {s["host"] for s in streams}
            for h in live:
                if h in got:
                    continue
                transient, why = failures.get(h, (False, "pas de flux pour cet episode"))
                if transient:
                    rec["per_host"][h] = {"detect_error": f"resolution: {why}"}
                    self.hosts.note(h, f"resolution: {why}")
                else:
                    rec["per_host"].pop(h, None)
                    rec["absent"][h] = why[:120]
            def keep(h: str, e: dict) -> None:
                if attempt:
                    e["retried"] = attempt
                rec["per_host"][h] = e
                rec["absent"].pop(h, None)
                self.hosts.note(h, e.get("detect_error"))

            # Un guide deja en main (reprise : un lecteur de cet episode a reussi).
            plan = next((p for p in (run.plan_from(e) for e in rec["per_host"].values()) if p), None)
            streams.sort(key=lambda s: GUIDE_ORDER.index(s["host"]) if s["host"] in GUIDE_ORDER else 99)
            # Les lecteurs passent un par un tant qu'aucun n'a abouti : le
            # premier qui aboutit dit aux autres ou ecouter.
            guided = False
            while streams and not guided and not any("detect_error" not in e for e in rec["per_host"].values()):
                s = streams.pop(0)
                e = detect(mal, lang, ep, s, refs, None)
                keep(s["host"], e)
                plan = run.plan_from(e)
                guided = "detect_error" not in e
            if streams:
                pool = ThreadPoolExecutor(max_workers=1 if self.a.serial_hosts else len(streams))
                futs = {s["host"]: pool.submit(detect, mal, lang, ep, s, refs, plan) for s in streams}
                t_end = time.time() + HOST_TIMEOUT_S
                for h, f in futs.items():
                    try:
                        e = f.result(timeout=max(1.0, t_end - time.time()))
                    except FutureTimeout:
                        e = {"detect_error": f"delai de {HOST_TIMEOUT_S} s depasse"}
                    keep(h, e)
                pool.shutdown(wait=False)
            pending = [h for h in errors_of(rec) if rec["per_host"][h]["detect_error"] != "lecteur_en_pause"]
            # Un lecteur qui tombe episode apres episode n'a pas besoin de
            # 4 essais ici : le disjoncteur et la reprise s'en chargent.
            pending = [h for h in pending if not self.hosts.flaky(h)]
            if not pending or attempt + 1 >= ATTEMPTS or self.should_stop():
                break
            time.sleep(WAITS_S[attempt])
        rec.update(at=now(), code=self.code, run=self.run_id)
        return rec

    def tally(self, rec: dict, was_done: bool) -> None:
        with _io:
            if not was_done:
                self.done += 1
            for h, e in rec["per_host"].items():
                if "detect_error" in e:
                    continue
                self.counts["hosts"] += 1
                self.counts["op"] += "op" in e
                self.counts["ed"] += "ed" in e
        self.sent.feed(rec)
        self.status.set(episodes_faits=self.done, op_servis=self.counts["op"], ed_servis=self.counts["ed"],
                        lecteurs_faits=self.counts["hosts"], dernier_progres=now())

    # -- un anime -----------------------------------------------------------
    def one_anime(self, entry: dict, path: Path, recs: dict, retry_only: bool) -> None:
        mal = entry["mal_id"]
        title = entry.get("title") or entry["slug"]
        refs = load_refs(mal)
        if not refs:
            append(path, {"mal_id": mal, "sans_reference": True, "at": now(), "code": self.code})
            recs["sans_reference"] = {"at": now()}
            return
        for passe in ("episodes",) + ("reprise",) * RETRY_PASSES:
            if passe == "episodes" and retry_only:
                continue
            tasks = []
            for season, ep in episodes_of(entry):
                prev = recs.get((ep, season["lang"]))
                if passe == "episodes" and prev is None:
                    tasks.append((season, ep, None))
                elif passe == "reprise" and prev and any(not self.hosts.paused(h) for h in errors_of(prev)):
                    tasks.append((season, ep, prev))
            if not tasks:
                continue

            def work(t):
                season, ep, prev = t
                if self.should_stop() or self.pause_reason:
                    return
                self.wait_resources()
                if self.should_stop():
                    return
                try:
                    rec = self.episode(entry, season, ep, prev, refs)
                except ProcessKilled:
                    self.stop_reason = "processus tue par le systeme"
                    self.stop.set()
                    return
                except Exception:
                    log(f"!! {mal} ep{ep} {season['lang']}\n{traceback.format_exc()}")
                    self.status.alert(f"{title} ep{ep} {season['lang']} : exception, episode non ecrit")
                    return
                if not rec["per_host"] and prev is None and not rec["absent"]:
                    rec["absent"]["*"] = "aucun lecteur"
                append(path, rec)
                recs[(ep, season["lang"])] = rec
                self.tally(rec, prev is not None)
                log(f"{title[:26]:<26} ep{ep:<4} {season['lang']:<6} {run.summary(rec)}"
                    + (f"  [reprise]" if prev else ""))
                for level, msg in self.sent.check():
                    if level == "pause" and not self.pause_reason:
                        self.pause_reason = msg
                    self.status.alert(f"sentinelle ({level}) : {msg}")

            with ThreadPoolExecutor(max_workers=self.a.workers) as pool:
                list(pool.map(work, tasks))
            if self.should_stop() or self.pause_reason:
                return

    def finish_anime(self, entry: dict, path: Path, recs: dict, ledger: dict, refs_keys: list[str]) -> None:
        mal = entry["mal_id"]
        ledger[str(mal)] = ledger_entry(entry, recs)
        ledger_path = self.base.with_name(self.base.name + ".ledger.json")
        with _io:
            write_atomic(ledger_path, json.dumps(ledger, ensure_ascii=False, indent=0))
        files = [(path, f"{self.base.name}/{path.name}"), (ledger_path, ledger_path.name)]
        files += [(p, f"ep/{p.name}") for p in EP_CACHE.glob(f"{mal}_*.npz")]
        self.status.set(sauvegarde=backup(files))
        # References : le son decode sort de la memoire, les fichiers partent
        # dans l'archive (le rejeu hors ligne en a besoin), les empreintes restent.
        for k in refs_keys:
            run._pcm.pop(k, None)
        if not self.a.no_archive and not archive.available():
            dst = archive.ROOT / "refs" / "audio"
            dst.mkdir(parents=True, exist_ok=True)
            for k in refs_keys:
                for src in (animethemes.CACHE / "audio").glob(f"{k}.*"):
                    try:
                        if not (dst / src.name).exists():
                            shutil.copyfile(src, dst / (src.name + ".part"))
                            (dst / (src.name + ".part")).replace(dst / src.name)
                        if (dst / src.name).stat().st_size == src.stat().st_size:
                            src.unlink()
                    except OSError as exc:
                        self.status.alert(f"reference {src.name} non archivee : {exc}")
        for f in Path("cache/urls").glob(f"{entry['slug']}__*.json"):
            f.unlink(missing_ok=True)

    # -- temoins ------------------------------------------------------------
    def canaries(self) -> None:
        if self.a.no_canary:
            return
        for level, msg in sentinels.canaries(self.base.with_name("temoins.json"), detect, load_refs):
            if level == "pause" and not self.pause_reason:
                self.pause_reason = msg
            self.status.alert(f"temoin ({level}) : {msg}")

    # -- le lot ---------------------------------------------------------------
    def main(self) -> int:
        a = self.a
        self.stop_reason = None
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        todo = self.anime[: a.limit] if a.limit else self.anime
        if a.only:
            only = {int(x) for x in a.only.split(",")}
            todo = [e for e in self.anime if e["mal_id"] in only]

        # Releve de ce qui existe : c'est lui qui dit ou reprendre.
        ledger, known, total, total_anime = {}, {}, 0, 0
        for entry in self.anime:
            path = out / f"{entry['mal_id']}.jsonl"
            recs = read_anime(path)
            known[entry["mal_id"]] = recs
            if path.exists():
                ledger[str(entry["mal_id"])] = ledger_entry(entry, recs)
            if "sans_reference" in recs or self.no_refs.get(str(entry["mal_id"])) == 0:
                continue
            total += len(episodes_of(entry))
            total_anime += 1
            self.done += sum(1 for s, ep in episodes_of(entry) if (ep, s["lang"]) in recs)
        self.status.done0 = self.done
        anime_done = lambda: sum(1 for x in ledger.values() if x["etat"] in ("fait", "a_reprendre"))
        redo = lambda: sum(sum(l["a_reprendre"] for l in x.get("langues", {}).values()) for x in ledger.values())
        self.status.set(etat="en_cours", total_episodes=total, episodes_faits=self.done, total_animes=total_anime,
                        animes_faits=anime_done(), palier=a.limit or None, a_reprendre=redo())
        log(f"lot {self.run_id} code {self.code} : {self.done} / {total} episodes-langues deja faits, "
            f"{len(todo)} animes dans ce lancement")

        beat = threading.Thread(target=self.heartbeat, daemon=True)
        beat.start()
        last_canary = 0.0
        for entry in todo:
            if self.should_stop() or self.pause_reason:
                break
            mal = entry["mal_id"]
            path, recs = out / f"{mal}.jsonl", known[mal]
            if "sans_reference" in recs:
                continue
            state = ledger.get(str(mal), {}).get("etat")
            if state == "fait" or (state == "a_reprendre" and not a.retry_errors):
                continue
            if time.time() - last_canary > CANARY_EVERY_S:
                self.wait_resources()
                self.canaries()
                last_canary = time.time()
                if self.pause_reason:
                    break
            self.status.set(anime_en_cours=f"{entry.get('title') or entry['slug']} (MAL {mal})")
            try:
                refs_keys = [r.theme.key for r in load_refs(mal)]
                self.one_anime(entry, path, recs, retry_only=state == "a_reprendre")
            except ProcessKilled:
                self.stop_reason = "processus tue par le systeme"
                break
            except Exception as exc:
                log(f"!! anime {mal}\n{traceback.format_exc()}")
                self.status.alert(f"{entry.get('title') or entry['slug']} : {type(exc).__name__}: {str(exc)[:160]}")
                continue
            self.finish_anime(entry, path, recs, ledger, refs_keys)
            self.status.set(animes_faits=anime_done(), a_reprendre=redo())

        if self.pause_reason:
            self.status.set(etat="pause", raison=self.pause_reason)
            log(f"PAUSE : {self.pause_reason}")
            return 3
        if self.stop.is_set():
            self.status.set(etat="arrete", raison=self.stop_reason)
            log(f"arret : {self.stop_reason}")
            return 2
        self.status.set(etat="fini", raison=None, anime_en_cours=None)
        log("fini")
        return 0

    def heartbeat(self) -> None:
        while True:
            time.sleep(30)
            try:
                self.status.write()
            except Exception:
                pass


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--anime-list", required=True)
    ap.add_argument("--out", default="out/catalogue")
    ap.add_argument("--limit", type=int, default=0, help="palier : les N premiers animes de la liste")
    ap.add_argument("--only", help="MAL ids separes par des virgules")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-minutes", type=float, default=0)
    ap.add_argument("--retry-errors", action="store_true", help="reprendre aussi les animes finis avec des lecteurs en panne")
    ap.add_argument("--no-archive", action="store_true", help="essais seulement : bornes sur le flux, rien d'archive")
    ap.add_argument("--no-partial", action="store_true", help="telecharger l'episode entier")
    ap.add_argument("--serial-hosts", action="store_true", help="lecteurs l'un apres l'autre (mesure)")
    ap.add_argument("--no-canary", action="store_true")
    ap.add_argument("--prepass", action="store_true",
                    help="compte les references AnimeThemes de chaque anime (une requete par anime), puis sort")
    a = ap.parse_args(argv)

    base = Path(a.out)
    if a.prepass:
        # Les animes sans reference sortent du total : le % porte sur le travail reel.
        counts, path = {}, base.with_name(base.name + ".refs.json")
        for i, entry in enumerate(json.load(open(a.anime_list, encoding="utf-8"))):
            try:
                counts[str(entry["mal_id"])] = len(animethemes.fetch_themes(entry["mal_id"]))
            except Exception as exc:
                print(f"{entry['mal_id']} {entry['slug']} : {exc}", flush=True)
            if i % 100 == 0:
                print(i, flush=True)
                write_atomic(path, json.dumps(counts))
        write_atomic(path, json.dumps(counts))
        print(f"{sum(1 for v in counts.values() if v)} animes avec references sur {len(counts)}")
        return 0
    lock = base.with_name(base.name + ".lock")
    if lock.exists():
        try:
            pid = int(lock.read_text().strip())
        except ValueError:
            pid = 0
        if pid and pid != os.getpid() and pid_alive(pid):
            print(f"un lot tourne deja (pid {pid})")
            return 4
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text(str(os.getpid()))

    global LOG
    LOG = base.with_name(base.name + ".log")
    run.KEEP = not a.no_archive
    run.PARTIAL = not a.no_partial
    animethemes.EXTRA_DIRS.append(archive.ROOT / "refs")
    # Pas de veille tant que le lot tourne (ES_CONTINUOUS | ES_SYSTEM_REQUIRED).
    ctypes.windll.kernel32.SetThreadExecutionState(0x80000001)

    # Piles de tous les fils, toutes les 10 min, dans un fichier : c'est ce qui
    # dit OU le lot est fige quand le superviseur doit le tuer.
    stacks = open(base.with_name(base.name + ".stacks.txt"), "w", encoding="utf-8")
    faulthandler.dump_traceback_later(600, repeat=True, file=stacks)

    anime = json.load(open(a.anime_list, encoding="utf-8"))
    lot = Lot(a, base, anime)
    refs_file = base.with_name(base.name + ".refs.json")
    lot.no_refs = json.loads(refs_file.read_text(encoding="utf-8")) if refs_file.exists() else {}
    code = 1
    try:
        code = lot.main()
    finally:
        lock.unlink(missing_ok=True)
    # Sortie SANS attendre les fils : un lecteur dont le delai a expire peut
    # encore tenir un fil plusieurs minutes (02/10/2026 : le lot arrete restait
    # en vie, et le superviseur n'aurait jamais relance). Tout est deja ecrit et
    # vide sur disque a ce stade.
    sys.stdout.flush()
    os._exit(code)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
