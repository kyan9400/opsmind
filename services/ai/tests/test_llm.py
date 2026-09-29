

def test_extractive_answer_skips_sentences_that_share_only_function_words():
    from app.llm import extractive_answer
    from app.retrieval import Hit

    hits = [
        Hit(chunk_id=1, document_id="d1", title="refund policy", chunk_index=0, score=0.03,
            content="Customers can request a full refund within 30 days of delivery. "
                    "After 30 days and up to 90 days, we offer store credit instead of a refund."),
        Hit(chunk_id=2, document_id="d2", title="runbook", chunk_index=0, score=0.02,
            content="Severity 2: a feature is degraded for many customers."),
    ]
    answer = extractive_answer("How many days do customers have to request a refund?", hits)
    assert "30 days of delivery" in answer and "[1]" in answer
    assert "Severity" not in answer and "[2]" not in answer
