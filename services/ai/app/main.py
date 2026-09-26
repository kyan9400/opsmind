"""OpsMind AI service.

Week 1: health + a deterministic text chunker (the first stage of the RAG pipeline).
Week 2 adds embeddings, pgvector storage, hybrid retrieval and cited answers.
"""

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="OpsMind AI", version="0.1.0")


class ChunkRequest(BaseModel):
    text: str = Field(min_length=1)
    max_chars: int = Field(default=800, ge=100, le=4000)
    overlap: int = Field(default=100, ge=0, le=1000)


class Chunk(BaseModel):
    index: int
    start: int
    end: int
    text: str


def chunk_text(text: str, max_chars: int = 800, overlap: int = 100) -> list[Chunk]:
    """Split text into overlapping windows, preferring paragraph/sentence boundaries."""
    if overlap >= max_chars:
        raise ValueError("overlap must be smaller than max_chars")

    chunks: list[Chunk] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + max_chars, n)
        if end < n:
            window = text[start:end]
            # Break at the last natural boundary in the back half of the window.
            for sep in ("\n\n", "\n", ". ", " "):
                cut = window.rfind(sep, max_chars // 2)
                if cut != -1:
                    end = start + cut + len(sep)
                    break
        piece = text[start:end].strip()
        if piece:
            chunks.append(Chunk(index=len(chunks), start=start, end=end, text=piece))
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return chunks


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/chunk", response_model=list[Chunk])
def chunk(req: ChunkRequest) -> list[Chunk]:
    return chunk_text(req.text, req.max_chars, req.overlap)
