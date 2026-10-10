import io
import math
import re
import time
from contextlib import nullcontext

from pypdf import PdfReader, apply_configuration
from pypdf.errors import LimitReachedError

# Largest single decoded PDF stream. pypdf parses a whole content stream before text extraction sees
# its first operator, and that parse cannot be interrupted: ~2 s and ~50 MB of RAM per MB of tiny
# drawing operators. Real pages hold far less (a browser-printed text page is ~100 KB).
PDF_MAX_STREAM_BYTES = 4_000_000
_STREAM_LIMITS = (
    "zlib_maximum_output_length",
    "lzw_maximum_output_length",
    "run_length_maximum_output_length",
    "array_based_stream_maximum_output_length",
)


class DocumentOverLimit(ValueError):
    """An upload over an ingest limit. /v1/ingest answers 422, which the API does not retry."""


def extract_text(
    content: bytes,
    mime_type: str,
    max_chars: int = 0,
    max_pdf_pages: int = 0,
    max_pdf_content_bytes: int = 0,
    max_pdf_seconds: float = 0,
) -> str:
    """Return normalised plain text from an uploaded file. A limit of 0 means no limit."""
    if mime_type == "application/pdf":
        text = _pdf_text(content, max_chars, max_pdf_pages, max_pdf_content_bytes, max_pdf_seconds)
    else:
        text = normalise(content.decode("utf-8", errors="replace"))
    if 0 < max_chars < len(text):
        raise DocumentOverLimit(f"document too long: {len(text):,} characters of text (limit {max_chars:,})")
    return text


class _Deadline:
    """Raises once `seconds` have passed (0: never)."""

    def __init__(self, seconds: float):
        self.seconds = seconds
        self.at = time.monotonic() + seconds if seconds > 0 else math.inf

    def check(self, *_visitor_args) -> None:
        if time.monotonic() > self.at:
            raise DocumentOverLimit(f"document too complex: reading the PDF took over {self.seconds:g} s")


def _pdf_text(content: bytes, max_chars: int, max_pages: int, max_content: int, max_seconds: float) -> str:
    # The character and page limits cannot see a page that draws without writing text: operators
    # such as "BT ET" or "0 0 m" cost parse time but produce no characters, and a few KB of Flate
    # data decode to MBs of them. So the decoded page content is budgeted before anything is parsed,
    # and a deadline covers what that budget cannot (form XObjects are parsed again on every use).
    deadline = _Deadline(max_seconds)
    cap = min(PDF_MAX_STREAM_BYTES, max_content) if max_content > 0 else 0
    limits = apply_configuration(**dict.fromkeys(_STREAM_LIMITS, cap)) if cap else nullcontext()
    try:
        with limits:
            return _pdf_pages_text(content, max_chars, max_pages, max_content, deadline)
    except LimitReachedError as exc:
        raise DocumentOverLimit(f"document too complex: PDF over a decoding limit ({exc})") from exc


def _pdf_pages_text(
    content: bytes, max_chars: int, max_pages: int, max_content: int, deadline: _Deadline
) -> str:
    reader = PdfReader(io.BytesIO(content))
    pages = len(reader.pages)
    if 0 < max_pages < pages:
        raise DocumentOverLimit(f"document too long: {pages} pages (limit {max_pages})")

    # Decoding is cheap and cached for extraction; a stream shared by many pages counts once per page,
    # because each page parses it again.
    total = 0
    for page in reader.pages:
        deadline.check()
        try:
            contents = page.get_contents()
        except (AttributeError, KeyError):  # malformed /Contents: extract_text reads it as an empty page
            contents = None
        total += len(contents.get_data()) if contents is not None else 0
        if 0 < max_content < total:
            raise DocumentOverLimit(
                f"document too complex: more than {max_content / 1e6:g} MB of PDF page content"
            )

    parts: list[str] = []
    chars = 0
    for page in reader.pages:
        deadline.check()
        # The visitor runs before every operator, so a slow page stops at the deadline, not at its end.
        part = normalise(page.extract_text(visitor_operand_before=deadline.check) or "")
        # pypdf catches and logs errors inside form XObjects, the deadline's included: check again.
        deadline.check()
        chars += len(part)
        # Stop at the first page over the limit: compressed page streams can hold far more text than
        # the upload's size suggests, and every further page costs CPU for nothing.
        if 0 < max_chars < chars:
            raise DocumentOverLimit(f"document too long: more than {max_chars:,} characters of text")
        parts.append(part)
    return normalise("\n\n".join(parts))


_SURROGATE = re.compile(r"[\ud800-\udfff]")


def normalise(text: str) -> str:
    # pypdf decodes broken ToUnicode maps with "surrogatepass", which can leave halves of UTF-16 pairs
    # in the text, and the database cannot store them. A round trip through UTF-16 rejoins the halves
    # that pair up and turns the rest into U+FFFD.
    if _SURROGATE.search(text):
        text = text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")
    text = text.replace("\r\n", "\n").replace("\x00", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
