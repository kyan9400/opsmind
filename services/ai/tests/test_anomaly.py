import random
from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.anomaly import detect
from app.config import settings
from app.insights import KpiDelta, NamedAnomaly, fmt_value, template_summary
from app.main import app
from scripts.detector_benchmark import demo_views

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
        "kpis": [{"name": "Support tickets", "direction": "down", "current": 110, "previous": 100, "delta_pct": 10.0}],
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


# ---- regressions from the Week 3 review -------------------------------------------------


def test_young_metrics_are_not_scored_against_mixed_weekdays():
    # 3-4 weeks of history used to fall back to a non-seasonal 28-day baseline: every weekend was a "drop".
    for days in (21, 28, 35):
        for seed in range(20):
            assert detect(seasonal_series(days=days, seed=seed), START, END) == [], (days, seed)


def test_sparse_count_metrics_do_not_flood_with_alerts():
    # e.g. refunds: 0 on most days, 1 on ~25% of days. MAD is 0 there; the mean-AD fallback keeps z sane.
    rnd = random.Random(7)
    total = 0
    for _ in range(20):
        series = [(END - timedelta(days=i), 1.0 if rnd.random() < 0.25 else 0.0) for i in range(86)]
        found = detect(series, START, END)
        total += len(found)
        assert all(abs(a.z) < 99 for a in found)
    assert total / 20 <= 2.5  # was ~9.7 per 30 days, all "high"


def test_first_event_on_an_all_zero_baseline_is_capped_not_infinite():
    zeros = [(END - timedelta(days=i), 0.0) for i in range(60)]
    [a] = detect([(d, 3.0 if d == END else v) for d, v in zeros], START, END)
    assert a.z == 99.0 and a.deviation_pct is None and a.severity == "high"


def test_demo_data_incidents_are_found_whatever_day_it_is_loaded():
    # The demo ends on the day it is loaded, so every weekday shifts where its weekends fall.
    # Full measurements: python -m scripts.detector_benchmark
    views = demo_views(END - timedelta(days=k) for k in range(7))
    assert {(v.days, v.injected) for v in views} == {(30, 5), (90, 6), (180, 6)}
    assert all(v.found == v.injected for v in views)
    assert not any(v.extra for v in views if v.days == 30)
    # Longer views may add a medium alert on some weekdays, never one in the bad direction.
    assert not any(a.bad or a.severity == "high" for v in views for _, a in v.extra)


def test_fmt_value_rounds_half_away_from_zero_like_intl():
    assert fmt_value(14612.5, "$") == "$14,613"
    assert fmt_value(1234.5, "$") == "$1,235"
    assert fmt_value(12.25, "h") == "12.3 h"
    assert fmt_value(0.125) == "0.13"


def test_summary_describes_real_anomalies_even_when_zero_baseline_ones_rank_first():
    day = date(2026, 9, 14)
    sparse = [NamedAnomaly("Refunds", "", day - timedelta(days=i), 1, 0, None, 99.0, "spike", True) for i in range(5)]
    revenue = NamedAnomaly("Revenue", "$", day, 6000, 12000, -50.0, -9.0, "drop", True)
    s = template_summary([], [*sparse, revenue])
    assert "Revenue on Sep 14 was 50% below expected" in s


def test_unchanged_kpis_are_not_reported_as_down():
    s = template_summary([KpiDelta("Revenue", "$", "up", 100, 100, 0.0)], [])
    assert "down" not in s and "worth watching" not in s
