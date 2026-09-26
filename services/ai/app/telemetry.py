"""Prometheus metrics and optional OpenTelemetry tracing for the AI service."""

from __future__ import annotations

import os
import time
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager

from fastapi import FastAPI, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

SERVICE = "ai"
# 5ms cache-friendly calls up to 30s CPU-bound local LLMs.
LATENCY_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30)

HTTP_DURATION = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency by route",
    ["service", "method", "route", "status_code"],
    buckets=LATENCY_BUCKETS,
)
EMBED_DURATION = Histogram(
    "opsmind_ai_embed_duration_seconds",
    "Time to embed one batch of texts",
    ["service", "provider"],
    buckets=LATENCY_BUCKETS,
)
LLM_DURATION = Histogram(
    "opsmind_ai_llm_duration_seconds",
    "LLM call latency (RAG answers and KPI summaries)",
    ["service", "provider", "kind"],
    buckets=LATENCY_BUCKETS,
)
ANOMALIES = Counter(
    "opsmind_anomalies_detected_total",
    "KPI anomalies detected, by severity",
    ["service", "severity"],
)


@contextmanager
def timed(histogram: Histogram, **labels: str) -> Iterator[None]:
    start = time.perf_counter()
    try:
        yield
    finally:
        histogram.labels(service=SERVICE, **labels).observe(time.perf_counter() - start)


async def metrics_middleware(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    if request.url.path == "/metrics":
        return await call_next(request)
    start = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        # The route *template* (/v1/ask), never the raw path, keeps label cardinality bounded.
        route = getattr(request.scope.get("route"), "path", "unmatched")
        HTTP_DURATION.labels(SERVICE, request.method, route, str(status)).observe(time.perf_counter() - start)


def metrics_response() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


def setup_tracing(app: FastAPI) -> None:
    """Export traces over OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise do nothing."""
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(
        resource=Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", "opsmind-ai")})
    )
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    # Incoming requests continue the caller's trace (traceparent from the API/worker);
    # outgoing LLM/embedding calls and every SQL query become child spans.
    FastAPIInstrumentor.instrument_app(app, excluded_urls="health,metrics")
    HTTPXClientInstrumentor().instrument()
    PsycopgInstrumentor().instrument(enable_commenter=False)
