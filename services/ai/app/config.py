import os
from dataclasses import dataclass, field


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _flag(name: str, default: bool) -> bool:
    """An on/off switch: true/false or 1/0; unset or empty keeps the default."""
    value = os.environ.get(name, "").strip().lower()
    if not value:
        return default
    if value not in ("true", "false", "1", "0"):
        raise ValueError(f"{name} must be true or false, got {value!r}")
    return value in ("true", "1")


def _int(name: str, default: int) -> int:
    """A whole number; unset or empty keeps the default (a cleared dashboard field arrives as "")."""
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        raise ValueError(f"{name} must be a whole number, got {value!r}") from None


def _float(name: str, default: float) -> float:
    """A decimal number; unset or empty keeps the default."""
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    try:
        return float(value)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {value!r}") from None


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default_factory=lambda: _env("DATABASE_URL", "postgres://opsmind:opsmind@localhost:5432/opsmind"))
    internal_token: str = field(default_factory=lambda: _env("AI_SERVICE_TOKEN", "dev-internal-token-change-me"))

    # Embeddings: "hash" (offline, deterministic), "openai", "ollama". Dimension is fixed by the schema.
    embed_provider: str = field(default_factory=lambda: _env("EMBED_PROVIDER", "hash"))
    embed_dim: int = 768

    # Answers: "extractive" (offline, no LLM), "openai", "anthropic", "ollama", "openai-compatible".
    llm_provider: str = field(default_factory=lambda: _env("LLM_PROVIDER", "extractive"))

    # Any /chat/completions endpoint (Groq, OpenRouter, Together, vLLM...): one adapter, no SDK per vendor.
    llm_base_url: str = field(default_factory=lambda: _env("LLM_BASE_URL", ""))
    llm_api_key: str = field(default_factory=lambda: _env("LLM_API_KEY", ""))
    llm_model: str = field(default_factory=lambda: _env("LLM_MODEL", ""))
    llm_timeout_s: float = field(default_factory=lambda: _float("LLM_TIMEOUT_S", 30.0))
    llm_max_tokens: int = field(default_factory=lambda: _int("LLM_MAX_TOKENS", 400))

    openai_api_key: str = field(default_factory=lambda: _env("OPENAI_API_KEY", ""))
    openai_embed_model: str = field(default_factory=lambda: _env("OPENAI_EMBED_MODEL", "text-embedding-3-small"))
    openai_chat_model: str = field(default_factory=lambda: _env("OPENAI_CHAT_MODEL", "gpt-4o-mini"))
    anthropic_api_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY", ""))
    anthropic_model: str = field(default_factory=lambda: _env("ANTHROPIC_MODEL", "claude-sonnet-5"))
    ollama_url: str = field(default_factory=lambda: _env("OLLAMA_URL", "http://localhost:11434"))
    ollama_embed_model: str = field(default_factory=lambda: _env("OLLAMA_EMBED_MODEL", "nomic-embed-text"))
    ollama_chat_model: str = field(default_factory=lambda: _env("OLLAMA_CHAT_MODEL", "llama3.1"))

    # Postgres pool. The defaults suit the long-running container. Serverless hosts (deploy/vercel) run
    # many small instances against one pooled database, so they keep the pool small and check each
    # connection before use: an idle one may have died while the instance was frozen (Neon also closes
    # connections when it suspends an idle compute).
    db_pool_max: int = field(default_factory=lambda: _int("DB_POOL_MAX", 10))
    db_pool_check: bool = field(default_factory=lambda: _flag("DB_POOL_CHECK", False))
    # false turns off psycopg's automatic prepared statements. Transaction-mode poolers that hand each
    # transaction a different server connection (Supabase's Supavisor on port 6543) cannot keep them.
    db_prepared_statements: bool = field(default_factory=lambda: _flag("DB_PREPARED_STATEMENTS", True))

    # false drops GET /metrics. With no private network or proxy in front (Vercel), it would be public.
    metrics_public: bool = field(default_factory=lambda: _flag("METRICS_PUBLIC", True))


settings = Settings()
