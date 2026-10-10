"""OpsMind AI service: document ingestion and cited question answering.

Called only by the Node API / worker (shared internal token), never by browsers.
"""

import hmac
import logging
import time
import uuid
from datetime import date
from typing import Literal

import numpy as np
import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field, model_validator

from .anomaly import detect
from .chunking import chunk_text
from .config import settings
from .db import get_pool
from .embeddings import embed_batched, get_embedder
from .extract import DocumentOverLimit, extract_text
from .insights import KpiDelta, NamedAnomaly, summarize
from .llm import NO_ANSWER, Turn, answer_with_fallback, build_retrieval_query, cited_numbers
from .retrieval import hybrid_search
from .telemetry import ANOMALIES, EMBED_DURATION, metrics_middleware, metrics_response, setup_tracing, timed

log = logging.getLogger("opsmind.ai")
app = FastAPI(title="OpsMind AI", version="0.4.0")
app.middleware("http")(metrics_middleware)
setup_tracing(app)


def metrics() -> Response:
    return metrics_response()


# Internal only: the production proxy never routes to this service. Hosts with nothing in front to keep
# it private (Vercel) set METRICS_PUBLIC=false, and the route does not exist (404).
if settings.metrics_public:
    app.add_api_route("/metrics", metrics, methods=["GET"], include_in_schema=False)


def internal_auth(x_internal_token: str = Header(default="")) -> None:
    if not hmac.compare_digest(x_internal_token, settings.internal_token):
        raise HTTPException(status_code=401, detail="invalid internal token")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "embed": settings.embed_provider, "llm": settings.llm_provider}


class IngestRequest(BaseModel):
    document_id: uuid.UUID


def _failed(pool: ConnectionPool, document_id: uuid.UUID, error: str) -> HTTPException:
    """Record on the document why it could not be indexed. The 422 tells the API not to retry."""
    with pool.connection() as conn:
        conn.execute(
            "UPDATE documents SET status = 'failed', error = %s, updated_at = now() WHERE id = %s",
            (error[:500], document_id),
        )
    log.warning("ingest failed for %s: %s", document_id, error)
    return HTTPException(status_code=422, detail=error[:500])


@app.post("/v1/ingest", dependencies=[Depends(internal_auth)])
def ingest(req: IngestRequest) -> dict:
    started = time.perf_counter()
    pool = get_pool()
    with pool.connection() as conn:
        row = conn.execute(
            """UPDATE documents SET status = 'processing', error = NULL, updated_at = now()
                WHERE id = %s RETURNING tenant_id, mime_type, content""",
            (req.document_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="document not found")
    tenant_id, mime_type, content = row

    try:
        text = extract_text(
            bytes(content),
            mime_type,
            max_chars=settings.ingest_max_chars,
            max_pdf_pages=settings.ingest_max_pdf_pages,
            max_pdf_content_bytes=settings.ingest_max_pdf_content_mb * 1_000_000,
            max_pdf_seconds=settings.ingest_max_pdf_seconds,
        )
        chunks = chunk_text(text)
        if not chunks:
            raise ValueError("no extractable text in document")
        # Chunks, not characters, are what the database stores; text that breaks into unusually short
        # chunks would otherwise get past the character limit with several times the rows.
        if 0 < settings.ingest_max_chunks < len(chunks):
            raise DocumentOverLimit(
                f"document too long: {len(chunks)} chunks (limit {settings.ingest_max_chunks})"
            )
        with timed(EMBED_DURATION, provider=settings.embed_provider):
            vectors = embed_batched(get_embedder(), [c.text for c in chunks])
    except Exception as exc:  # bad file or provider failure: record it on the document
        raise _failed(pool, req.document_id, str(exc)) from exc

    # Replace chunks atomically so re-indexing never leaves a half-indexed document.
    try:
        with pool.connection() as conn, conn.transaction():
            conn.execute("DELETE FROM chunks WHERE document_id = %s", (req.document_id,))
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO chunks (document_id, tenant_id, chunk_index, content, embedding)
                       VALUES (%s, %s, %s, %s, %s)""",
                    [
                        (req.document_id, tenant_id, c.index, c.text, np.asarray(v, dtype=np.float32))
                        for c, v in zip(chunks, vectors)
                    ],
                )
            conn.execute(
                """UPDATE documents SET status = 'ready', chunk_count = %s, updated_at = now()
                    WHERE id = %s""",
                (len(chunks), req.document_id),
            )
    except (ValueError, psycopg.DataError) as exc:
        # Text the database will not take (psycopg raises UnicodeEncodeError before sending it) fails
        # the same way on every retry. Anything else, such as a lost connection, stays a 500 the API retries.
        raise _failed(pool, req.document_id, f"could not store the document's text: {exc}") from exc

    return {
        "document_id": str(req.document_id),
        "chunks": len(chunks),
        "ms": round((time.perf_counter() - started) * 1000),
    }


class HistoryTurn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    answer: str = Field(max_length=2000)


class AskRequest(BaseModel):
    tenant_id: uuid.UUID
    question: str = Field(min_length=1, max_length=500)
    top_k: int = Field(default=5, ge=1, le=10)
    # Oldest first. Bounded so a long chat cannot blow up the prompt (and free-tier token budgets).
    history: list[HistoryTurn] = Field(default_factory=list, max_length=4)


class Citation(BaseModel):
    n: int
    document_id: str
    title: str
    chunk_index: int
    snippet: str
    score: float
    cited: bool


class AskResponse(BaseModel):
    answer: str
    # False when the sources hold no answer: the no-answer reply, or one that cites none of them. The
    # no-answer text is English (a model's reply is in the question's language), so clients that show
    # another language use this flag, not the text.
    found: bool
    citations: list[Citation]
    provider: str
    retrieval_query: str
    ms: int


@app.post("/v1/ask", response_model=AskResponse, dependencies=[Depends(internal_auth)])
def ask(req: AskRequest) -> AskResponse:
    started = time.perf_counter()
    history = [Turn(t.question, t.answer) for t in req.history]
    query = build_retrieval_query(req.question, history)
    with timed(EMBED_DURATION, provider=settings.embed_provider):
        [qvec] = get_embedder().embed([query])
    with get_pool().connection() as conn:
        hits = hybrid_search(conn, str(req.tenant_id), query, qvec, req.top_k)

    answer, provider = answer_with_fallback(req.question, hits, history, query)

    used = cited_numbers(answer, len(hits))
    return AskResponse(
        answer=answer,
        found=answer != NO_ANSWER and bool(used),
        citations=[
            Citation(
                n=i,
                document_id=h.document_id,
                title=h.title,
                chunk_index=h.chunk_index,
                snippet=h.content[:400],
                score=round(h.score, 5),
                cited=i in used,
            )
            for i, h in enumerate(hits, 1)
        ],
        provider=provider,
        retrieval_query=query,
        ms=round((time.perf_counter() - started) * 1000),
    )


class SeriesPoint(BaseModel):
    day: date
    value: float


class MetricSeries(BaseModel):
    id: str = Field(max_length=64)
    name: str = Field(max_length=80)
    unit: str = Field(default="", max_length=12)
    direction: Literal["up", "down"] = "up"
    points: list[SeriesPoint] = Field(default_factory=list, max_length=2000)


class KpiIn(BaseModel):
    name: str = Field(max_length=80)
    unit: str = Field(default="", max_length=12)
    direction: Literal["up", "down"] = "up"
    current: float | None = None
    previous: float | None = None
    delta_pct: float | None = None


class InsightsRequest(BaseModel):
    start: date
    end: date
    metrics: list[MetricSeries] = Field(max_length=100)
    kpis: list[KpiIn] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def _range(self) -> "InsightsRequest":
        if self.end < self.start:
            raise ValueError("end must not be before start")
        return self


class AnomalyOut(BaseModel):
    metric_id: str
    metric: str
    unit: str
    day: date
    value: float
    expected: float
    deviation_pct: float | None
    z: float
    severity: Literal["medium", "high"]
    kind: Literal["spike", "drop"]
    bad: bool


class InsightsResponse(BaseModel):
    anomalies: list[AnomalyOut]
    summary: str
    provider: str
    ms: int


@app.post("/v1/insights", response_model=InsightsResponse, dependencies=[Depends(internal_auth)])
def insights(req: InsightsRequest) -> InsightsResponse:
    started = time.perf_counter()
    anomalies = [
        AnomalyOut(metric_id=m.id, metric=m.name, unit=m.unit, **a.__dict__)
        for m in req.metrics
        for a in detect([(p.day, p.value) for p in m.points], req.start, req.end, m.direction)
    ]
    for a in anomalies:
        ANOMALIES.labels(service="ai", severity=a.severity).inc()
    # Newest first; within a day, the strongest signal first.
    anomalies.sort(key=lambda a: (a.day, abs(a.z)), reverse=True)

    summary, provider = summarize(
        [KpiDelta(**k.model_dump()) for k in req.kpis],
        [
            NamedAnomaly(
                metric=a.metric,
                unit=a.unit,
                day=a.day,
                value=a.value,
                expected=a.expected,
                deviation_pct=a.deviation_pct,
                z=a.z,
                kind=a.kind,
                bad=a.bad,
            )
            for a in anomalies
        ],
    )
    return InsightsResponse(
        anomalies=anomalies,
        summary=summary,
        provider=provider,
        ms=round((time.perf_counter() - started) * 1000),
    )
