"""Reproduce the anomaly-detector measurements quoted in the README ("KPI analytics").

    cd services/ai
    python -m scripts.detector_benchmark

Every input is seeded, so the output is identical on every run. Synthetic series match
tests/test_anomaly.py: weekdays at 1000, weekends at 50%, uniform +-5% noise, 120 days.
The demo data is a port of apps/api/src/lib/demoData.ts (same PRNG, specs and rounding);
change both together.
"""

from __future__ import annotations

import math
import random
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from statistics import median
from typing import Literal
from unittest import mock

from app import anomaly
from app.anomaly import detect

END = date(2026, 9, 26)
WINDOW_DAYS = 30
SEEDS = range(500)  # x 30 window days = 15,000 day-checks per measurement
DROPS = (0.20, 0.25, 0.30)
SPARSE_SERIES = 500
# History the API sends before each view (LOOKBACK_DAYS in apps/api/src/lib/insights.ts).
LOOKBACK_DAYS = 56
DEMO_VIEWS = (30, 90, 180)

Series = list[tuple[date, float]]


def seasonal_series(
    seed: int, days: int = 120, base: float = 1000, weekend: float = 0.5, noise: float = 0.05
) -> Series:
    rnd = random.Random(seed)
    out = []
    for i in range(days):
        d = END - timedelta(days=days - 1 - i)
        seasonal = weekend if d.weekday() >= 5 else 1.0
        out.append((d, base * seasonal * (1 + rnd.uniform(-noise, noise))))
    return out


def false_alarms() -> tuple[int, int]:
    """Anomalies flagged in the last 30 days of incident-free series."""
    start = END - timedelta(days=WINDOW_DAYS - 1)
    flagged = sum(len(detect(seasonal_series(seed), start, END)) for seed in SEEDS)
    return flagged, len(SEEDS) * WINDOW_DAYS


def drop_detection(drop: float) -> tuple[int, int]:
    """Inject one drop on each of the 30 window days of every series; count the ones flagged."""
    hits = trials = 0
    for seed in SEEDS:
        series = seasonal_series(seed)
        for k in range(WINDOW_DAYS):
            day = END - timedelta(days=k)
            points = [(d, v * (1 - drop) if d == day else v) for d, v in series]
            # A day's score depends only on the history before it, so scoring that day alone is exact.
            hits += any(a.kind == "drop" for a in detect(points, day, day))
            trials += 1
    return hits, trials


def sparse_alerts_per_window() -> float:
    """Mean alerts per 30-day view on 0/1 counts with P(1) = 25%, e.g. daily refunds."""
    rnd = random.Random(7)
    start = END - timedelta(days=WINDOW_DAYS - 1)
    total = 0
    for _ in range(SPARSE_SERIES):
        series = [
            (END - timedelta(days=i), 1.0 if rnd.random() < 0.25 else 0.0)
            for i in range(WINDOW_DAYS + LOOKBACK_DAYS)
        ]
        total += len(detect(series, start, END))
    return total / SPARSE_SERIES


def _mad_only_sigma(xs: list[float]) -> float:
    """The noise estimate before the mean-absolute-deviation fallback: 0 on mostly-zero series."""
    m = median(xs)
    return anomaly.MAD_TO_SIGMA * median(abs(x - m) for x in xs)


# ---- demo data (port of apps/api/src/lib/demoData.ts) ------------------------------------


@dataclass(frozen=True)
class DemoSpec:
    name: str
    unit: str
    direction: Literal["up", "down"]
    base: float
    trend_per_day: float
    weekend: float
    noise: float
    decimals: int
    incidents: tuple[tuple[int, float], ...]  # (days before the last day, factor)


DEMO_SPECS = (
    DemoSpec("Revenue", "$", "up", 12_000, 0.0015, 0.55, 0.06, 0, ((12, 0.55),)),
    DemoSpec("Orders", "", "up", 180, 0.0012, 0.6, 0.07, 0, ((12, 0.6),)),
    DemoSpec("New customers", "", "up", 42, 0.001, 0.5, 0.1, 0, ((45, 2.4),)),
    DemoSpec("Support tickets", "", "down", 64, -0.0008, 0.4, 0.08, 0, ((5, 2.6),)),
    DemoSpec("Avg resolution time", "h", "down", 6.5, -0.001, 1.15, 0.05, 1, ((20, 2.1),)),
    DemoSpec("Customer satisfaction", "%", "up", 91, 0.00005, 1.0, 0.01, 1, ((5, 0.86),)),
)

_U32 = 0xFFFFFFFF


def _i32(x: int) -> int:
    x &= _U32
    return x - (1 << 32) if x & 0x80000000 else x


def _imul(a: int, b: int) -> int:
    return _i32((a & _U32) * (b & _U32))


def mulberry32(seed: int) -> Callable[[], float]:
    """Bit-exact port of the API's PRNG. JS `>>>` is an unsigned shift, hence the masks."""

    def rand() -> float:
        nonlocal seed
        seed = _i32(seed + 0x6D2B79F5)
        t = _imul(seed ^ ((seed & _U32) >> 15), 1 | seed)
        t = _i32(t + _imul(t ^ ((t & _U32) >> 7), 61 | t)) ^ t
        return ((t ^ ((t & _U32) >> 14)) & _U32) / 4294967296

    return rand


def _js_round(x: float) -> int:
    """Math.round: ties go towards +infinity, unlike Python's banker's rounding."""
    r = math.floor(x)
    return r + 1 if x - r >= 0.5 else r


def generate_demo_data(to: date, days: int = 180, seed: int = 42) -> list[tuple[DemoSpec, Series]]:
    first = to - timedelta(days=days - 1)
    out = []
    for si, spec in enumerate(DEMO_SPECS):
        rand = mulberry32(seed + si * 7919)
        incidents = {to - timedelta(days=ago): factor for ago, factor in spec.incidents}
        points = []
        for i in range(days):
            day = first + timedelta(days=i)
            seasonal = spec.weekend if day.weekday() >= 5 else 1
            noise = 1 + (rand() * 2 - 1) * spec.noise
            value = spec.base * (1 + spec.trend_per_day * i) * seasonal * noise * incidents.get(day, 1)
            if spec.unit == "%":
                value = min(value, 100)
            f = 10**spec.decimals
            points.append((day, _js_round(value * f) / f))
        out.append((spec, points))
    return out


@dataclass(frozen=True)
class DemoView:
    to: date
    days: int
    injected: int
    found: int
    extra: tuple[tuple[str, anomaly.Anomaly], ...]  # flagged days that are not injected incidents


def demo_views(ends: Iterable[date]) -> list[DemoView]:
    """Score each dashboard view the way the API asks for it: the view plus 56 days of history."""
    rows = []
    for to in ends:
        data = generate_demo_data(to)
        for view in DEMO_VIEWS:
            start = to - timedelta(days=view - 1)
            history_from = start - timedelta(days=LOOKBACK_DAYS)
            injected = {
                (spec.name, day)
                for spec, _ in data
                for ago, _ in spec.incidents
                if (day := to - timedelta(days=ago)) >= start
            }
            flagged = [
                (spec.name, a)
                for spec, points in data
                for a in detect([p for p in points if p[0] >= history_from], start, to, spec.direction)
            ]
            found = {(name, a.day) for name, a in flagged} & injected
            extra = tuple((name, a) for name, a in flagged if (name, a.day) not in injected)
            rows.append(DemoView(to, view, len(injected), len(found), extra))
    return rows


# ---- report ---------------------------------------------------------------------------------


def _demo_cell(v: DemoView) -> str:
    cell = f"{v.found}/{v.injected}"
    for name, a in v.extra:
        cell += f" +{name} {a.kind} ({a.severity}, {'bad' if a.bad else 'good'} direction)"
    return cell


def _demo_summary(views: list[DemoView]) -> str:
    parts = []
    for days in DEMO_VIEWS:
        mine = [v for v in views if v.days == days]
        found = "/".join(sorted({f"{v.found}/{v.injected}" for v in mine}))
        clean = sum(not v.extra for v in mine)
        part = f"{days}d: {found} found, no extra alerts on {clean}/{len(mine)} load days"
        if clean < len(mine):
            bad = sum(a.bad for v in mine for _, a in v.extra)
            part += f" (max {max(len(v.extra) for v in mine)} extra, {bad} in the bad direction)"
        parts.append(part)
    return "; ".join(parts)


def main() -> None:
    started = time.perf_counter()
    rows: list[tuple[str, str]] = []

    flagged, checks = false_alarms()
    rows.append(
        ("False alarms on incident-free data", f"{flagged} in {checks:,} day-checks ({flagged / checks:.3%})")
    )

    for drop in DROPS:
        hits, trials = drop_detection(drop)
        rows.append((f"{drop:.0%} drop detected", f"{hits / trials:.2%} ({hits:,} / {trials:,})"))

    # The demo ends on the day it is loaded, and the weekday decides where weekends fall.
    views = demo_views(END - timedelta(days=k) for k in range(7))
    rows.append(("Demo data, 30 / 90 / 180-day views", _demo_summary(views)))

    fallback = sparse_alerts_per_window()
    with mock.patch.object(anomaly, "_sigma", _mad_only_sigma):
        mad_only = sparse_alerts_per_window()
    rows.append(
        (
            "Sparse 0/1 counts (P(1) = 25%)",
            f"{fallback:.2f} alerts per 30 days (MAD only, without the fallback: {mad_only:.2f})",
        )
    )

    print("| Measurement | Result |")
    print("|---|---|")
    for name, result in rows:
        print(f"| {name} | {result} |")

    print("\n| Demo loaded on | 30-day view | 90-day view | 180-day view |")
    print("|---|---|---|---|")
    for to in sorted({v.to for v in views}, reverse=True):
        cells = [_demo_cell(v) for v in views if v.to == to]
        print(f"| {to:%a %Y-%m-%d} | {' | '.join(cells)} |")

    elapsed = time.perf_counter() - started
    print(f"\nSynthetic: {len(SEEDS)} seeded series x {WINDOW_DAYS} days each; ran in {elapsed:.0f}s")


if __name__ == "__main__":
    main()
