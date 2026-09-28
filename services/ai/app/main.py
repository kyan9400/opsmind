"""OpsMind AI service: document ingestion and cited question answering.

Called only by the Node API / worker (shared internal token), never by browsers.
"""

import hmac
import logging
import time
import uuid

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .chunking import Chunk, chunk_text
from .config import settings
from .db import get_pool
from .embeddings import embed_batched, get_embedder
from .extract import extract_text
from .llm import cited_numbers, generate_answer
from .retrieval import hybrid_search

log = logging.getLogger("opsmind.ai")
app = FastAPI(title="OpsMind AI", version="0.2.0")


def internal_auth(x_internal_token: str = Header(default="")) -> None:
    if not hmac.compare_digest(x_internal_token, settings.internal_token):
        raise HTTPException(status_code=401, detail="invalid internal token")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "embed": settings.embed_provider, "llm": settings.llm_provider}


class ChunkRequest(BaseModel):
    text: str = Field(min_length=1)
    max_chars: int = Field(default=800, ge=100, le=4000)
    overlap: int = Field(default=100, ge=0, le=1000)


@app.post("/v1/chunk", response_model=list[Chunk])
def chunk(req: ChunkRequest) -> list[Chunk]:
    return chunk_text(req.text, req.max_chars, req.overlap)


class IngestRequest(BaseModel):
    document_id: uuid.UUID


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
        chunks = chunk_text(extract_text(bytes(content), mime_type))
        if not chunks:
            raise ValueError("no extractable text in document")
        vectors = embed_batched(get_embedder(), [c.text for c in chunks])
    except Exception as exc:  # bad file or provider failure: record it on the document
        with pool.connection() as conn:
            conn.execute(
                "UPDATE documents SET status = 'failed', error = %s, updated_at = now() WHERE id = %s",
                (str(exc)[:500], req.document_id),
            )
        log.warning("ingest failed for %s: %s", req.document_id, exc)
        raise HTTPException(status_code=422, detail=str(exc)[:500]) from exc

    # Replace chunks atomically so re-indexing never leaves a half-indexed document.
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

    return {
        "document_id": str(req.document_id),
        "chunks": len(chunks),
        "ms": round((time.perf_counter() - started) * 1000),
    }


class AskRequest(BaseModel):
    tenant_id: uuid.UUID
    question: str = Field(min_length=1, max_length=500)
    top_k: int = Field(default=5, ge=1, le=10)


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
    citations: list[Citation]
    provider: str
    ms: int


@app.post("/v1/ask", response_model=AskResponse, dependencies=[Depends(internal_auth)])
def ask(req: AskRequest) -> AskResponse:
    started = time.perf_counter()
    [qvec] = get_embedder().embed([req.question])
    with get_pool().connection() as conn:
        hits = hybrid_search(conn, str(req.tenant_id), req.question, qvec, req.top_k)

    try:
        answer = generate_answer(req.question, hits)
    except Exception as exc:
        log.exception("llm provider failed")
        raise HTTPException(status_code=502, detail=f"llm provider error: {exc}") from exc

    used = cited_numbers(answer, len(hits))
    return AskResponse(
        answer=answer,
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
        provider=settings.llm_provider,
        ms=round((time.perf_counter() - started) * 1000),
    )
