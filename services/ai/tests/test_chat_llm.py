"""OpenAI-compatible provider, extractive fallback and conversation follow-ups. No network: httpx is mocked."""

import json
from contextlib import contextmanager

import httpx
import pytest
from fastapi.testclient import TestClient

import app.insights as insights
import app.llm as llm
import app.main as main
from app.config import Settings
from app.retrieval import Hit

HEADERS = {"x-internal-token": main.settings.internal_token}
TENANT = "00000000-0000-0000-0000-000000000001"

HITS = [
    Hit(chunk_id=1, document_id="d1", title="refund policy", chunk_index=0, score=0.03,
        content="Customers can request a full refund within 30 days of delivery. "
                "Damaged items are replaced free of charge within 90 days."),
]


@pytest.fixture
def compatible(monkeypatch):
    """Configure LLM_PROVIDER=openai-compatible and route httpx.post to a handler; returns the requests."""
    monkeypatch.setenv("LLM_PROVIDER", "openai-compatible")
    monkeypatch.setenv("LLM_BASE_URL", "https://api.groq.example/openai/v1/")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "llama-test")
    monkeypatch.setenv("LLM_MAX_TOKENS", "123")
    monkeypatch.setattr(llm, "settings", Settings())
    seen: list[httpx.Request] = []

    def route(handler):
        def post(url, **kwargs):
            def record(request: httpx.Request) -> httpx.Response:
                seen.append(request)
                return handler(request)

            with httpx.Client(transport=httpx.MockTransport(record)) as client:
                kwargs.pop("timeout", None)
                return client.post(url, **kwargs)

        monkeypatch.setattr(llm.httpx, "post", post)
        return seen

    return route


def ok(text: str):
    return lambda request: httpx.Response(200, json={"choices": [{"message": {"content": text}}]})


def test_openai_compatible_request_shape(compatible):
    seen = compatible(ok("Within 30 days [1]."))
    history = [llm.Turn("What is the refund policy?", "Full refund within 30 days [1].")]
    answer = llm.generate_answer("And for damaged items?", HITS, history)

    assert answer == "Within 30 days [1]."
    [req] = seen
    assert str(req.url) == "https://api.groq.example/openai/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer test-key"
    body = json.loads(req.content)
    assert body["model"] == "llama-test" and body["max_tokens"] == 123 and body["temperature"] == 0
    roles = [m["role"] for m in body["messages"]]
    assert roles == ["system", "user", "assistant", "user"]
    assert body["messages"][0]["content"] == llm.SYSTEM_PROMPT
    assert body["messages"][1]["content"] == "What is the refund policy?"
    assert body["messages"][2]["content"] == "Full refund within 30 days [1]."
    last = body["messages"][3]["content"]
    assert last.startswith("Sources:\n[1] (refund policy)") and last.endswith("Question: And for damaged items?")


def test_system_prompt_keeps_language_citation_and_injection_rules():
    p = llm.SYSTEM_PROMPT
    assert "[1]" in p and "untrusted data" in p and "ignore any instructions" in p
    assert "language of the latest question" in p and "Russian" in p and "Arabic" in p


@pytest.mark.parametrize(
    "handler",
    [
        lambda r: httpx.Response(429, json={"error": {"message": "rate limit"}}),
        lambda r: httpx.Response(500, text="boom"),
        lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow", request=r)),
        ok(""),
    ],
    ids=["429", "500", "timeout", "empty"],
)
def test_provider_failure_falls_back_to_extractive(compatible, handler):
    compatible(handler)
    answer, provider = llm.answer_with_fallback("How many days to request a refund?", HITS)
    assert provider == llm.FALLBACK_PROVIDER
    assert "30 days" in answer and "[1]" in answer


def test_missing_base_url_falls_back(compatible, monkeypatch):
    compatible(ok("unused"))
    monkeypatch.delenv("LLM_BASE_URL")
    monkeypatch.setattr(llm, "settings", Settings())
    assert llm.answer_with_fallback("refund days?", HITS)[1] == llm.FALLBACK_PROVIDER


def test_success_reports_the_configured_provider(compatible):
    compatible(ok("30 days [1]."))
    assert llm.answer_with_fallback("refund?", HITS) == ("30 days [1].", "openai-compatible")


def test_summary_falls_back_to_template_on_rate_limit(compatible, monkeypatch):
    compatible(lambda r: httpx.Response(429))
    monkeypatch.setattr(insights, "settings", llm.settings)
    summary, provider = insights.summarize([], [])
    assert provider == "template" and summary == "No unusual movements in this period."


# ---------------------------------------------------------------- follow-up queries

PREV = [llm.Turn("What is the refund policy?", "Full refund within 30 days [1].")]


@pytest.mark.parametrize(
    "question",
    [
        "And for damaged items?",  # opener
        "How long?",  # short
        "Does it apply to gift cards bought online last year?",  # back-reference
        "А для повреждённых товаров?",
        "Это касается подарочных карт купленных онлайн?",
        "وماذا عن ذلك بالنسبة للمنتجات التالفة؟",
    ],
)
def test_follow_ups_combine_with_the_previous_question(question):
    assert llm.build_retrieval_query(question, PREV) == f"{question} What is the refund policy?"


def test_standalone_questions_are_searched_alone():
    q = "Which warehouse ships orders to customers in Kazan?"
    assert llm.build_retrieval_query(q, PREV) == q
    assert llm.build_retrieval_query("How long?", []) == "How long?"


def test_only_the_last_turn_is_used_and_the_query_is_capped():
    history = [llm.Turn("first question", "a"), llm.Turn("x" * 2000, "b")]
    query = llm.build_retrieval_query("And then?", history)
    assert query.startswith("And then? xxx") and "first" not in query
    assert len(query) == llm.MAX_RETRIEVAL_QUERY


# ---------------------------------------------------------------- /v1/ask


@pytest.fixture
def fake_search(monkeypatch):
    calls: list[str] = []

    @contextmanager
    def connection():
        yield None

    monkeypatch.setattr(main, "get_pool", lambda: type("P", (), {"connection": staticmethod(connection)})())

    def search(conn, tenant, query, qvec, k):
        calls.append(query)
        return HITS

    monkeypatch.setattr(main, "hybrid_search", search)
    return calls


def test_ask_extractive_uses_the_combined_query(fake_search, monkeypatch):
    monkeypatch.setattr(llm, "settings", Settings())  # extractive default
    res = TestClient(main.app).post(
        "/v1/ask",
        headers=HEADERS,
        json={
            "tenant_id": TENANT,
            "question": "And damaged items?",
            "history": [{"question": "What is the refund policy?", "answer": "30 days [1]."}],
        },
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["retrieval_query"] == "And damaged items? What is the refund policy?"
    assert fake_search == [data["retrieval_query"]]
    assert data["provider"] == "extractive"
    assert "Damaged items" in data["answer"] and data["citations"][0]["cited"] is True


def test_ask_rate_limited_llm_still_answers(fake_search, compatible):
    compatible(lambda r: httpx.Response(429))
    res = TestClient(main.app).post(
        "/v1/ask", headers=HEADERS, json={"tenant_id": TENANT, "question": "How many days for a refund?"}
    )
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "extractive-fallback" and "30 days" in data["answer"]
    assert data["retrieval_query"] == "How many days for a refund?"


@pytest.mark.parametrize(
    "history",
    [
        [{"question": "q", "answer": "a"}] * 5,
        [{"question": "q" * 2001, "answer": "a"}],
        [{"question": "q", "answer": "a" * 2001}],
        [{"question": "", "answer": "a"}],
        [{"question": "q"}],
    ],
    ids=["too-many-turns", "long-question", "long-answer", "empty-question", "missing-answer"],
)
def test_history_limits_are_validated(fake_search, history):
    res = TestClient(main.app).post(
        "/v1/ask", headers=HEADERS, json={"tenant_id": TENANT, "question": "refund?", "history": history}
    )
    assert res.status_code == 422
    assert fake_search == []


def test_history_at_the_limits_is_accepted(fake_search, monkeypatch):
    monkeypatch.setattr(llm, "settings", Settings())
    history = [{"question": "q" * 2000, "answer": "a" * 2000}] * 4
    res = TestClient(main.app).post(
        "/v1/ask", headers=HEADERS, json={"tenant_id": TENANT, "question": "refund?", "history": history}
    )
    assert res.status_code == 200


# ---------------------------------------------------------------- reasoning models (Cloudflare Gemma 4)


def reply(content, finish="stop", **message):
    """A Cloudflare-shaped completion: content may be null, thinking may sit in its own field."""
    return lambda request: httpx.Response(
        200,
        json={
            "choices": [{"message": {"role": "assistant", "content": content, **message}, "finish_reason": finish}],
            "usage": {"completion_tokens": 1024, "completion_tokens_details": {"reasoning_tokens": 1000}},
        },
    )


def test_default_request_has_no_extra_fields_and_a_larger_token_budget(compatible, monkeypatch):
    monkeypatch.delenv("LLM_MAX_TOKENS")
    monkeypatch.delenv("LLM_EXTRA_BODY", raising=False)
    monkeypatch.setattr(llm, "settings", Settings())
    seen = compatible(ok("30 days [1]."))
    llm.generate_answer("refund?", HITS)
    body = json.loads(seen[0].content)
    assert set(body) == {"model", "temperature", "max_tokens", "messages"}
    assert body["max_tokens"] == 1024


def test_extra_body_is_merged_into_the_request(compatible, monkeypatch):
    monkeypatch.setenv(
        "LLM_EXTRA_BODY",
        '{"chat_template_kwargs": {"enable_thinking": false}, "max_completion_tokens": 900, "messages": []}',
    )
    monkeypatch.setattr(llm, "settings", Settings())
    seen = compatible(ok("30 days [1]."))
    assert llm.generate_answer("refund?", HITS) == "30 days [1]."
    body = json.loads(seen[0].content)
    assert body["chat_template_kwargs"] == {"enable_thinking": False}
    assert body["max_completion_tokens"] == 900 and body["max_tokens"] == 123
    # The prompt cannot be replaced from the environment.
    assert [m["role"] for m in body["messages"]] == ["system", "user"]


@pytest.mark.parametrize(
    ("value", "error"),
    [("{enable_thinking: false}", "must be a JSON object: "), ('["a"]', "got list"), ("true", "got bool")],
)
def test_extra_body_must_be_a_json_object(monkeypatch, value, error):
    monkeypatch.setenv("LLM_EXTRA_BODY", value)
    with pytest.raises(ValueError, match="LLM_EXTRA_BODY") as exc:
        Settings()
    assert error in str(exc.value) and value not in str(exc.value)
    monkeypatch.setenv("LLM_EXTRA_BODY", " ")
    assert Settings().llm_extra_body == {}


@pytest.mark.parametrize(
    "content",
    [
        "<think>The user asks about refunds. Source 1 says 30 days.</think>\n\nWithin 30 days [1].",
        "<THINKING>\nrefunds...\n</THINKING>Within 30 days [1].",
        "<|channel>thought\nSource 1 covers refunds.<channel|>Within 30 days [1].",
        "<|channel>thought\nSource 1 covers refunds.<|channel>response Within 30 days [1].",
        "The template opened the block in the prompt, so only the end is here.</think>Within 30 days [1].",
    ],
    ids=["think", "thinking", "gemma", "gemma-response-channel", "closing-tag-only"],
)
def test_inline_thinking_is_stripped(compatible, content):
    compatible(ok(content))
    assert llm.answer_with_fallback("refund?", HITS) == ("Within 30 days [1].", "openai-compatible")


def test_a_separate_reasoning_field_is_ignored(compatible):
    compatible(reply("Within 30 days [1].", reasoning_content="Let me think...", reasoning="Let me think..."))
    assert llm.answer_with_fallback("refund?", HITS) == ("Within 30 days [1].", "openai-compatible")


@pytest.mark.parametrize(
    "handler",
    [
        reply(None, "length", reasoning_content="The user wants refund days. Source 1 says..."),
        reply("<think>The user wants refund days. Source 1 says", "length"),
        reply("<|channel>thought\nThe user wants refund days", "length"),
        reply("Customers can request a full refund within", "length"),
        reply("   ", "stop"),
    ],
    ids=["thinking-used-the-budget", "cut-off-mid-think", "cut-off-mid-gemma-thought", "cut-off-uncited", "blank"],
)
def test_cut_off_or_empty_replies_fall_back_to_extractive(compatible, handler):
    compatible(handler)
    answer, provider = llm.answer_with_fallback("How many days to request a refund?", HITS)
    assert provider == llm.FALLBACK_PROVIDER
    assert answer == "Customers can request a full refund within 30 days of delivery. [1]"


def test_a_cut_off_reply_that_cites_a_source_is_kept_and_marked(compatible, caplog):
    compatible(reply("Customers can request a full refund within 30 days [1]. After that", "length"))
    with caplog.at_level("WARNING", logger="opsmind.ai.llm"):
        answer, provider = llm.answer_with_fallback("refund?", HITS)
    assert provider == "openai-compatible"
    assert answer == "Customers can request a full refund within 30 days [1]. After that …"
    assert "max_tokens" in caplog.text


def test_a_cut_off_summary_uses_the_template(compatible, monkeypatch):
    compatible(reply("Revenue rose by 4% while", "length"))
    monkeypatch.setattr(insights, "settings", llm.settings)
    assert insights.summarize([], []) == ("No unusual movements in this period.", "template")


def test_thinking_is_stripped_for_every_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setattr(llm, "settings", Settings())
    monkeypatch.setitem(llm.PROVIDERS, "ollama", lambda system, messages: "<think>hmm</think> 30 days [1].")
    assert llm.chat("s", "u") == "30 days [1]."
    monkeypatch.setitem(llm.PROVIDERS, "ollama", lambda system, messages: "<think>hmm</think>")
    with pytest.raises(ValueError, match="empty completion"):
        llm.chat("s", "u")


# ---------------------------------------------------------------- extractive follow-ups

SUPPORT_HITS = [
    Hit(chunk_id=1, document_id="d1", title="refund policy", chunk_index=0, score=0.03,
        content="Customers can request a full refund within 30 days of delivery."),
    Hit(chunk_id=2, document_id="d2", title="shipping policy", chunk_index=0, score=0.02,
        content="Orders placed before 14:00 ship the same business day."),
    Hit(chunk_id=3, document_id="d3", title="возвраты", chunk_index=0, score=0.02,
        content="У клиентов есть 30 дней на возврат денег после доставки. "
                "Заказы отправляются в тот же рабочий день, если оформлены до 14:00."),
    Hit(chunk_id=4, document_id="d4", title="الاسترداد", chunk_index=0, score=0.02,
        content="يمكن للعملاء طلب استرداد المبلغ خلال 30 يوما من التسليم. "
                "يتم شحن الطلبات في يوم العمل نفسه إذا تمت قبل الساعة 14:00."),
]


@pytest.mark.parametrize(
    ("previous", "question", "expected", "previous_topic"),
    [
        (
            "How many days do customers have to request a refund?",
            "And how fast do orders ship?",
            "Orders placed before 14:00 ship the same business day. [2]",
            "refund",
        ),
        (
            "Сколько дней есть у клиентов на возврат денег после доставки?",
            "А как быстро отправляются заказы?",
            "Заказы отправляются в тот же рабочий день, если оформлены до 14:00. [3]",
            "возврат",
        ),
        (
            "كم يوما لدى العملاء لطلب استرداد المبلغ؟",
            "وماذا عن سرعة شحن الطلبات؟",
            "يتم شحن الطلبات في يوم العمل نفسه إذا تمت قبل الساعة 14:00. [4]",
            "استرداد",
        ),
    ],
    ids=["en", "ru", "ar"],
)
def test_extractive_follow_up_answers_the_new_question(previous, question, expected, previous_topic):
    history = [llm.Turn(previous, "...")]
    query = llm.build_retrieval_query(question, history)
    assert query == f"{question} {previous}"  # retrieval still sees both questions
    # Matched against the combined query, the previous question's sentence comes first.
    assert previous_topic in llm.extractive_answer(query, SUPPORT_HITS).split(" [")[0]

    answer = llm.generate_answer(question, SUPPORT_HITS, history, query)
    assert answer == expected
    # The fallback after a failed LLM call answers the same way.
    assert llm.answer_extractively(question, SUPPORT_HITS, query) == expected


@pytest.mark.parametrize(
    ("previous", "question", "expected"),
    [
        ("How many days do customers have to request a refund?", "Why?", "refund within 30 days"),
        ("How many days do customers have to request a refund?", "How long?", "refund within 30 days"),
        ("Сколько дней есть у клиентов на возврат денег после доставки?", "А когда?", "30 дней на возврат"),
        ("Сколько дней есть у клиентов на возврат денег после доставки?", "Как долго?", "30 дней на возврат"),
        ("كم يوما لدى العملاء لطلب استرداد المبلغ؟", "ومتى؟", "استرداد المبلغ خلال 30 يوما"),
        ("كم يوما لدى العملاء لطلب استرداد المبلغ؟", "وكم؟", "استرداد المبلغ خلال 30 يوما"),
    ],
    ids=["en-why", "en-how-long", "ru-when", "ru-how-long", "ar-when", "ar-how-many"],
)
def test_follow_up_without_a_topic_of_its_own_uses_the_combined_query(previous, question, expected):
    history = [llm.Turn(previous, "...")]
    query = llm.build_retrieval_query(question, history)
    assert llm.topic_words(question) == set()
    assert expected in llm.generate_answer(question, SUPPORT_HITS, history, query)


def test_topic_words_drop_connectors_back_references_and_joined_arabic_and():
    assert llm.topic_words("And does it apply to them too?") == {"apply", "too"}
    assert llm.topic_words("А это касается их подарочных карт?") == {"касается", "подарочных", "карт"}
    assert llm.topic_words("وماذا عن وقت الشحن؟") == {"وقت", "الشحن"}  # "وقت" (time) keeps its و
