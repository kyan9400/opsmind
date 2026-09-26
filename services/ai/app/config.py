import os
from dataclasses import dataclass, field


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default_factory=lambda: _env("DATABASE_URL", "postgres://opsmind:opsmind@localhost:5432/opsmind"))
    internal_token: str = field(default_factory=lambda: _env("AI_SERVICE_TOKEN", "dev-internal-token-change-me"))

    # Embeddings: "hash" (offline, deterministic), "openai", "ollama". Dimension is fixed by the schema.
    embed_provider: str = field(default_factory=lambda: _env("EMBED_PROVIDER", "hash"))
    embed_dim: int = 768

    # Answers: "extractive" (offline, no LLM), "openai", "anthropic", "ollama".
    llm_provider: str = field(default_factory=lambda: _env("LLM_PROVIDER", "extractive"))

    openai_api_key: str = field(default_factory=lambda: _env("OPENAI_API_KEY", ""))
    openai_embed_model: str = field(default_factory=lambda: _env("OPENAI_EMBED_MODEL", "text-embedding-3-small"))
    openai_chat_model: str = field(default_factory=lambda: _env("OPENAI_CHAT_MODEL", "gpt-4o-mini"))
    anthropic_api_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY", ""))
    anthropic_model: str = field(default_factory=lambda: _env("ANTHROPIC_MODEL", "claude-sonnet-5"))
    ollama_url: str = field(default_factory=lambda: _env("OLLAMA_URL", "http://localhost:11434"))
    ollama_embed_model: str = field(default_factory=lambda: _env("OLLAMA_EMBED_MODEL", "nomic-embed-text"))
    ollama_chat_model: str = field(default_factory=lambda: _env("OLLAMA_CHAT_MODEL", "llama3.1"))


settings = Settings()
