"""Thread-safe phase timing for the batch, behind the `--timings` flag.

The backfill's whole feasibility question is "how long does one episode-lang
actually take, and where does the time go" — a number the codebase never
measured (no batch had ever run). This collects wall-clock per PHASE
("resolve", "probe", "detect") and per anime so a bench run can be extrapolated
to the full 33.7k episode-langs with a real basis instead of a single-episode
guess.

Zero cost when disabled: `TimingCollector.disabled()` returns a no-op whose
`span()` is an empty context manager, so the instrumented call sites add one
attribute lookup and nothing else on a normal run.
"""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field


@dataclass
class _Stat:
    n: int = 0
    total_s: float = 0.0
    max_s: float = 0.0

    def add(self, dt: float) -> None:
        self.n += 1
        self.total_s += dt
        if dt > self.max_s:
            self.max_s = dt


class TimingCollector:
    """Accumulates elapsed wall-clock per (phase) and per (phase, host).

    A single instance is shared across all worker threads; each `span()` records
    one interval under a lock (contention is negligible — spans are seconds long,
    the lock is held for microseconds).
    """

    def __init__(self, *, enabled: bool = True):
        self._enabled = enabled
        self._lock = threading.Lock()
        self._phases: dict[str, _Stat] = {}
        self._by_host: dict[tuple[str, str], _Stat] = {}
        self._t0 = time.monotonic()

    @classmethod
    def disabled(cls) -> "TimingCollector":
        return cls(enabled=False)

    @property
    def enabled(self) -> bool:
        return self._enabled

    @contextmanager
    def span(self, phase: str, *, host: str | None = None):
        """Time the wrapped block under `phase` (and optionally `phase`×`host`).

        A raised exception is still timed and re-raised — a throttle/timeout is
        exactly the slow case we want measured, not hidden."""
        if not self._enabled:
            yield
            return
        t = time.perf_counter()
        try:
            yield
        finally:
            dt = time.perf_counter() - t
            with self._lock:
                self._phases.setdefault(phase, _Stat()).add(dt)
                if host is not None:
                    self._by_host.setdefault((phase, host), _Stat()).add(dt)

    def report(self) -> str:
        """A compact table: per-phase count / total / mean / max, then the same
        broken down by host for the network phases. Purely for the bench log."""
        if not self._enabled:
            return ""
        wall = time.monotonic() - self._t0
        lines = [f"\n=== TIMINGS (wall {wall:.0f}s) ==="]
        lines.append(f"{'phase':>10}  {'n':>5}  {'total_s':>9}  {'mean_s':>7}  {'max_s':>7}")
        with self._lock:
            for phase in sorted(self._phases, key=lambda p: -self._phases[p].total_s):
                s = self._phases[phase]
                mean = s.total_s / s.n if s.n else 0.0
                lines.append(f"{phase:>10}  {s.n:>5}  {s.total_s:>9.1f}  {mean:>7.2f}  {s.max_s:>7.2f}")
            if self._by_host:
                lines.append(f"\n{'phase':>10}  {'host':>16}  {'n':>5}  {'total_s':>9}  {'mean_s':>7}")
                for (phase, host) in sorted(self._by_host, key=lambda k: -self._by_host[k].total_s):
                    s = self._by_host[(phase, host)]
                    mean = s.total_s / s.n if s.n else 0.0
                    lines.append(f"{phase:>10}  {host:>16}  {s.n:>5}  {s.total_s:>9.1f}  {mean:>7.2f}")
        return "\n".join(lines)
