"""Per-host algo versions + the displayed-host allowlist, read from the shared
`host_versions.json` at the tool root.

This is the Python side of `lib/hostRegistry.js`: the JSON's keys ARE the
allowlist (they mirror `DISPLAYED_HOSTS` there), and its values are the algo
version of each host. `batch_detect.py` uses `host_versions()` to decide which
hosts to (re)run: a host is (re)run for an anime when the DB coverage has no
entry for it OR a stale one (`processed_version < current_version`). Bump a
host's number when a fix changes what it can detect (megaplay -> 2 after the
PNG-decoy de-obfuscation); add a key when a new host becomes displayable.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_VERSIONS_FILE = Path(__file__).resolve().parents[1] / "host_versions.json"


@lru_cache(maxsize=1)
def host_versions() -> dict[str, int]:
    """{host: algo_version} for every displayed host. Cached (the file is tiny
    and constant for a run)."""
    data = json.loads(_VERSIONS_FILE.read_text("utf-8"))
    return {str(k): int(v) for k, v in data["versions"].items()}


def displayed_hosts() -> list[str]:
    """The ONLY hosts allowed in the DB — the keys of host_versions.json,
    kept in lockstep with lib/hostRegistry.js DISPLAYED_HOSTS."""
    return list(host_versions().keys())


def version_of(host: str) -> int:
    """Current algo version of `host` (0 if unknown/not displayed)."""
    return host_versions().get(host, 0)
