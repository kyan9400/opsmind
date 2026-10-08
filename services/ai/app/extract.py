import io
import re

from pypdf import PdfReader


class DocumentTooLong(ValueError):
    """An upload over an ingest limit. /v1/ingest answers 422, which the API does not retry."""


def extract_text(content: bytes, mime_type: str, max_chars: int = 0, max_pdf_pages: int = 0) -> str:
    """Return normalised plain text from an uploaded file. A limit of 0 means no limit."""
    if mime_type == "application/pdf":
        text = _pdf_text(content, max_chars, max_pdf_pages)
    else:
        text = normalise(content.decode("utf-8", errors="replace"))
    if 0 < max_chars < len(text):
        raise DocumentTooLong(f"document too long: {len(text):,} characters of text (limit {max_chars:,})")
    return text


def _pdf_text(content: bytes, max_chars: int, max_pages: int) -> str:
    reader = PdfReader(io.BytesIO(content))
    pages = len(reader.pages)
    if 0 < max_pages < pages:
        raise DocumentTooLong(f"document too long: {pages} pages (limit {max_pages})")
    parts: list[str] = []
    total = 0
    for page in reader.pages:
        part = normalise(page.extract_text() or "")
        total += len(part)
        # Stop at the first page over the limit: compressed page streams can hold far more text than
        # the upload's size suggests, and every further page costs CPU for nothing.
        if 0 < max_chars < total:
            raise DocumentTooLong(f"document too long: more than {max_chars:,} characters of text")
        parts.append(part)
    return normalise("\n\n".join(parts))


def normalise(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\x00", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
