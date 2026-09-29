from datetime import date, timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.telemetry import setup_tracing

client = TestClient(app)


def test_metrics_use_route_templates_and_service_label():
    client.get("/health")
    client.post(
        "/v1/insights",
        json={"start": "2026-09-01", "end": "2026-09-30", "metrics": []},
        headers={"x-internal-token": settings.internal_token},
    )
    client.get("/v1/documents/3f1c9b2e")  # no such route
    body = client.get("/metrics").text
    assert 'http_request_duration_seconds_count{method="GET",route="/health",service="ai",status_code="200"}' in body
    assert 'http_request_duration_seconds_count{method="POST",route="/v1/insights",service="ai",status_code="200"}' in body
    # Unknown paths share one label, so probing random URLs can't grow the series count.
    assert 'route="unmatched"' in body and "3f1c9b2e" not in body
    assert 'route="/metrics"' not in body  # scrapes don't measure themselves


def test_anomalies_are_counted_by_severity():
    end = date(2026, 9, 26)
    points = [{"day": (end - timedelta(days=i)).isoformat(), "value": 100.0} for i in range(60)]
    points[0]["value"] = 400.0  # a spike on the last day
    before = client.get("/metrics").text.count("opsmind_anomalies_detected_total{")
    res = client.post(
        "/v1/insights",
        json={"start": (end - timedelta(days=6)).isoformat(), "end": end.isoformat(), "metrics": [{"id": "m", "name": "Tickets", "points": points}]},
        headers={"x-internal-token": settings.internal_token},
    )
    assert res.status_code == 200 and len(res.json()["anomalies"]) == 1
    body = client.get("/metrics").text
    assert 'opsmind_anomalies_detected_total{service="ai",severity="high"}' in body
    assert body.count("opsmind_anomalies_detected_total{") >= max(before, 1)


def test_tracing_is_off_by_default_and_instruments_when_enabled(monkeypatch):
    plain = FastAPI()
    setup_tracing(plain)
    assert not getattr(plain, "_is_instrumented_by_opentelemetry", False)

    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
    traced = FastAPI()
    setup_tracing(traced)
    assert getattr(traced, "_is_instrumented_by_opentelemetry", False)
