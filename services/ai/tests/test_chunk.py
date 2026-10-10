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


def covers(text: str, chunks) -> bool:
    no_gaps = all(b.start <= a.end for a, b in zip(chunks, chunks[1:]))
    return chunks[0].start == 0 and chunks[-1].end == len(text) and no_gaps


def test_chunks_after_the_first_start_at_a_whole_word():
    # One ~2,000-character sentence: no line or sentence starts, so the overlap must snap to a word.
    text = " ".join(f"item {i} ships to locker {i * 7} within {i % 5 + 1} business days" for i in range(45))
    chunks = chunk_text(text)
    assert len(chunks) >= 3 and covers(text, chunks)
    for a, b in zip(chunks, chunks[1:]):
        assert text[b.start - 1] == " " and text[b.start] != " "  # never part way through a word
        assert b.start < a.end  # the split sentence is still repeated


def test_the_overlap_repeats_whole_lines_or_sentences():
    sections = [
        f"## Section {s}\n\n"
        + "\n".join(f"- Rule {s}.{i}: parcels over {i} kg go by courier, not by post." for i in range(4))
        + "\n"
        + " ".join(f"Lockers in zone {s} keep parcels for {i + 2} days, then return them." for i in range(4))
        for s in range(5)
    ]
    text = "\n\n".join(sections)
    assert 1_900 < len(text) < 2_600
    chunks = chunk_text(text)
    assert len(chunks) >= 3 and covers(text, chunks)
    for c in chunks[1:]:
        line_start, sentence_start = text[c.start - 1] == "\n", text[c.start - 2 : c.start] == ". "
        assert line_start or sentence_start, text[c.start - 20 : c.start + 20]


def test_a_word_longer_than_the_overlap_is_cut_and_the_text_still_covered():
    text = "x" * 2500
    chunks = chunk_text(text, max_chars=800, overlap=100)
    assert covers(text, chunks) and all(len(c.text) <= 800 for c in chunks)
