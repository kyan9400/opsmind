import re

from pydantic import BaseModel

# Where a chunk after the first may begin, best first. Starting part way through a word would put a
# broken word at the top of its source snippet and hand the extractive answer a fragment to quote.
_LINE_START = re.compile(r"(?:(?<=\n)|(?<=\n ))(?=\S)")
_SENTENCE_START = re.compile(r"(?<=[.!?؟。…]\s)(?=\S)")
_WORD_START = re.compile(r"(?<=\s)(?=\S)")


class Chunk(BaseModel):
    index: int
    start: int
    end: int
    text: str


def chunk_text(text: str, max_chars: int = 800, overlap: int = 100) -> list[Chunk]:
    """Split text into overlapping windows that end at paragraph or sentence boundaries where they can
    and start at a line, sentence or word (see _next_start)."""
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
        start = _next_start(text, start, end, overlap)
    return chunks


def _next_start(text: str, start: int, end: int, overlap: int) -> int:
    """Where the chunk after text[start:end] begins: within its last `overlap` characters, or at `end`.

    At the first line start there (the cut itself counts), else at the first sentence start. So the
    overlap repeats whole lines or sentences, and a chunk cut at a boundary with none in its overlap is
    followed without overlap: repeating part of a sentence would only add a fragment. Only when the cut
    split a sentence does the next chunk repeat that sentence's tail, from a whole word.
    """
    lo = max(end - overlap, start + 1)
    for boundary in (_LINE_START, _SENTENCE_START):
        if m := boundary.search(text, lo, end + 1):
            return m.start()
    m = _WORD_START.search(text, lo, end)
    return m.start() if m else lo  # a "word" longer than the overlap (a URL, a hash): nothing to align to
