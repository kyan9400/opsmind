"""Retrieval-quality evaluation: vector-only vs full-text-only vs hybrid (RRF).

Ingests the dataset into a throwaway tenant through the service's own /v1/ingest endpoint,
asks every question in each retrieval mode and scores where the expected document ranks.

    cd services/ai
    DATABASE_URL=postgres://... python -m eval.run_eval --out eval/results.md

Needs the app schema (apps/api migrations). Exits 1 if hybrid Recall@5 < --min-recall.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATASET_DIR = HERE / "dataset"
DOCS_DIR = DATASET_DIR / "docs"
QUESTIONS_FILE = DATASET_DIR / "questions.jsonl"

MODES = ("vector", "fts", "hybrid")
KINDS = ("exact", "natural", "paraphrase", "crosslingual")
CUTOFFS = (1, 3, 5)
MRR_DEPTH = 10
# Chunks fetched per query. Several chunks can come from one document, so this is deeper than
# the document cutoffs; it also keeps the candidate pool (4k = 40) close to production (20).
RETRIEVE_K = 10
MIME_TYPES = {".md": "text/markdown", ".txt": "text/plain"}


@dataclass(frozen=True)
class Question:
    question: str
    expected_doc: str
    lang: str
    kind: str


@dataclass(frozen=True)
class Document:
    filename: str
    title: str
    mime_type: str
    content: bytes


def load_documents(docs_dir: Path = DOCS_DIR) -> list[Document]:
    docs = []
    for path in sorted(docs_dir.iterdir()):
        if path.suffix not in MIME_TYPES:
            continue
        content = path.read_bytes()
        first_line = content.decode("utf-8").lstrip().splitlines()[0]
        docs.append(Document(path.name, first_line.lstrip("# ").strip(), MIME_TYPES[path.suffix], content))
    return docs


def load_questions(path: Path = QUESTIONS_FILE, known_docs: set[str] | None = None) -> list[Question]:
    questions = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        q = Question(**json.loads(line))
        # A typo in the dataset would silently count as a miss in every mode; fail loudly instead.
        if q.kind not in KINDS:
            raise ValueError(f"{path.name}:{n}: unknown kind {q.kind!r}")
        if known_docs is not None and q.expected_doc not in known_docs:
            raise ValueError(f"{path.name}:{n}: unknown expected_doc {q.expected_doc!r}")
        questions.append(q)
    return questions


def dedupe(items: list[str]) -> list[str]:
    """Keep the first occurrence: a document ranks where its best chunk ranks."""
    return list(dict.fromkeys(items))


def first_rank(ranked_docs: list[str], expected: str) -> int | None:
    """1-based rank of `expected` in a document ranking, or None if it was not retrieved."""
    try:
        return ranked_docs.index(expected) + 1
    except ValueError:
        return None


def score(ranks: list[int | None]) -> dict[str, float]:
    n = len(ranks)
    if n == 0:
        return {"n": 0, **{f"recall@{k}": 0.0 for k in CUTOFFS}, f"mrr@{MRR_DEPTH}": 0.0}
    out: dict[str, float] = {"n": n}
    for k in CUTOFFS:
        out[f"recall@{k}"] = sum(1 for r in ranks if r is not None and r <= k) / n
    out[f"mrr@{MRR_DEPTH}"] = sum(1 / r for r in ranks if r is not None and r <= MRR_DEPTH) / n
    return out


def summarize(results: list[dict]) -> dict:
    """Metrics per mode: overall, by question kind and by question language."""
    summary: dict = {}
    for mode in MODES:
        by_kind: dict[str, list] = defaultdict(list)
        by_lang: dict[str, list] = defaultdict(list)
        for r in results:
            by_kind[r["kind"]].append(r["ranks"][mode])
            by_lang[r["lang"]].append(r["ranks"][mode])
        summary[mode] = {
            "overall": score([r["ranks"][mode] for r in results]),
            "by_kind": {k: score(v) for k, v in sorted(by_kind.items(), key=lambda kv: _kind_order(kv[0]))},
            "by_lang": {k: score(v) for k, v in sorted(by_lang.items())},
        }
    return summary


def _kind_order(kind: str) -> int:
    return KINDS.index(kind) if kind in KINDS else len(KINDS)


def _pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def render_markdown(summary: dict, results: list[dict], meta: dict) -> str:
    mrr = f"mrr@{MRR_DEPTH}"
    lines = [
        "## Retrieval quality",
        "",
        f"{meta['questions']} questions over {meta['documents']} documents ({meta['chunks']} chunks), "
        f"embeddings: `{meta['embed_provider']}`. Document-level ranks; the expected document counts as "
        f"found at the rank of its best chunk (top {RETRIEVE_K} chunks per query).",
        "",
        f"| Mode | Recall@1 | Recall@3 | Recall@5 | MRR@{MRR_DEPTH} |",
        "|---|---:|---:|---:|---:|",
    ]
    for mode in MODES:
        o = summary[mode]["overall"]
        name = f"**{mode}**" if mode == "hybrid" else mode
        lines.append(f"| {name} | {' | '.join(_pct(o[f'recall@{k}']) for k in CUTOFFS)} | {o[mrr]:.3f} |")

    for group, title in (("by_kind", "question kind"), ("by_lang", "question language")):
        lines += [
            "",
            f"**Recall@5 / MRR@{MRR_DEPTH} by {title}**",
            "",
            "| " + title.capitalize() + " | n | " + " | ".join(MODES) + " |",
            "|---|---:|" + "---:|" * len(MODES),
        ]
        for key, metrics in summary["hybrid"][group].items():
            cells = [
                f"{_pct(summary[m][group][key]['recall@5'])} / {summary[m][group][key][mrr]:.2f}"
                for m in MODES
            ]
            lines.append(f"| {key} | {int(metrics['n'])} | " + " | ".join(cells) + " |")

    misses = [r for r in results if r["ranks"]["hybrid"] is None or r["ranks"]["hybrid"] > 5]
    lines += ["", f"**Hybrid misses at 5** ({len(misses)})", ""]
    if not misses:
        lines.append("None.")
    else:
        lines += ["| Question | Kind | Expected | Hybrid top 3 |", "|---|---|---|---|"]
        for r in misses:
            top = ", ".join(r["top"]["hybrid"][:3]) or "(nothing)"
            question = r["question"].replace("|", "\\|")
            lines.append(f"| {question} | {r['kind']} | {r['expected_doc']} | {top} |")
    return "\n".join(lines) + "\n"


def evaluate(docs: list[Document], questions: list[Question]) -> tuple[list[dict], dict]:
    """Ingest into a fresh tenant, run every question in every mode, then drop the tenant."""
    # Imported here so the dataset and metric helpers stay usable (and testable) without a database.
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.db import get_pool
    from app.embeddings import embed_batched, get_embedder
    from app.main import app
    from app.retrieval import hybrid_search

    client = TestClient(app)
    pool = get_pool()
    with pool.connection() as conn:
        tenant_id = str(
            conn.execute(
                "INSERT INTO tenants (name) VALUES (%s) RETURNING id", (f"rag-eval-{uuid.uuid4().hex[:8]}",)
            ).fetchone()[0]
        )

    try:
        filenames: dict[str, str] = {}
        chunks = 0
        for doc in docs:
            with pool.connection() as conn:
                doc_id = str(
                    conn.execute(
                        """INSERT INTO documents (tenant_id, title, filename, mime_type, size_bytes, content)
                           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                        (tenant_id, doc.title, doc.filename, doc.mime_type, len(doc.content), doc.content),
                    ).fetchone()[0]
                )
            # Same path as production: extract -> chunk -> embed -> transactional insert.
            res = client.post(
                "/v1/ingest",
                json={"document_id": doc_id},
                headers={"x-internal-token": settings.internal_token},
            )
            if res.status_code != 200:
                raise RuntimeError(f"ingest of {doc.filename} failed: {res.status_code} {res.text}")
            chunks += res.json()["chunks"]
            filenames[doc_id] = doc.filename

        # One embedding per question, shared by all modes, exactly as /v1/ask embeds the question.
        qvecs = embed_batched(get_embedder(), [q.question for q in questions])
        results = []
        with pool.connection() as conn:
            for q, qvec in zip(questions, qvecs):
                ranks: dict[str, int | None] = {}
                top: dict[str, list[str]] = {}
                for mode in MODES:
                    hits = hybrid_search(conn, tenant_id, q.question, qvec, k=RETRIEVE_K, mode=mode)
                    ranked = dedupe([filenames[h.document_id] for h in hits])
                    ranks[mode] = first_rank(ranked, q.expected_doc)
                    top[mode] = ranked[:5]
                results.append({**asdict(q), "ranks": ranks, "top": top})
    finally:
        with pool.connection() as conn:
            # documents and chunks go with the tenant (ON DELETE CASCADE).
            conn.execute("DELETE FROM tenants WHERE id = %s", (tenant_id,))

    meta = {
        "embed_provider": settings.embed_provider,
        "documents": len(docs),
        "chunks": chunks,
        "questions": len(questions),
        "retrieve_k": RETRIEVE_K,
    }
    return results, meta


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out", type=Path, default=HERE / "results.md", help="markdown report path")
    parser.add_argument(
        "--json", type=Path, default=None, help="JSON report path (default: --out with .json)"
    )
    # Calibrated against the offline hash embedder in CI, with a small margin; see eval/README.md.
    parser.add_argument("--min-recall", type=float, default=0.8, help="fail if hybrid Recall@5 is below this")
    args = parser.parse_args(argv)

    docs = load_documents()
    questions = load_questions(known_docs={d.filename for d in docs})
    results, meta = evaluate(docs, questions)
    summary = summarize(results)

    report = render_markdown(summary, results, meta)
    sys.stdout.write(report)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report, encoding="utf-8")
    json_path = args.json or args.out.with_suffix(".json")
    json_path.write_text(
        json.dumps({"meta": meta, "summary": summary, "questions": results}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    hybrid_r5 = summary["hybrid"]["overall"]["recall@5"]
    if hybrid_r5 < args.min_recall:
        print(f"FAIL: hybrid Recall@5 {hybrid_r5:.3f} < --min-recall {args.min_recall:.3f}", file=sys.stderr)
        return 1
    print(f"OK: hybrid Recall@5 {hybrid_r5:.3f} >= {args.min_recall:.3f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
