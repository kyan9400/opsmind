from contextlib import contextmanager
from types import SimpleNamespace

import pytest

import app.llm as llm


class LlmUsage:
    """Stands in for the llm_usage table: today's count, refused at the cap like the real statement."""

    def __init__(self):
        self.calls = 0

    @contextmanager
    def connection(self):
        yield self

    def execute(self, sql: str, params: tuple):
        assert "INSERT INTO llm_usage" in sql
        [cap] = params
        if self.calls >= cap:
            return SimpleNamespace(fetchone=lambda: None)
        self.calls += 1
        return SimpleNamespace(fetchone=lambda: (self.calls,))


@pytest.fixture(autouse=True)
def llm_usage(monkeypatch) -> LlmUsage:
    """Every LLM call counts against LLM_DAILY_MAX, in memory: no unit test needs a database for it."""
    usage = LlmUsage()
    monkeypatch.setattr(llm, "get_pool", lambda: usage)
    return usage
