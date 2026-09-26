"""KPI anomaly detection with a seasonal robust z-score.

Each day's expected value is the median of the *same weekday* over the previous 8 weeks
(so normal weekend dips are not flagged); its noise level is the MAD of every day in that
window against its own weekday median. Without enough weekly history it falls back to the
previous 28 days. Median/MAD instead of mean/stddev keeps the baseline stable when the
history itself contains incidents.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from statistics import median
from typing import Literal

Z_THRESHOLD = 3.5  # Iglewicz & Hoaglin's recommended cut-off for modified z-scores
HIGH_SEVERITY_Z = 6.0
MAD_TO_SIGMA = 1.4826  # scales MAD to a standard deviation for normal data
MIN_SCALE_FRACTION = 0.01  # never treat moves smaller than ~1% of the baseline as significant
WEEKS_LOOKBACK = 8
MIN_WEEKLY_POINTS = 4
ROLLING_DAYS = 28
MIN_ROLLING_POINTS = 14


@dataclass(frozen=True)
class Anomaly:
    day: date
    value: float
    expected: float
    deviation_pct: float | None
    z: float
    severity: Literal["medium", "high"]
    kind: Literal["spike", "drop"]
    bad: bool


def _mad(xs: list[float]) -> float:
    m = median(xs)
    return median(abs(x - m) for x in xs)


def _model(values: dict[date, float], day: date) -> tuple[float, float] | None:
    """Return (expected, scale) for `day` from history strictly before it, or None if too little."""
    window = [d for k in range(1, WEEKS_LOOKBACK * 7 + 1) if (d := day - timedelta(days=k)) in values]
    same_weekday = [values[d] for d in window if d.weekday() == day.weekday()]

    if len(same_weekday) >= MIN_WEEKLY_POINTS:
        expected = median(same_weekday)
        # The noise level comes from *every* day in the window (~56 samples), not just the 8
        # same-weekday points: a MAD of 8 values is itself too noisy and causes false alarms.
        # Residuals are leave-one-out (each day vs the median of the *other* days of its weekday),
        # which is exactly how a new day is scored; in-sample residuals underestimate the noise.
        by_weekday: dict[int, list[date]] = defaultdict(list)
        for d in window:
            by_weekday[d.weekday()].append(d)
        loo: list[tuple[float, float]] = []  # (value, expected from the other same-weekday days)
        for days in by_weekday.values():
            if len(days) < 3:
                continue
            for d in days:
                loo.append((values[d], median(values[o] for o in days if o != d)))
        if not loo:
            return None
        if expected > 0 and all(m > 0 for _, m in loo):
            # Relative residuals, so weekend and weekday noise are comparable despite different levels.
            scale = MAD_TO_SIGMA * _mad([v / m - 1 for v, m in loo]) * expected
        else:
            scale = MAD_TO_SIGMA * _mad([v - m for v, m in loo])
        return expected, scale

    rolling = [values[d] for d in window[:ROLLING_DAYS]]
    if len(rolling) >= MIN_ROLLING_POINTS:
        return median(rolling), MAD_TO_SIGMA * _mad(rolling)
    return None


def detect(
    points: list[tuple[date, float]],
    start: date,
    end: date,
    direction: Literal["up", "down"] = "up",
    threshold: float = Z_THRESHOLD,
) -> list[Anomaly]:
    """Return anomalies for days in [start, end]. Days before `start` are history only."""
    values = dict(points)
    found: list[Anomaly] = []
    for day in sorted(d for d in values if start <= d <= end):
        model = _model(values, day)
        if model is None:
            continue
        expected, spread = model
        scale = max(spread, MIN_SCALE_FRACTION * abs(expected), 1e-9)
        value = values[day]
        z = (value - expected) / scale
        if abs(z) < threshold:
            continue
        kind: Literal["spike", "drop"] = "spike" if z > 0 else "drop"
        found.append(
            Anomaly(
                day=day,
                value=value,
                expected=round(expected, 4),
                deviation_pct=round((value - expected) / abs(expected) * 100, 1) if expected else None,
                z=round(z, 2),
                severity="high" if abs(z) >= HIGH_SEVERITY_Z else "medium",
                kind=kind,
                bad=(kind == "drop") == (direction == "up"),
            )
        )
    return found
