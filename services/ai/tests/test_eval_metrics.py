"""Retrieval-eval helpers and dataset integrity; no database needed."""

import json
from collections import Counter

import pytest

from app.chunking import chunk_text
from app.extract import extract_text
from eval.run_eval import (
    KINDS,
    MODES,
    dedupe,
    first_rank,
    load_documents,
    load_questions,
    render_markdown,
    score,
    summarize,
)


def test_dedupe_keeps_best_chunk_rank_per_document():
    assert dedupe(["a.md", "b.md", "a.md", "c.md", "b.md"]) == ["a.md", "b.md", "c.md"]


def test_first_rank_is_one_based_or_none():
    assert first_rank(["a", "b", "c"], "a") == 1
    assert first_rank(["a", "b", "c"], "c") == 3
    assert first_rank(["a", "b"], "z") is None


def test_score_on_toy_rankings():
    m = score([1, 2, 4, None, 12])
    assert m["n"] == 5
    assert m["recall@1"] == pytest.approx(1 / 5)
    assert m["recall@3"] == pytest.approx(2 / 5)
    assert m["recall@5"] == pytest.approx(3 / 5)
    # Rank 12 is past the MRR depth and contributes nothing.
    assert m["mrr@10"] == pytest.approx((1 + 1 / 2 + 1 / 4) / 5)


def test_score_of_nothing_is_zero_not_a_crash():
    assert score([])["recall@5"] == 0.0


def _result(kind, lang, vector, fts, hybrid):
    return {
        "question": "q",
        "expected_doc": "a.md",
        "lang": lang,
        "kind": kind,
        "ranks": {"vector": vector, "fts": fts, "hybrid": hybrid},
        "top": {m: ["b.md"] for m in MODES},
    }


def test_summarize_breaks_down_by_kind_and_language():
    results = [
        _result("exact", "en", 3, 1, 1),
        _result("paraphrase", "en", 1, None, 1),
        _result("paraphrase", "ru", None, None, 7),
    ]
    s = summarize(results)
    assert s["hybrid"]["overall"]["recall@1"] == pytest.approx(2 / 3)
    assert s["fts"]["by_kind"]["exact"]["recall@1"] == 1.0
    assert s["fts"]["by_kind"]["paraphrase"]["recall@5"] == 0.0
    assert s["vector"]["by_lang"]["ru"]["n"] == 1
    assert list(s["hybrid"]["by_kind"]) == ["exact", "paraphrase"]

    report = render_markdown(
        s, results, {"questions": 3, "documents": 1, "chunks": 2, "embed_provider": "hash"}
    )
    assert "| **hybrid** | 66.7% | 66.7% | 66.7% |" in report
    assert "Hybrid misses at 5** (1)" in report


def test_dataset_is_consistent():
    docs = load_documents()
    names = {d.filename for d in docs}
    questions = load_questions(known_docs=names)

    assert 8 <= len(docs) <= 12
    assert 40 <= len(questions) <= 60
    assert {q.kind for q in questions} == set(KINDS)
    assert {"en", "ru", "ar"} <= {q.lang for q in questions}
    # Every document is the answer to at least one question, so none is dead weight.
    assert names == {q.expected_doc for q in questions}
    assert len({q.question for q in questions}) == len(questions)
    # Each document goes through the production extract + chunk path without errors.
    for d in docs:
        assert d.title
        assert chunk_text(extract_text(d.content, d.mime_type))


def test_unknown_expected_doc_fails_loudly(tmp_path):
    bad = tmp_path / "q.jsonl"
    bad.write_text(
        json.dumps({"question": "x", "expected_doc": "nope.md", "lang": "en", "kind": "exact"}) + "\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="unknown expected_doc"):
        load_questions(bad, known_docs={"a.md"})


def test_question_mix_is_balanced_enough_to_compare_modes():
    kinds = Counter(q.kind for q in load_questions())
    assert kinds["exact"] >= 10 and kinds["paraphrase"] >= 10 and kinds["natural"] >= 10
