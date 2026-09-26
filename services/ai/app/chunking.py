from pydantic import BaseModel


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
