"""KPI anomaly detection with a seasonal robust z-score.

Each day's expected value is the median of the *same weekday* over the previous 8 weeks
(so normal weekend dips are not flagged); its noise level is the spread of every day in that
window against its own weekday median. A day is only scored once its weekday has at least
4 prior points: a non-seasonal fallback would compare weekends with weekdays and raise false
alarms. Median/MAD instead of mean/stddev keeps the baseline stable when the history itself
contains incidents.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from statistics import median
from typing import Literal

Z_THRESHOLD = 3.5  # Iglewicz & Hoaglin's recommended cut-off for modified z-scores
HIGH_SEVERITY_Z = 6.0
Z_CAP = 99.0  # a first-ever event on an all-zero baseline has no finite z; report it as "very high"
MAD_TO_SIGMA = 1.4826  # scales MAD to a standard deviation for normal data
MEAN_AD_TO_SIGMA = 1.2533  # scales mean absolute deviation to a standard deviation
MIN_SCALE_FRACTION = 0.01  # never treat moves smaller than ~1% of the baseline as significant
WEEKS_LOOKBACK = 8
MIN_WEEKLY_POINTS = 4


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


def _sigma(xs: list[float]) -> float:
    """Robust standard deviation: MAD-based, or mean-absolute-deviation-based when MAD is 0.

    MAD collapses to 0 when over half the residuals are identical (sparse counts such as refunds
    that are 0 on most days); every non-zero day would then look infinitely unusual.
    """
    m = median(xs)
    mad = median(abs(x - m) for x in xs)
    if mad > 0:
        return MAD_TO_SIGMA * mad
    return MEAN_AD_TO_SIGMA * sum(abs(x - m) for x in xs) / len(xs)


def _model(values: dict[date, float], day: date) -> tuple[float, float] | None:
    """Return (expected, noise sigma) for `day` from history strictly before it, or None if too little."""
    window = [d for k in range(1, WEEKS_LOOKBACK * 7 + 1) if (d := day - timedelta(days=k)) in values]
    same_weekday = [values[d] for d in window if d.weekday() == day.weekday()]
    if len(same_weekday) < MIN_WEEKLY_POINTS:
        return None

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
        return expected, _sigma([v / m - 1 for v, m in loo]) * expected
    return expected, _sigma([v - m for v, m in loo])


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
        z = max(-Z_CAP, min(Z_CAP, (value - expected) / scale))
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
