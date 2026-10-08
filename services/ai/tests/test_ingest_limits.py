"""Ingest limits: extracted characters, PDF pages and chunk count. No database: the pool is faked."""

import uuid
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from pypdf import PageObject

import app.main as main
from app.config import Settings
from app.extract import DocumentTooLong, extract_text

HEADERS = {"x-internal-token": main.settings.internal_token}
DOC = str(uuid.UUID(int=7))


def make_pdf(page_texts: list[str]) -> bytes:
    """A minimal valid PDF, one line of Helvetica text per page."""
    n = len(page_texts)
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(n))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for i, text in enumerate(page_texts):
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {5 + 2 * i} 0 R >>".encode()
        )
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


# ---------------------------------------------------------------- extract_text


def test_pdf_text_is_extracted_page_by_page():
    pdf = make_pdf(["Refunds within 30 days.", "Orders ship the same day."])
    assert extract_text(pdf, "application/pdf") == "Refunds within 30 days.\n\nOrders ship the same day."


def test_pdf_over_the_page_limit_is_refused_before_any_text_is_extracted(monkeypatch):
    calls = []
    monkeypatch.setattr(PageObject, "extract_text", lambda self, *a, **k: calls.append(1) or "x")
    with pytest.raises(DocumentTooLong, match=r"document too long: 4 pages \(limit 3\)"):
        extract_text(make_pdf(["a", "b", "c", "d"]), "application/pdf", max_pdf_pages=3)
    assert calls == []
    assert extract_text(make_pdf(["a", "b", "c"]), "application/pdf", max_pdf_pages=3) == "x\n\nx\n\nx"


def test_pdf_extraction_stops_at_the_first_page_over_the_character_limit(monkeypatch):
    calls = []

    def page_text(self, *args, **kwargs):
        calls.append(1)
        return "y" * 100

    monkeypatch.setattr(PageObject, "extract_text", page_text)
    with pytest.raises(DocumentTooLong, match="more than 150 characters"):
        extract_text(make_pdf(["p"] * 10), "application/pdf", max_chars=150)
    assert len(calls) == 2  # pages 3..10 are never decoded


def test_plain_text_over_the_character_limit_is_refused():
    with pytest.raises(DocumentTooLong, match=r"1,001 characters of text \(limit 1,000\)"):
        extract_text(b"z" * 1001, "text/plain", max_chars=1000)
    # The limit applies to normalised text: collapsed whitespace does not count.
    assert extract_text(b"z" * 1000 + b"   \n\n\n\n", "text/plain", max_chars=1000) == "z" * 1000


def test_zero_turns_the_limits_off():
    assert len(extract_text(b"z" * 5000, "text/plain", max_chars=0)) == 5000
    assert extract_text(make_pdf(["a"] * 4), "application/pdf", max_pdf_pages=0) == "a\n\na\n\na\n\na"


def test_limit_defaults_and_overrides(monkeypatch):
    for name in ("INGEST_MAX_CHARS", "INGEST_MAX_CHUNKS", "INGEST_MAX_PDF_PAGES"):
        monkeypatch.delenv(name, raising=False)
    s = Settings()
    assert (s.ingest_max_chars, s.ingest_max_chunks, s.ingest_max_pdf_pages) == (200_000, 300, 50)
    monkeypatch.setenv("INGEST_MAX_CHARS", "1000")
    monkeypatch.setenv("INGEST_MAX_CHUNKS", "")  # a cleared dashboard field keeps the default
    monkeypatch.setenv("INGEST_MAX_PDF_PAGES", "0")
    s = Settings()
    assert (s.ingest_max_chars, s.ingest_max_chunks, s.ingest_max_pdf_pages) == (1000, 300, 0)


# ---------------------------------------------------------------- /v1/ingest


class FakeConn:
    def __init__(self, db: "FakeDb"):
        self.db = db

    def execute(self, sql: str, params=()):
        self.db.statements.append((" ".join(sql.split()), params))
        row = (uuid.UUID(int=1), self.db.mime, self.db.content) if "RETURNING" in sql else None
        return type("Result", (), {"fetchone": lambda _self: row})()

    @contextmanager
    def transaction(self):
        yield

    @contextmanager
    def cursor(self):
        yield type("Cursor", (), {"executemany": lambda _self, sql, rows: self.db.inserted.extend(rows)})()


class FakeDb:
    def __init__(self, content: bytes, mime: str = "text/plain"):
        self.content, self.mime = content, mime
        self.statements: list[tuple[str, tuple]] = []
        self.inserted: list[tuple] = []

    @contextmanager
    def connection(self):
        yield FakeConn(self)

    def failure(self) -> str | None:
        for sql, params in self.statements:
            if "status = 'failed'" in sql:
                return params[0]
        return None


@pytest.fixture
def ingest(monkeypatch):
    def run(content: bytes, mime: str = "text/plain", **env: str):
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        monkeypatch.setattr(main, "settings", Settings())
        db = FakeDb(content, mime)
        monkeypatch.setattr(main, "get_pool", lambda: db)
        res = TestClient(main.app).post("/v1/ingest", json={"document_id": DOC}, headers=HEADERS)
        return res, db

    return run


def paragraphs(n: int) -> bytes:
    # Each paragraph is longer than a chunk's back half, so every one becomes at least one chunk.
    return "\n\n".join(f"Paragraph {i}. " + "word " * 90 for i in range(n)).encode()


def test_ingest_under_the_limits_stores_the_chunks(ingest):
    res, db = ingest(paragraphs(5))
    assert res.status_code == 200, res.text
    assert res.json()["chunks"] == len(db.inserted) >= 5
    assert db.failure() is None


def test_too_many_characters_is_422_and_marks_the_document_failed(ingest):
    res, db = ingest(b"z" * 2001, INGEST_MAX_CHARS="2000")
    assert res.status_code == 422
    assert res.json()["detail"] == "document too long: 2,001 characters of text (limit 2,000)"
    assert db.failure() == res.json()["detail"]
    assert db.inserted == []


def test_too_many_chunks_is_422_and_marks_the_document_failed(ingest):
    res, db = ingest(paragraphs(12), INGEST_MAX_CHUNKS="10")
    assert res.status_code == 422
    assert res.json()["detail"].startswith("document too long: ") and "chunks (limit 10)" in res.json()["detail"]
    assert db.failure() == res.json()["detail"]
    assert db.inserted == []


def test_too_many_pdf_pages_is_422(ingest):
    res, db = ingest(make_pdf(["page"] * 3), "application/pdf", INGEST_MAX_PDF_PAGES="2")
    assert res.status_code == 422
    assert db.failure() == "document too long: 3 pages (limit 2)"


def test_default_limits_cap_a_4_mb_upload(ingest):
    # The live demo accepts 4 MB uploads; at the defaults such a file is refused, not split into ~6,000 chunks.
    res, db = ingest(paragraphs(10_000)[: 4 * 1024 * 1024])
    assert res.status_code == 422 and res.json()["detail"].startswith("document too long")
    assert db.inserted == []
