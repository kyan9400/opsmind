"""Ingest limits: extracted characters, PDF pages, PDF page content and time, chunk count. No database:
the pool is faked."""

import time
import uuid
import zlib
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from pypdf import PageObject, get_configuration

import app.extract as extract
import app.main as main
from app.config import Settings
from app.extract import DocumentOverLimit, extract_text

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
    return build_pdf(objects)


def build_pdf(objects: list[bytes]) -> bytes:
    """A PDF of the given object bodies, numbered from 1; object 1 is the catalog."""
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


def flate_stream(data: bytes, extra: bytes = b"") -> bytes:
    packed = zlib.compress(data, 9)
    return b"<< /Length %d /Filter /FlateDecode %s>>\nstream\n%s\nendstream" % (len(packed), extra, packed)


def drawing_pdf(content: bytes, pages: int = 1, xform: bytes = b"") -> bytes:
    """`pages` pages that all draw one shared compressed content stream; /X1 is a form XObject."""
    font = b"/Font << /F1 3 0 R >>"
    page = (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << %s /XObject << /X1 5 0 R >> >> /Contents 4 0 R >>" % font
    )
    kids = " ".join(f"{6 + i} 0 R" for i in range(pages))
    return build_pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        flate_stream(content),
        flate_stream(xform, b"/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << %s >> " % font),
        *[page] * pages,
    ])


# ---------------------------------------------------------------- extract_text


def test_pdf_text_is_extracted_page_by_page():
    pdf = make_pdf(["Refunds within 30 days.", "Orders ship the same day."])
    assert extract_text(pdf, "application/pdf") == "Refunds within 30 days.\n\nOrders ship the same day."


def test_pdf_over_the_page_limit_is_refused_before_any_text_is_extracted(monkeypatch):
    calls = []
    monkeypatch.setattr(PageObject, "extract_text", lambda self, *a, **k: calls.append(1) or "x")
    with pytest.raises(DocumentOverLimit, match=r"document too long: 4 pages \(limit 3\)"):
        extract_text(make_pdf(["a", "b", "c", "d"]), "application/pdf", max_pdf_pages=3)
    assert calls == []
    assert extract_text(make_pdf(["a", "b", "c"]), "application/pdf", max_pdf_pages=3) == "x\n\nx\n\nx"


def test_pdf_extraction_stops_at_the_first_page_over_the_character_limit(monkeypatch):
    calls = []

    def page_text(self, *args, **kwargs):
        calls.append(1)
        return "y" * 100

    monkeypatch.setattr(PageObject, "extract_text", page_text)
    with pytest.raises(DocumentOverLimit, match="more than 150 characters"):
        extract_text(make_pdf(["p"] * 10), "application/pdf", max_chars=150)
    assert len(calls) == 2  # pages 3..10 are never decoded


def test_plain_text_over_the_character_limit_is_refused():
    with pytest.raises(DocumentOverLimit, match=r"1,001 characters of text \(limit 1,000\)"):
        extract_text(b"z" * 1001, "text/plain", max_chars=1000)
    # The limit applies to normalised text: collapsed whitespace does not count.
    assert extract_text(b"z" * 1000 + b"   \n\n\n\n", "text/plain", max_chars=1000) == "z" * 1000


def test_zero_turns_the_limits_off():
    assert len(extract_text(b"z" * 5000, "text/plain", max_chars=0)) == 5000
    assert extract_text(make_pdf(["a"] * 4), "application/pdf", max_pdf_pages=0) == "a\n\na\n\na\n\na"


def limits(s: Settings) -> tuple:
    return (s.ingest_max_chars, s.ingest_max_chunks, s.ingest_max_pdf_pages, s.ingest_max_pdf_content_mb,
            s.ingest_max_pdf_seconds)


def test_limit_defaults_and_overrides(monkeypatch):
    names = ("INGEST_MAX_CHARS", "INGEST_MAX_CHUNKS", "INGEST_MAX_PDF_PAGES", "INGEST_MAX_PDF_CONTENT_MB",
             "INGEST_MAX_PDF_SECONDS")
    for name in names:
        monkeypatch.delenv(name, raising=False)
    assert limits(Settings()) == (200_000, 300, 50, 10, 20.0)
    monkeypatch.setenv("INGEST_MAX_CHARS", "1000")
    monkeypatch.setenv("INGEST_MAX_CHUNKS", "")  # a cleared dashboard field keeps the default
    monkeypatch.setenv("INGEST_MAX_PDF_PAGES", "0")
    monkeypatch.setenv("INGEST_MAX_PDF_CONTENT_MB", "25")
    monkeypatch.setenv("INGEST_MAX_PDF_SECONDS", "7.5")
    assert limits(Settings()) == (1000, 300, 0, 25, 7.5)


# ---------------------------------------------------------------- PDFs that draw without writing text

# Operators that cost parse time but print nothing, so neither the character nor the page limit sees them.
NO_TEXT = b"BT ET\n"
DEFAULTS = {"max_chars": 200_000, "max_pdf_pages": 50, "max_pdf_content_bytes": 10_000_000, "max_pdf_seconds": 20}


@pytest.fixture
def parsed_pages(monkeypatch):
    """Counts pages handed to pypdf's text extraction (the expensive part)."""
    calls = []
    real = PageObject.extract_text

    def spy(self, *args, **kwargs):
        calls.append(1)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(PageObject, "extract_text", spy)
    return calls


def test_a_small_pdf_of_non_printing_operators_is_refused_before_any_parsing(parsed_pages):
    # 50 pages share one stream of 1 MB of "BT ET": a ~10 KB file that took ~2 minutes of CPU to read.
    pdf = drawing_pdf(NO_TEXT * (1_000_000 // len(NO_TEXT)), pages=50)
    assert len(pdf) < 20_000
    started = time.monotonic()
    with pytest.raises(DocumentOverLimit, match=r"^document too complex: more than 10 MB of PDF page content$"):
        extract_text(pdf, "application/pdf", **DEFAULTS)
    assert time.monotonic() - started < 5
    assert parsed_pages == []


def test_a_stream_over_the_decoding_cap_is_refused_before_parsing(parsed_pages):
    pdf = drawing_pdf(NO_TEXT * (5_000_000 // len(NO_TEXT)))  # one page, 5 MB decoded
    with pytest.raises(DocumentOverLimit, match="^document too complex: PDF over a decoding limit"):
        extract_text(pdf, "application/pdf", **DEFAULTS)
    assert parsed_pages == []
    # The tighter decoding limit applies only while this upload is read.
    assert get_configuration().zlib_maximum_output_length == 75_000_000


def test_page_content_is_counted_once_per_page_that_draws_it():
    pdf = drawing_pdf(b"BT /F1 12 Tf 72 720 Td (Refunds within 30 days.) Tj ET\n" + NO_TEXT * 4_000, pages=3)
    text = "Refunds within 30 days."
    with pytest.raises(DocumentOverLimit, match="more than 0.05 MB of PDF page content"):
        extract_text(pdf, "application/pdf", max_pdf_content_bytes=50_000)  # 3 x 24 KB
    assert extract_text(pdf, "application/pdf", max_pdf_content_bytes=100_000) == f"{text}\n\n{text}\n\n{text}"
    assert extract_text(pdf, "application/pdf", max_pdf_content_bytes=0) == f"{text}\n\n{text}\n\n{text}"


def test_ordinary_pdfs_read_the_same_under_the_default_limits():
    pdf = make_pdf(["Refunds within 30 days.", "Orders ship the same day."])
    assert extract_text(pdf, "application/pdf", **DEFAULTS) == extract_text(pdf, "application/pdf")


@pytest.fixture
def fake_clock(monkeypatch):
    """Every reading of the clock is one second later than the last."""
    readings = []

    def monotonic():
        readings.append(1)
        return float(len(readings))

    monkeypatch.setattr(extract.time, "monotonic", monotonic)
    return readings


def test_the_deadline_stops_a_slow_page_part_way(fake_clock):
    pdf = drawing_pdf(b"10 20 m 30 40 l S\n" * 2_000)  # 6,000 operators on one page
    with pytest.raises(DocumentOverLimit, match=r"^document too complex: reading the PDF took over 100 s$"):
        extract_text(pdf, "application/pdf", max_pdf_seconds=100)
    assert len(fake_clock) < 200  # stopped after ~100 operators, not after all 6,000


def test_the_deadline_also_stops_work_inside_form_xobjects(fake_clock):
    # pypdf catches and logs errors raised inside a form XObject, the deadline's included. The page draws
    # nothing else, so only the check after the page can stop the document.
    pdf = drawing_pdf(b"/X1 Do\n", xform=b"10 20 m 30 40 l S\n" * 2_000)
    with pytest.raises(DocumentOverLimit, match="took over 100 s"):
        extract_text(pdf, "application/pdf", max_pdf_seconds=100)
    assert len(fake_clock) < 200


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
        def executemany(_self, sql, rows):
            for row in rows:  # as psycopg does: text is sent as UTF-8, or refused before anything is sent
                [p.encode("utf-8") for p in row if isinstance(p, str)]
            self.db.inserted.extend(rows)

        yield type("Cursor", (), {"executemany": executemany})()


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


def test_a_pdf_of_non_printing_operators_is_422(ingest):
    res, db = ingest(drawing_pdf(NO_TEXT * (1_000_000 // len(NO_TEXT)), pages=50), "application/pdf")
    assert res.status_code == 422
    assert db.failure() == res.json()["detail"] == "document too complex: more than 10 MB of PDF page content"
    assert db.inserted == []


def test_default_limits_cap_a_4_mb_upload(ingest):
    # The live demo accepts 4 MB uploads; at the defaults such a file is refused, not split into ~6,000 chunks.
    res, db = ingest(paragraphs(10_000)[: 4 * 1024 * 1024])
    assert res.status_code == 422 and res.json()["detail"].startswith("document too long")
    assert db.inserted == []


# ---------------------------------------------------------------- text the database cannot store


def broken_unicode_pdf(text: str) -> bytes:
    """One page of Helvetica text whose ToUnicode map sends "A" to half of a UTF-16 surrogate pair."""
    cmap = (
        b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Broken def\n"
        b"1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <D835> endbfchar\n"
        b"endcmap CMapName currentdict /CMap defineresource pop end end"
    )
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    return build_pdf([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> "
        b"/Contents 5 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(cmap), cmap),
    ])


def test_a_pdf_with_a_broken_unicode_map_is_indexed(ingest):
    # pypdf returns "B\ud835" for "BA"; psycopg cannot encode a lone surrogate, so the insert used to fail.
    res, db = ingest(broken_unicode_pdf("Refund within 30 days BA"), "application/pdf")
    assert res.status_code == 200, res.text
    assert [row[3] for row in db.inserted] == ["Refund within 30 days B\ufffd"]


def test_split_surrogate_pairs_are_rejoined_and_lone_halves_replaced():
    text = "bold \ud835\udc00, lone \ud835 and \udc00"  # as pypdf leaves them, one half per character code
    assert extract.normalise(text) == "bold \U0001d400, lone \ufffd and \ufffd"


def test_text_the_database_refuses_is_422_and_marks_the_document_failed(ingest, monkeypatch):
    # Whatever gets past extraction: the document is failed with a reason, not left "processing" by a 500.
    monkeypatch.setattr(main, "extract_text", lambda *args, **kwargs: "Refund within 30 days B\ud835")
    res, db = ingest(b"unused")
    assert res.status_code == 422
    assert res.json()["detail"].startswith("could not store the document's text: 'utf-8' codec can't encode")
    assert db.failure() == res.json()["detail"]
    assert db.inserted == []
