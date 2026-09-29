"""Retrieval modes: SQL shape without a database, behaviour against Postgres with INTEGRATION=1."""

import os

import pytest

from app.retrieval import HYBRID_SQL, SEARCH_SQL, hybrid_search


class FakeConn:
    """Records the query; returns one canned row so result mapping is exercised too."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def execute(self, sql, params):
        self.calls.append((sql, params))
        return self

    def fetchall(self):
        return [(7, "doc-uuid", "Refunds", 0, "Refund within 30 days.", 0.0164)]


def test_default_mode_is_hybrid_and_uses_both_retrievers():
    conn = FakeConn()
    [hit] = hybrid_search(conn, "t1", "refund", [0.1] * 768, k=5)
    sql, params = conn.calls[0]
    assert sql is HYBRID_SQL is SEARCH_SQL["hybrid"]
    assert "<=>" in sql and "to_tsquery" in sql
    assert "SELECT * FROM vec UNION ALL SELECT * FROM fts" in sql
    assert params["tenant"] == "t1" and params["k"] == 5 and params["pool"] == 20
    assert hit.chunk_id == 7 and hit.document_id == "doc-uuid" and hit.score == pytest.approx(0.0164)


def test_vector_mode_has_no_full_text_leg():
    conn = FakeConn()
    hybrid_search(conn, "t1", "refund", [0.1] * 768, mode="vector")
    sql = conn.calls[0][0]
    assert "<=>" in sql and "to_tsquery" not in sql and "fts" not in sql


def test_fts_mode_has_no_vector_leg():
    conn = FakeConn()
    hybrid_search(conn, "t1", "refund", [0.1] * 768, mode="fts")
    sql = conn.calls[0][0]
    assert "to_tsquery" in sql and "<=>" not in sql and "vec" not in sql


def test_every_mode_is_tenant_scoped():
    for sql in SEARCH_SQL.values():
        assert "tenant_id = %(tenant)s" in sql


def test_unknown_mode_is_rejected_before_querying():
    conn = FakeConn()
    with pytest.raises(ValueError, match="unknown search mode"):
        hybrid_search(conn, "t1", "refund", [0.1] * 768, mode="bm25")  # type: ignore[arg-type]
    assert conn.calls == []


@pytest.mark.skipif(os.environ.get("INTEGRATION") != "1", reason="needs Postgres (INTEGRATION=1)")
def test_modes_against_postgres():
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.db import get_pool
    from app.embeddings import get_embedder
    from app.main import app

    body = (
        "Expense approval\n\nSubmit form EXP-204 for every purchase.\n\n"
        + "Travel rules. " * 60
        + "\n\nHotels are booked through the travel desk. " * 10
    )
    with get_pool().connection() as conn:
        tenant = conn.execute("INSERT INTO tenants (name) VALUES ('modes') RETURNING id").fetchone()[0]
        doc = conn.execute(
            """INSERT INTO documents (tenant_id, title, filename, mime_type, size_bytes, content)
               VALUES (%s, 'Expenses', 'expenses.txt', 'text/plain', %s, %s) RETURNING id""",
            (tenant, len(body), body.encode()),
        ).fetchone()[0]
    res = TestClient(app).post(
        "/v1/ingest", json={"document_id": str(doc)}, headers={"x-internal-token": settings.internal_token}
    )
    assert res.status_code == 200 and res.json()["chunks"] > 1

    [qvec] = get_embedder().embed(["EXP-204"])
    try:
        with get_pool().connection() as conn:
            fts = hybrid_search(conn, str(tenant), "EXP-204", qvec, k=10, mode="fts")
            vec = hybrid_search(conn, str(tenant), "EXP-204", qvec, k=10, mode="vector")
            hyb = hybrid_search(conn, str(tenant), "EXP-204", qvec, k=10)
        # Full text returns only chunks containing the code; vector ranks every chunk.
        assert fts and all("EXP-204" in h.content for h in fts)
        assert len(vec) == res.json()["chunks"]
        assert "EXP-204" in hyb[0].content
    finally:
        with get_pool().connection() as conn:
            conn.execute("DELETE FROM tenants WHERE id = %s", (tenant,))


def test_fts_query_is_an_or_of_content_words():
    from app.retrieval import fts_query

    assert fts_query("How many days do I have to return an item?") == "many | days | return | item"
    assert fts_query("What does POL-FIN-03 say?") == "pol | fin | 03 | say"
    assert fts_query("Сколько дней на возврат товара?") == "дней | возврат | товара"
    assert fts_query("the the THE") == ""  # only stop words -> empty query, matches nothing
