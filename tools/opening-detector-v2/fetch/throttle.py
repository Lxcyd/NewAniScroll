"""Per-host adaptive concurrency (AIMD) + retry classification.

At 2000-anime scale the throughput ceiling is what the stream host (Sibnet)
tolerates before it throttles/bans. A fixed cap either under-uses the link or
trips the limiter. AIMD (additive-increase / multiplicative-decrease, the TCP
congestion idea) self-tunes: grow the in-flight limit by 1 after a run of
clean successes, halve it the moment the host pushes back (429 / timeout /
connection reset). It converges on the largest concurrency the host accepts
without us hard-coding a magic number.

Pure-Python, threading-based (the workload is subprocess+network bound, so the
GIL is not the constraint). No third-party deps so it imports without the
numpy/scipy stack.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from urllib.parse import urlparse


def host_of(url: str) -> str:
    try:
        return urlparse(url).hostname or "?"
    except Exception:
        return "?"


def is_throttle_error(exc: BaseException) -> bool:
    """True if `exc` looks like host back-pressure (should shrink + retry),
    as opposed to a permanent failure (dead host, 404 — should not retry)."""
    msg = str(exc).lower()
    signals = (
        "429", "too many", "throttl", "rate limit",
        "timed out", "timeout", "reset by peer", "connection reset",
        "temporarily", "503", "502", "504",
    )
    return any(s in msg for s in signals)


@dataclass
class HostLimiter:
    """AIMD in-flight limiter for a single host.

    `limit` is the current max concurrent requests. A semaphore-like gate is
    emulated with a condition variable so `limit` can shrink live (a plain
    Semaphore cannot lower its count). Increase after `grow_after` consecutive
    successes; multiplicative-decrease (halve) on throttle.
    """

    limit: int = 6
    min_limit: int = 1
    max_limit: int = 24
    grow_after: int = 8

    _inflight: int = 0
    _ok_streak: int = 0
    _cv: threading.Condition = field(default_factory=threading.Condition)

    def acquire(self) -> None:
        with self._cv:
            while self._inflight >= self.limit:
                self._cv.wait()
            self._inflight += 1

    def release(self) -> None:
        with self._cv:
            self._inflight -= 1
            self._cv.notify_all()

    def on_success(self) -> None:
        with self._cv:
            self._ok_streak += 1
            if self._ok_streak >= self.grow_after and self.limit < self.max_limit:
                self.limit += 1                 # additive increase
                self._ok_streak = 0
                self._cv.notify_all()

    def on_throttle(self) -> None:
        with self._cv:
            self._ok_streak = 0
            self.limit = max(self.min_limit, self.limit // 2)  # mult. decrease

    def snapshot(self) -> tuple[int, int]:
        with self._cv:
            return self._inflight, self.limit


class HostThrottler:
    """Registry of per-host AIMD limiters + a global worker cap.

    Use as: `with throttler.slot(url): ...do the request...`. On a throttle
    error inside the block, call `throttler.report_throttle(url)` before the
    context exits so the limiter shrinks; otherwise it counts as success.
    """

    def __init__(self, *, start: int = 6, max_per_host: int = 24):
        self._start = start
        self._max = max_per_host
        self._hosts: dict[str, HostLimiter] = {}
        self._lock = threading.Lock()

    def _limiter(self, host: str) -> HostLimiter:
        with self._lock:
            lim = self._hosts.get(host)
            if lim is None:
                lim = HostLimiter(limit=self._start, max_limit=self._max)
                self._hosts[host] = lim
            return lim

    def slot(self, url: str) -> "_Slot":
        return _Slot(self._limiter(host_of(url)))

    def stats(self) -> dict[str, tuple[int, int]]:
        with self._lock:
            return {h: l.snapshot() for h, l in self._hosts.items()}


class _Slot:
    def __init__(self, limiter: HostLimiter):
        self._lim = limiter
        self._throttled = False

    def __enter__(self) -> "_Slot":
        self._lim.acquire()
        return self

    def throttled(self) -> None:
        self._throttled = True

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc is not None and is_throttle_error(exc):
                self._throttled = True
            if self._throttled:
                self._lim.on_throttle()
            else:
                self._lim.on_success()
        finally:
            self._lim.release()
