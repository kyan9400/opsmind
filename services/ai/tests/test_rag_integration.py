"""End-to-end ingest + ask against a real Postgres with pgvector (CI runs this).

Requires the schema from apps/api/migrations. Enable with INTEGRATION=1.
"""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

import app.llm as llm
from app.config import Settings, settings
from app.db import get_pool
from app.main import app

pytestmark = pytest.mark.skipif(os.environ.get("INTEGRATION") != "1", reason="needs Postgres (INTEGRATION=1)")

HEADERS = {"x-internal-token": settings.internal_token}

POLICY = """Refund policy

Customers can request a full refund within 30 days of purchase.
After 30 days, only store credit is offered.

Shipping policy

Orders ship within 2 business days from our Kazan warehouse.
"""


def make_tenant_with_document(conn, name: str, body: str) -> tuple[str, str]:
    tenant_id = conn.execute("INSERT INTO tenants (name) VALUES (%s) RETURNING id", (name,)).fetchone()[0]
    doc_id = conn.execute(
        """INSERT INTO documents (tenant_id, title, filename, mime_type, size_bytes, content)
           VALUES (%s, %s, 'policy.txt', 'text/plain', %s, %s) RETURNING id""",
        (tenant_id, f"{name} policies", len(body), body.encode()),
    ).fetchone()[0]
    return str(tenant_id), str(doc_id)


def test_ingest_then_ask_with_citations_and_tenant_isolation():
    client = TestClient(app)
    with get_pool().connection() as conn:
        tenant_a, doc_a = make_tenant_with_document(conn, "Acme", POLICY)
        tenant_b, _ = make_tenant_with_document(conn, "Globex", "Our cafeteria opens at 9am.")

    res = client.post("/v1/ingest", json={"document_id": doc_a}, headers=HEADERS)
    assert res.status_code == 200, res.text
    assert res.json()["chunks"] >= 1

    with get_pool().connection() as conn:
        status, count = conn.execute("SELECT status, chunk_count FROM documents WHERE id = %s", (doc_a,)).fetchone()
    assert status == "ready" and count >= 1

    ask = client.post(
        "/v1/ask",
        json={"tenant_id": tenant_a, "question": "How many days do customers have to request a refund?"},
        headers=HEADERS,
    ).json()
    assert "30" in ask["answer"]
    assert any(c["cited"] and c["document_id"] == doc_a for c in ask["citations"])

    # Tenant B must never retrieve tenant A's chunks.
    other = client.post(
        "/v1/ask", json={"tenant_id": tenant_b, "question": "refund within 30 days"}, headers=HEADERS
    ).json()
    assert all(c["document_id"] != doc_a for c in other["citations"])


def test_empty_document_is_marked_failed():
    client = TestClient(app)
    with get_pool().connection() as conn:
        _, doc = make_tenant_with_document(conn, "Initech", "   \n\n  ")
    res = client.post("/v1/ingest", json={"document_id": doc}, headers=HEADERS)
    assert res.status_code == 422
    with get_pool().connection() as conn:
        status, error = conn.execute("SELECT status, error FROM documents WHERE id = %s", (doc,)).fetchone()
    assert status == "failed" and "no extractable text" in error


def test_document_over_the_text_limit_is_marked_failed():
    client = TestClient(app)
    with get_pool().connection() as conn:
        _, doc = make_tenant_with_document(conn, "Hooli", "word " * 50_000)  # 250,000 characters
    res = client.post("/v1/ingest", json={"document_id": doc}, headers=HEADERS)
    assert res.status_code == 422 and res.json()["detail"].startswith("document too long")
    with get_pool().connection() as conn:
        status, error, chunks = conn.execute(
            "SELECT d.status, d.error, (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) "
            "FROM documents d WHERE d.id = %s",
            (doc,),
        ).fetchone()
    assert status == "failed" and error.startswith("document too long") and chunks == 0


def test_llm_daily_cap_is_counted_atomically_in_the_database(monkeypatch):
    monkeypatch.setattr(llm, "get_pool", get_pool)  # the llm_usage table, not the tests' in-memory one
    monkeypatch.setenv("LLM_DAILY_MAX", "5")
    monkeypatch.setattr(llm, "settings", Settings())
    today = "(now() AT TIME ZONE 'UTC')::date"
    with get_pool().connection() as conn:
        conn.execute(f"DELETE FROM llm_usage WHERE day = {today}")

    def take() -> bool:
        try:
            llm.count_llm_call()
            return True
        except llm.DailyLimitReached:
            return False

    # Concurrent instances: exactly the cap gets through, never one more.
    with ThreadPoolExecutor(max_workers=6) as pool:
        taken = list(pool.map(lambda _: take(), range(12)))
    assert taken.count(True) == 5
    with get_pool().connection() as conn:
        assert conn.execute(f"SELECT calls FROM llm_usage WHERE day = {today}").fetchone() == (5,)
        conn.execute(f"DELETE FROM llm_usage WHERE day = {today}")
