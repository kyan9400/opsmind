import codecs
import math

import pytest
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


RU = "Политика возврата\n\nКлиент может вернуть товар в течение 14 дней. Деньги вернём на карту."


@pytest.mark.parametrize(
    "raw",
    [
        RU.encode("utf-8"),
        RU.encode("utf-8-sig"),
        RU.encode("utf-16"),  # with a byte order mark, as Notepad's "Unicode" writes it
        codecs.BOM_UTF16_BE + RU.encode("utf-16-be"),
        RU.encode("cp1251"),  # older Russian Windows programs and 1C exports
    ],
    ids=["utf-8", "utf-8-bom", "utf-16-le", "utf-16-be", "windows-1251"],
)
def test_text_uploads_in_common_encodings_are_read(raw):
    assert extract_text(raw, "text/plain") == RU


def test_windows_1252_punctuation_in_english_text_is_read():
    assert extract_text("Refunds are “final” – no exceptions…".encode("cp1252"), "text/plain") == (
        "Refunds are “final” – no exceptions…"
    )


def test_a_few_damaged_bytes_in_utf_8_are_replaced():
    assert extract_text(RU.encode() * 3 + b"\xff", "text/plain").endswith("на карту.\ufffd")


@pytest.mark.parametrize(
    "raw",
    [
        RU.encode("koi8-r"),
        "سياسة الاسترداد: يمكن للعميل إرجاع المنتج خلال 14 يومًا من الاستلام.".encode("cp1256"),
        "Après 30 jours, nous offrons un crédit en magasin à la caisse.".encode("cp1252"),
        bytes(range(256)) * 4,
    ],
    ids=["koi8-r", "windows-1256", "windows-1252", "binary"],
)
def test_text_in_other_encodings_is_refused_rather_than_stored_as_garbage(raw):
    with pytest.raises(ValueError, match="^the file is not UTF-8 text: save it as UTF-8 and upload"):
        extract_text(raw, "text/plain")


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


def test_overlapping_chunks_do_not_repeat_a_sentence():
    # Two chunks of one document: the second repeats a line and the tail of a sentence from the first.
    hits = [
        hit(1, "Express delivery is next business day in Moscow only. "
               "Express is not available to post office boxes or parcel lockers.\n- Pro: 699 RUB per month."),
        hit(2, "post office boxes or parcel lockers.\n- Pro: 699 RUB per month.\n- Plus: 299 RUB per month."),
    ]
    answer = extractive_answer("Is express delivery available to parcel lockers?", hits)
    assert answer == (
        "Express is not available to post office boxes or parcel lockers. [1] "
        "Express delivery is next business day in Moscow only. [1]"
    )
    answer = extractive_answer("How much does the Plus plan cost per month?", hits)
    assert answer == "- Plus: 299 RUB per month. [2] - Pro: 699 RUB per month. [1]"


def test_markdown_headings_are_not_answers():
    rule = "Post a status update every 30 minutes until the SEV-1 is resolved."
    hits = [hit(1, f"## First 15 minutes of a SEV-1\n\n{rule}")]
    assert extractive_answer("How often do we post status updates during a SEV-1?", hits) == f"{rule} [1]"


def test_sentences_that_share_only_numbers_are_not_an_answer():
    # The demo documents and its third example question in Arabic, which no sentence answers in Arabic:
    # only "1" and "000" from "1,000" match. "Not found" lets the web show its own translated message.
    hits = [
        hit(1, "Shipping is free for orders over 5,000 RUB. International shipping is not offered yet."),
        hit(2, "Severity 1: the checkout or payment flow is down. Page the on-call engineer immediately."),
        hit(3, "Expenses up to 10,000 RUB are approved by the team lead."),
    ]
    assert extractive_answer("من يعتمد المصروفات التي تتجاوز 1,000 دولار؟", hits) == NO_ANSWER
    assert 3 in cited_numbers(extractive_answer("Who approves expenses over $1,000?", hits), len(hits))
