"""Embedding providers behind one interface.

`HashEmbedder` is a deterministic feature-hashing embedder: no model, no network.
It captures lexical overlap only, which is enough for offline dev, CI and demos;
use `openai` or `ollama` for real semantic search.
"""

import hashlib
import math
import re
from typing import Protocol

import httpx

from .config import settings

TOKEN_RE = re.compile(r"\w+", re.UNICODE)


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


class Embedder(Protocol):
    name: str

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class HashEmbedder:
    name = "hash"

    def __init__(self, dim: int = settings.embed_dim):
        self.dim = dim

    def _vector(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        tokens = tokenize(text)
        features = tokens + [f"{a} {b}" for a, b in zip(tokens, tokens[1:])]
        for feat in features:
            h = int.from_bytes(hashlib.blake2b(feat.encode(), digest_size=8).digest(), "little")
            vec[h % self.dim] += 1.0 if (h >> 63) & 1 else -1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(t) for t in texts]


class OpenAIEmbedder:
    name = "openai"

    def embed(self, texts: list[str]) -> list[list[float]]:
        res = httpx.post(
            "https://api.openai.com/v1/embeddings",
            headers={"authorization": f"Bearer {settings.openai_api_key}"},
            json={"model": settings.openai_embed_model, "input": texts, "dimensions": settings.embed_dim},
            timeout=60,
        )
        res.raise_for_status()
        return [d["embedding"] for d in sorted(res.json()["data"], key=lambda d: d["index"])]


class OllamaEmbedder:
    name = "ollama"

    def embed(self, texts: list[str]) -> list[list[float]]:
        res = httpx.post(
            f"{settings.ollama_url}/api/embed",
            json={"model": settings.ollama_embed_model, "input": texts},
            timeout=120,
        )
        res.raise_for_status()
        return res.json()["embeddings"]


def get_embedder() -> Embedder:
    providers: dict[str, type] = {"hash": HashEmbedder, "openai": OpenAIEmbedder, "ollama": OllamaEmbedder}
    if settings.embed_provider not in providers:
        raise ValueError(f"unknown EMBED_PROVIDER {settings.embed_provider!r}")
    return providers[settings.embed_provider]()


def embed_batched(embedder: Embedder, texts: list[str], batch_size: int = 64) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), batch_size):
        out.extend(embedder.embed(texts[i : i + batch_size]))
    return out
