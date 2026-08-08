"""Real-episode fetch adapter: resolve stream URLs through THIS project's
extractor (Node bridge) and pull audio-only via ffmpeg.

Flow:
  resolve_sibnet.mjs  ->  [{ep, url}]  ->  load_audio(url)  ->  fingerprint
No video is ever downloaded (ffmpeg -vn in audio.py).

The resolved (signed) stream URLs are cached to disk per (slug, season, lang)
so we don't re-hit anime-sama / Sibnet on every run; the URLs carry an expiry
(`e=` param), so the cache is treated as stale after a TTL.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .errors import ProcessKilled, killed_by_os

BRIDGE = Path(__file__).resolve().parents[1] / "bridge" / "resolve.mjs"
URL_CACHE_TTL = 6 * 3600  # signed stream URLs expire within ~a day; refresh before

# Hosts whose embed is NOT derived from (slug, season, lang) at all, so
# pinning them under a non-default `lang` is not guaranteed to actually
# change what's served — the bridge may silently keep returning the same
# encode regardless of the requested language.
#
# megaplay N'EST PLUS ici, et l'erreur qui l'y avait mis vaut d'être gardée.
#
# Le raisonnement d'origine : sur SnK ep3, `--lang vf` et `--lang vostfr`
# rendaient une durée sondée IDENTIQUE à la décimale près (1466.5 s), donc
# megaplay devait resservir l'encode VOSTFR sous une requête VF.
#
# **La durée ne pouvait pas trancher cette question.** Un doublage est le même
# épisode avec une autre piste audio : il a exactement le même métrage, par
# construction. Une durée identique était donc le résultat attendu dans les DEUX
# hypothèses — c'était une mesure sans pouvoir discriminant, présentée comme une
# confirmation.
#
# Mesuré le 08/08/2026, cette fois sur ce qui distingue réellement les deux cas —
# l'audio. Fenêtre de 20 s en plein dialogue (t=600 s), décodée des deux flux :
#   corrélation = -0.005, RMS 0.054 vs 0.038
# Deux pistes sans aucun rapport. `bridge/resolve.mjs` construit bien
# `.../mal/<id>/<ep>/<sub|dub>` et megaplay sert un VRAI doublage français.
#
# Leçon générale : avant de conclure d'une égalité, vérifier que la grandeur
# mesurée aurait pu être différente si l'hypothèse était fausse.
VF_INCOMPATIBLE_HOSTS: set[str] = set()


def resolve_episodes(
    slug: str,
    season_dir: str,
    lang: str,
    ep_start: int,
    ep_end: int,
    *,
    cache_dir: str | Path = "cache/urls",
    host_pref: str | None = None,
    mal_id: int | str | None = None,
    va_slug: str | None = None,
) -> list[dict]:
    """Return [{ep, url, isM3U8, host}, ...] for the requested range.

    Uses the multi-host bridge: it tries hosts in priority order until one
    resolves the whole range. `host_pref` (comma list, e.g. "sibnet,sendvid")
    pins the host order — important for the series bank, which needs ALL
    episodes from the SAME host so their cuts align (different hosts can have
    different intros/offsets and would break cross-episode matching).

    `mal_id` is required if "megaplay" appears anywhere in `host_pref` (or in
    the bridge's default priority, when `host_pref` is omitted) — megaplay's
    embed URL is built directly from a MAL id + episode number, it isn't
    scraped from anime-sama's episodes.js like the other hosts. Without it,
    the bridge skips megaplay silently (logged in its `errors`, not raised).
    NOTE: this also means megaplay's embed carries no `lang` signal at all —
    see `VF_INCOMPATIBLE_HOSTS` above. Callers that need a specific language
    guarantee should not rely on megaplay for anything but VOSTFR.

    `va_slug` is required if "vidmoly-va" appears in `host_pref` — voir-anime is
    a separate site with its own per-season slugs (e.g.
    "shingeki-no-kyojin-vostfr"), so its embeds can't be derived from the
    anime-sama slug. Without it, the bridge skips vidmoly-va (logged, not raised).
    """
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    pref_tag = f"__{host_pref.replace(',', '-')}" if host_pref else ""
    mal_tag = f"__mal{mal_id}" if mal_id else ""
    va_tag = f"__va{va_slug}" if va_slug else ""
    key = f"{slug}__{season_dir}__{lang}__{ep_start}-{ep_end}{pref_tag}{mal_tag}{va_tag}.json"
    cache_file = cache_dir / key

    if cache_file.exists() and (time.time() - cache_file.stat().st_mtime) < URL_CACHE_TTL:
        data = json.loads(cache_file.read_text("utf-8"))
        if data.get("ok"):
            return data["episodes"]

    args = ["node", str(BRIDGE), slug, season_dir, lang, str(ep_start), str(ep_end)]
    if host_pref:
        args.append(host_pref)
        # The bridge reads malId as the 7th positional arg and vaSlug as the 8th,
        # both only when host_pref (6th) is present. vaSlug at position 8 needs
        # SOMETHING at position 7 — pass an empty string for malId when vaSlug is
        # given without one, so the positions don't shift.
        if mal_id or va_slug:
            args.append(str(mal_id) if mal_id else "")
        if va_slug:
            args.append(str(va_slug))
    # The bridge does its own network I/O (worker + host pages + HEAD probes)
    # and had no ceiling, so a hung upstream page pinned a batch worker forever.
    # Resolution is short-lived by nature — the slowest measured pass was ~52 s —
    # so 300 s only fires on a stall.
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=float(os.environ.get("OPED_BRIDGE_TIMEOUT", "300")),
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("bridge timeout — upstream stalled, host skipped") from None
    if proc.returncode != 0:
        if killed_by_os(proc.returncode):
            raise ProcessKilled(
                f"bridge tue par le systeme (rc={proc.returncode} / "
                f"0x{proc.returncode & 0xFFFFFFFF:08X}), stderr="
                f"{proc.stderr.strip()!r} — l'environnement s'eteint, "
                f"ce n'est PAS un echec de {host_pref or 'l hote'}"
            )
        raise RuntimeError(f"bridge failed (rc={proc.returncode}):\n{proc.stderr}")

    # The extractor prints diagnostic [sibnet] lines to stdout too; the JSON is
    # the LAST non-empty line.
    json_line = next(
        ln for ln in reversed(proc.stdout.splitlines()) if ln.strip().startswith("{")
    )
    data = json.loads(json_line)
    if not data.get("ok"):
        raise RuntimeError(f"resolution failed: {data.get('errors')}")

    cache_file.write_text(json.dumps(data), "utf-8")
    return data["episodes"]


# Hosts we can pull server-side audio from, in the same priority the bridge uses.
# Kept in sync with DEFAULT_PRIORITY in bridge/resolve.mjs — see that file's
# comment for details:
#   - vidmoly (anime-sama source) & vidmoly-va (voir-anime source): the master
#     m3u8 token is IP-bound to whoever extracted the embed (the CF Worker). We
#     keep it valid by routing the ffmpeg pull THROUGH the Worker, which rewrites
#     every nested segment URL back through itself (wrapWorkerM3U8). vidmoly-va
#     additionally needs a voir-anime slug passed as `va_slug`.
#   - embed4me / lpayer: literally the SAME host (its URLs contain both
#     substrings, e.g. lpayer.embed4me.com) — listing both resolves the
#     identical stream twice under two different labels. Also IP-bound.
#   - uqload: now HAS a dedicated extractor (extractUqload) and is a displayed
#     server in lib/servers.js, so it belongs here — "detected hosts" must equal
#     "displayed hosts" (see lib/hostRegistry.js DISPLAYED_HOSTS). Its stream
#     token is IP/single-use-bound though, so a server-side ffmpeg pull may 403;
#     when it can't be pulled it simply yields no row (a resolve/decode miss),
#     which is fine — it never poisons the DB, it just doesn't contribute.
# This list is the displayed-host allowlist (mirrors host_versions.json keys /
# lib/hostRegistry.js DISPLAYED_HOSTS). Keep the three in sync.
# `vidmoly` (the anime-sama entry) is GONE, replaced by `ansembed`: anime-sama
# migrated its vidmoly uploads to that white-label domain and no longer lists
# vidmoly.* on any panel, so the host could only ever answer "not offered" —
# one wasted resolution subprocess per episode over 33k ep-languages. Same
# reasoning that removed uqload from this list in July. `vidmoly-va` stays: it
# is voir-anime's own upload, a genuinely different encode.
MULTI_HOSTS = ["sibnet", "sendvid", "megaplay", "ansembed", "vidmoly-va",
               "uqload"]

# --- Réessai de résolution (07/08) -------------------------------------------
# MESURÉ AVANT D'ÊTRE ÉCRIT. Sur 8 lots successifs, parmi les couples
# (cellule, hôte) ayant échoué au premier essai et ayant une référence
# AnimeThemes : 26 sur 72 (36 %) réussissent à un essai ultérieur — ansembed
# 40 %, megaplay 55 %, vidmoly-va 29 %. Les deux autres tiers ne reviennent
# JAMAIS : l'échec n'est pas majoritairement transitoire, et réessayer ne
# converge PAS vers « l'hôte finit par répondre ». Ce réessai récupère une
# fraction connue, pas la totalité — ne pas lui prêter davantage.
#
# Ce qui rend l'opération rentable malgré tout : 33 % des cellules exploitables
# n'ont qu'UN SEUL hôte qui répond, à un hôte du seuil de service (≥2). C'est
# là qu'un hôte récupéré fait basculer une cellule, pas sur celles à zéro hôte.
RESOLVE_ATTEMPTS = 5
RESOLVE_BACKOFF_S = 2.0
# Plafond : sans lui la 5e attente durerait 32 s et un hôte mort tiendrait le
# lot en otage. 2, 4, 8, 8 s — au total 22 s au pire, uniquement sur les motifs
# transitoires, et les hôtes se résolvent en parallèle donc l'épisode n'attend
# que le plus lent.
RESOLVE_BACKOFF_MAX_S = 8.0

# Motifs DÉFINITIFS : réessayer n'y peut rien et coûte du temps de run.
# « not offered » est le plus fréquent des échecs (95 sur 244 lors du lot du
# 07/08) et n'est PAS une panne : l'hôte ne sert simplement pas cette saison.
_PERMANENT_MARKERS = (
    "not offered by anime-sama",     # l'hôte ne sert pas cette saison
    "not in voir-anime page",        # l'épisode n'y est pas
    "file not found",
    "404",                           # page/fichier absent, pas une indisponibilité
)


# COUPE-CIRCUIT PAR HÔTE (07/08, après mesure sur le lot `seed`).
# Le réessai ci-dessus ne se souvenait de rien : sur 64 réessais du lot, **60
# portaient sur sendvid**, qui renvoyait `HTTP 502` épisode après épisode. On
# payait 4 attentes par épisode pour un hôte manifestement mort sur ce lot.
# Après ce nombre d'échecs TRANSITOIRES consécutifs, l'hôte n'est plus réessayé
# du reste du processus — sa première tentative reste faite, donc s'il
# ressuscite on le voit immédiatement et le compteur repart.
CIRCUIT_BREAKER_FAILS = 3
_host_fail_streak: dict[str, int] = {}
_host_fail_lock = threading.Lock()


def _circuit_open(host: str) -> bool:
    with _host_fail_lock:
        return _host_fail_streak.get(host, 0) >= CIRCUIT_BREAKER_FAILS


def _note_host_result(host: str, ok: bool) -> None:
    with _host_fail_lock:
        if ok:
            _host_fail_streak.pop(host, None)
        else:
            _host_fail_streak[host] = _host_fail_streak.get(host, 0) + 1


def _is_transient(exc: Exception) -> bool:
    """Un nouvel essai a-t-il une chance de changer le résultat ?

    Par défaut OUI (timeouts, coupures, 5xx, embed injoignable) : mieux vaut un
    essai de trop qu'une cellule perdue. Seuls les motifs explicitement
    définitifs coupent le réessai.
    """
    msg = str(exc).lower()
    return not any(m in msg for m in _PERMANENT_MARKERS)


def resolve_episodes_multi(
    slug: str,
    season_dir: str,
    lang: str,
    ep_start: int,
    ep_end: int,
    *,
    hosts: list[str] | None = None,
    cache_dir: str | Path = "cache/urls",
    mal_id: int | str | None = None,
    va_slug: str | None = None,
) -> dict[int, list[dict]]:
    """Resolve the range from SEVERAL hosts and group the streams by episode.

    Returns {ep: [{ep, url, isM3U8, host}, ...]} — one entry per host that
    resolved that episode. This is the input to the multi-host detector: the
    SAME episode from different hosts is a different encode (different total
    duration), and cross-checking the OP/ED across them is what makes the
    delivered skip times robust to per-player duration differences.

    Each host is pinned individually (host_pref = that one host) so the bridge
    doesn't silently fall back to another host — we WANT one distinct encode per
    entry. A host that can't resolve the range is skipped, not fatal.

    Hosts are resolved IN PARALLEL (one Node subprocess + network round-trip
    per host, all independent of each other) — this is the dominant cost at
    the start of a multi-host run, so serializing it needlessly stalls
    everything downstream.

    Pass `mal_id` if "megaplay" is in `hosts` (or the default list) — without
    it, megaplay is skipped cleanly (its resolution needs a MAL id, not a
    slug/season, so there's nothing meaningful to try). Likewise pass `va_slug`
    if "vidmoly-va" is in `hosts` — voir-anime needs its own slug.

    When `lang != "vostfr"`, hosts in `VF_INCOMPATIBLE_HOSTS` are dropped
    before resolving anything: their embed construction has no `lang` input,
    so pinning them under e.g. "vf" risks silently re-serving the VOSTFR
    encode under a VF label, which would corrupt reconciliation rather than
    just be absent from it.
    """
    hosts = hosts or MULTI_HOSTS
    if lang != "vostfr":
        dropped = [h for h in hosts if h in VF_INCOMPATIBLE_HOSTS]
        if dropped:
            print(f"  [info] lang={lang!r}: skipping {dropped} — no lang signal "
                  f"in their embed construction, would risk a mislabeled stream")
        hosts = [h for h in hosts if h not in VF_INCOMPATIBLE_HOSTS]

    # Hosts that can't possibly resolve (missing mal_id/va_slug) are filtered
    # out BEFORE spinning up threads, so we don't waste a worker on something
    # that's a guaranteed no-op.
    eligible = [
        h for h in hosts
        if not (h == "megaplay" and not mal_id)
        and not (h == "vidmoly-va" and not va_slug)
    ]

    def _resolve_one(host: str) -> tuple[str, list[dict]]:
        last: Exception | None = None
        for attempt in range(RESOLVE_ATTEMPTS):
            try:
                eps = resolve_episodes(
                    slug, season_dir, lang, ep_start, ep_end,
                    host_pref=host, cache_dir=cache_dir, mal_id=mal_id,
                    va_slug=va_slug,
                )
            except ProcessKilled:
                # Ni réessai, ni coupe-circuit, ni `[no-host]` : on remonte.
                # Réessayer n'a aucun sens (la machine s'éteint) et l'imputer à
                # l'hôte fabriquerait l'absence fausse que cette classe existe
                # pour empêcher.
                raise
            except Exception as exc:
                last = exc
                transient = _is_transient(exc)
                # Seuls les échecs TRANSITOIRES alimentent le compteur : un
                # « not offered » est fréquent et n'est pas une panne, le
                # compter remettrait la série à zéro en permanence et le
                # coupe-circuit ne se fermerait jamais.
                if transient:
                    _note_host_result(host, ok=False)
                if attempt + 1 >= RESOLVE_ATTEMPTS or not transient:
                    break
                if _circuit_open(host):
                    print(f"  [circuit] {host}: {CIRCUIT_BREAKER_FAILS} echecs "
                          f"d'affilee — plus de reessai sur ce lot")
                    break
                # Temporisation croissante : un 502 ou un embed injoignable est
                # souvent une mauvaise seconde chez l'hôte, pas une absence.
                delay = min(RESOLVE_BACKOFF_S * (2 ** attempt),
                            RESOLVE_BACKOFF_MAX_S)
                print(f"  [retry] {host}: {exc} — nouvel essai dans {delay:.0f}s")
                time.sleep(delay)
            else:
                _note_host_result(host, ok=True)     # la série repart à zéro
                return host, eps
        # Its peers cover us, so a failing host must not sink the episode —
        # but swallowing the REASON is how "only 2 of 5 hosts resolve" went
        # undiagnosed for weeks. The bridge now says whether the player is
        # simply not offered for this season (a data gap, nothing to fix) or
        # actually failed to extract (a bug, a block, a dead host).
        print(f"  [no-host] {host}: {last}")
        return host, []

    by_ep: dict[int, list[dict]] = {}
    if eligible:
        with ThreadPoolExecutor(max_workers=len(eligible)) as pool:
            for host, eps in pool.map(_resolve_one, eligible):
                for e in eps:
                    # The bridge tags each stream with the host it actually
                    # came from; trust that over our request (it can differ
                    # on partial fallbacks).
                    e.setdefault("host", host)
                    by_ep.setdefault(e["ep"], []).append(e)
    return by_ep