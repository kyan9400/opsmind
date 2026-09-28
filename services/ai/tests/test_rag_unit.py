import math

from fastapi.testclient import TestClient

from app.embeddings import HashEmbedder, tokenize
from app.extract import extract_text
from app.llm import NO_ANSWER, cited_numbers, extractive_answer, generate_answer
from app.main import app
from app.retrieval import Hit


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def hit(n: int, content: str) -> Hit:
    return Hit(chunk_id=n, document_id=f"d{n}", title=f"Doc {n}", chunk_index=0, content=content, score=1.0)


def test_tokenize_handles_cyrillic_and_arabic():
    assert tokenize("Возврат средств — سياسة الاسترداد!") == ["возврат", "средств", "سياسة", "الاسترداد"]


def test_hash_embeddings_are_deterministic_normalised_and_lexical():
    e = HashEmbedder()
    a, a2, similar, other = e.embed(
        ["refund within 30 days", "refund within 30 days", "refunds are allowed within 30 days", "server uptime SLA"]
    )
    assert a == a2
    assert len(a) == 768
    assert math.isclose(sum(v * v for v in a), 1.0, rel_tol=1e-6)
    assert cosine(a, similar) > cosine(a, other)


def test_extract_plain_text_normalises_whitespace():
    raw = "Title\r\n\r\n\r\n\r\nBody   with\t\tspaces\x00".encode()
    assert extract_text(raw, "text/plain") == "Title\n\nBody with spaces"


def test_extractive_answer_cites_the_matching_source():
    hits = [
        hit(1, "Our office is in Moscow. Parking is free."),
        hit(2, "Customers can request a refund within 30 days. After that, store credit only."),
    ]
    answer = extractive_answer("How many days to request a refund?", hits)
    assert "30 days" in answer
    assert 2 in cited_numbers(answer, len(hits))


def test_no_hits_means_no_answer():
    assert generate_answer("anything?", []) == NO_ANSWER


def test_cited_numbers_ignores_out_of_range():
    assert cited_numbers("A [1] B [3] C [9]", 3) == {1, 3}


def test_internal_endpoints_require_token():
    client = TestClient(app)
    assert client.post("/v1/ingest", json={"document_id": "00000000-0000-0000-0000-000000000000"}).status_code == 401
    assert client.post("/v1/ask", json={"tenant_id": "00000000-0000-0000-0000-000000000000", "question": "x"}).status_code == 401
