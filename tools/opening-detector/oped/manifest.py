"""Crash-safe progress manifest for the 2000-anime batch.

A run WILL be interrupted (host death, machine sleep, Ctrl-C). The manifest
lets a re-run resume without re-downloading anything already done. One JSON
line per anime status, appended atomically; on load the LAST line per key
wins, so a re-processed anime cleanly supersedes its earlier state.

States: "done" (results written), "failed" (with reason, eligible for the
end-of-run requeue), "skipped" (no AnimeThemes data — never touched a stream).
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Record:
    key: str            # stable anime key (e.g. "mal:16498")
    status: str         # "done" | "failed" | "skipped"
    reason: str = ""    # failure reason / skip reason
    episodes: int = 0   # count of episodes with a result (for done)


class Manifest:
    """Append-only JSONL progress log with last-write-wins semantics."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._state: dict[str, Record] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        for line in self.path.read_text("utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
                self._state[d["key"]] = Record(**d)
            except Exception:
                continue  # tolerate a torn last line from a crash mid-write

    def status(self, key: str) -> str | None:
        rec = self._state.get(key)
        return rec.status if rec else None

    def is_done(self, key: str) -> bool:
        """Terminal states we should NOT redo on resume. 'failed' is NOT
        terminal — it's requeued — so it returns False here."""
        return self.status(key) in ("done", "skipped")

    def record(self, rec: Record) -> None:
        with self._lock:
            self._state[rec.key] = rec
            # Append then fsync the single line — cheap and durable. A full
            # atomic-rewrite per record would be O(n²) over a 2000-line file.
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec.__dict__) + "\n")
                f.flush()
                os.fsync(f.fileno())

    def failed_keys(self) -> list[str]:
        return [k for k, r in self._state.items() if r.status == "failed"]

    def summary(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for r in self._state.values():
            out[r.status] = out.get(r.status, 0) + 1
        return out
