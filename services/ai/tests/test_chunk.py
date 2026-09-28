from fastapi.testclient import TestClient

from app.chunking import chunk_text
from app.main import app

client = TestClient(app)


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_short_text_is_single_chunk():
    chunks = chunk_text("Hello world.", max_chars=100, overlap=10)
    assert [c.text for c in chunks] == ["Hello world."]


def test_long_text_overlaps_and_covers_everything():
    text = " ".join(f"Sentence number {i}." for i in range(200))
    chunks = chunk_text(text, max_chars=300, overlap=50)
    assert len(chunks) > 1
    assert all(len(c.text) <= 300 for c in chunks)
    assert chunks[0].start == 0 and chunks[-1].end == len(text)
    for a, b in zip(chunks, chunks[1:]):
        assert b.start < a.end  # consecutive chunks overlap


def test_endpoint_validates_input():
    assert client.post("/v1/chunk", json={"text": ""}).status_code == 422
