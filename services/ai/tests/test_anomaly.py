import random
from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.anomaly import detect
from app.config import settings
from app.insights import KpiDelta, NamedAnomaly, fmt_value, template_summary
from app.main import app

END = date(2026, 9, 26)
START = END - timedelta(days=29)


def seasonal_series(days: int = 120, base: float = 1000, weekend: float = 0.5, noise: float = 0.05, seed: int = 1):
    """Weekday/weekend pattern with noise: a realistic series with *no* incidents."""
    rnd = random.Random(seed)
    out = []
    for i in range(days):
        d = END - timedelta(days=days - 1 - i)
        seasonal = weekend if d.weekday() >= 5 else 1.0
        out.append((d, base * seasonal * (1 + rnd.uniform(-noise, noise))))
    return out


def with_incident(series, day: date, factor: float):
    return [(d, v * factor if d == day else v) for d, v in series]


def test_weekly_seasonality_is_not_flagged():
    # Weekends at 50% of weekdays must not look like drops: baselines are same-weekday.
    for seed in range(20):
        assert detect(seasonal_series(seed=seed), START, END) == []


def test_drop_in_up_metric_is_bad():
    day = END - timedelta(days=12)
    [a] = detect(with_incident(seasonal_series(), day, 0.5), START, END, direction="up")
    assert a.day == day and a.kind == "drop" and a.bad
    assert -55 < a.deviation_pct < -45
    assert a.severity == "high"


def test_spike_in_down_metric_is_bad_but_spike_in_up_metric_is_not():
    day = END - timedelta(days=3)
    series = with_incident(seasonal_series(), day, 2.5)
    [down] = detect(series, START, END, direction="down")
    [up] = detect(series, START, END, direction="up")
    assert down.kind == up.kind == "spike"
    assert down.bad and not up.bad


def test_only_days_inside_the_window_are_reported():
    early = START - timedelta(days=10)
    series = with_incident(seasonal_series(), early, 0.2)
    assert detect(series, START, END) == []


def test_not_enough_history_means_no_verdict():
    short = seasonal_series(days=10)
    assert detect(with_incident(short, END, 0.1), END - timedelta(days=9), END) == []


def test_flat_series_ignores_tiny_moves_but_catches_real_ones():
    flat = [(END - timedelta(days=i), 100.0) for i in range(60)]
    assert detect([(d, 100.5 if d == END else v) for d, v in flat], START, END) == []
    [a] = detect([(d, 130.0 if d == END else v) for d, v in flat], START, END)
    assert a.value == 130.0 and a.expected == 100.0


def test_fmt_value_matches_the_api_formatting():
    assert fmt_value(12400, "$") == "$12,400"
    assert fmt_value(91.24, "%") == "91.2%"
    assert fmt_value(6.5, "h") == "6.5 h"
    assert fmt_value(-1200, "$") == "-$1,200"
    assert fmt_value(None) == "—"


def test_template_summary_mentions_top_anomaly_and_shared_day():
    day = date(2026, 9, 14)
    anomalies = [
        NamedAnomaly("Revenue", "$", day, 6000, 12000, -50.0, -9.1, "drop", True),
        NamedAnomaly("Orders", "", day, 90, 180, -50.0, -8.0, "drop", True),
    ]
    kpis = [KpiDelta("Revenue", "$", "up", 300000, 280000, 7.1)]
    s = template_summary(kpis, anomalies)
    assert "2 unusual movements" in s
    assert "Revenue on Sep 14 was 50% below expected ($6,000 vs ~$12,000)" in s
    assert "Orders and Revenue moved together on Sep 14" in s
    assert "Revenue, up 7.1% (good)" in s


def test_template_summary_without_anomalies():
    assert template_summary([], []).startswith("No unusual movements")


def test_insights_endpoint():
    client = TestClient(app)
    day = END - timedelta(days=5)
    series = with_incident(seasonal_series(), day, 3.0)
    body = {
        "start": START.isoformat(),
        "end": END.isoformat(),
        "metrics": [
            {
                "id": "m1",
                "name": "Support tickets",
                "direction": "down",
                "points": [{"day": d.isoformat(), "value": v} for d, v in series],
            }
        ],
        "kpis": [{"name": "Support tickets", "direction": "down", "current": 1, "previous": 1, "delta_pct": 0}],
    }
    assert client.post("/v1/insights", json=body).status_code == 401
    res = client.post("/v1/insights", json=body, headers={"x-internal-token": settings.internal_token})
    assert res.status_code == 200, res.text
    data = res.json()
    assert [(a["metric_id"], a["day"], a["bad"]) for a in data["anomalies"]] == [("m1", day.isoformat(), True)]
    assert data["provider"] == "template"
    assert "Support tickets" in data["summary"]

    bad_range = {**body, "start": END.isoformat(), "end": START.isoformat()}
    assert client.post("/v1/insights", json=bad_range, headers={"x-internal-token": settings.internal_token}).status_code == 422
