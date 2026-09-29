from typing import Literal

import numpy as np
from psycopg import Connection
from pydantic import BaseModel

from .embeddings import tokenize

# Reciprocal Rank Fusion constant; 60 is the value from the original RRF paper.
RRF_K = 60

SearchMode = Literal["hybrid", "vector", "fts"]

VEC_CTE = """vec AS (
  SELECT id, row_number() OVER (ORDER BY embedding <=> %(qvec)s) AS r
    FROM chunks
   WHERE tenant_id = %(tenant)s
   ORDER BY embedding <=> %(qvec)s
   LIMIT %(pool)s
)"""

FTS_CTE = """fts AS (
  SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS r
    FROM chunks c, to_tsquery('simple', %(fts_query)s) q
   WHERE c.tenant_id = %(tenant)s AND c.tsv @@ q
   ORDER BY ts_rank_cd(c.tsv, q) DESC
   LIMIT %(pool)s
)"""

# Function words carry no topic. The 'simple' config keeps them (it has no language-specific
# stemming, so EN/RU/AR tokenize alike), so they are dropped here before building the query.
STOPWORDS = frozenset(
    """a an and are as at be by can do does for from has have how i if in is it its me my of on or
    our should the their there this to was we what when where which who why will with you your
    и в во на не что как а по к у о об из за для до от же ли или это мы вы я мне мой наш
    какой какая какие какое когда где кто почему сколько можно нужно ли есть был была были
    في من على إلى عن ما ماذا كيف هل هو هي أن إن كان التي الذي مع أو لا هذا هذه عند متى أين""".split()
)
MAX_QUERY_TERMS = 16


def fts_query(question: str) -> str:
    """OR of the question's content words for to_tsquery.

    websearch_to_tsquery ANDs every word, so a natural question ("how many days do I have to
    return an item?") matched almost nothing; any-word matching with ts_rank_cd ranking lets
    chunks covering more of the question rise to the top. Tokens are \\w+ only, so no escaping
    is needed. An empty string yields an empty query that matches nothing.
    """
    terms: list[str] = []
    for token in tokenize(question):
        if token not in STOPWORDS and token not in terms:
            terms.append(token)
    return " | ".join(terms[:MAX_QUERY_TERMS])


def _search_sql(ctes: dict[str, str]) -> str:
    # Every mode shares the fusion query. With one source, 1/(k + r) is monotonic in r, so the
    # result is exactly that retriever's own ranking; modes differ only in which lists exist.
    ranked = " UNION ALL ".join(f"SELECT * FROM {name}" for name in ctes)
    candidates = ",\n".join(ctes.values())
    return f"""
WITH {candidates},
fused AS (
  SELECT id, SUM(1.0 / (%(rrf_k)s + r)) AS score
    FROM ({ranked}) ranked
   GROUP BY id
)
SELECT c.id, c.document_id, d.title, c.chunk_index, c.content, f.score
  FROM fused f
  JOIN chunks c ON c.id = f.id
  JOIN documents d ON d.id = c.document_id
 ORDER BY f.score DESC
 LIMIT %(k)s
"""


HYBRID_SQL = _search_sql({"vec": VEC_CTE, "fts": FTS_CTE})
# Vector-only and full-text-only exist for the retrieval evaluation (services/ai/eval).
SEARCH_SQL: dict[str, str] = {
    "hybrid": HYBRID_SQL,
    "vector": _search_sql({"vec": VEC_CTE}),
    "fts": _search_sql({"fts": FTS_CTE}),
}


class Hit(BaseModel):
    chunk_id: int
    document_id: str
    title: str
    chunk_index: int
    content: str
    score: float


def hybrid_search(
    conn: Connection,
    tenant_id: str,
    query: str,
    qvec: list[float],
    k: int = 5,
    mode: SearchMode = "hybrid",
) -> list[Hit]:
    """Vector (cosine) + full-text candidates, merged with RRF. Always tenant-scoped.

    `mode` restricts the candidates to one retriever; production always uses "hybrid".
    """
    if mode not in SEARCH_SQL:
        raise ValueError(f"unknown search mode {mode!r}")
    rows = conn.execute(
        SEARCH_SQL[mode],
        {
            "qvec": np.asarray(qvec, dtype=np.float32),
            "tenant": tenant_id,
            "fts_query": fts_query(query),
            "pool": max(k * 4, 20),
            "rrf_k": RRF_K,
            "k": k,
        },
    ).fetchall()
    return [
        Hit(
            chunk_id=r[0],
            document_id=str(r[1]),
            title=r[2],
            chunk_index=r[3],
            content=r[4],
            score=float(r[5]),
        )
        for r in rows
    ]
