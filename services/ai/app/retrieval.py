import numpy as np
from psycopg import Connection
from pydantic import BaseModel

# Reciprocal Rank Fusion constant; 60 is the value from the original RRF paper.
RRF_K = 60

HYBRID_SQL = """
WITH vec AS (
  SELECT id, row_number() OVER (ORDER BY embedding <=> %(qvec)s) AS r
    FROM chunks
   WHERE tenant_id = %(tenant)s
   ORDER BY embedding <=> %(qvec)s
   LIMIT %(pool)s
),
fts AS (
  SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS r
    FROM chunks c, websearch_to_tsquery('simple', %(query)s) q
   WHERE c.tenant_id = %(tenant)s AND c.tsv @@ q
   ORDER BY ts_rank_cd(c.tsv, q) DESC
   LIMIT %(pool)s
),
fused AS (
  SELECT id, SUM(1.0 / (%(rrf_k)s + r)) AS score
    FROM (SELECT * FROM vec UNION ALL SELECT * FROM fts) ranked
   GROUP BY id
)
SELECT c.id, c.document_id, d.title, c.chunk_index, c.content, f.score
  FROM fused f
  JOIN chunks c ON c.id = f.id
  JOIN documents d ON d.id = c.document_id
 ORDER BY f.score DESC
 LIMIT %(k)s
"""


class Hit(BaseModel):
    chunk_id: int
    document_id: str
    title: str
    chunk_index: int
    content: str
    score: float


def hybrid_search(conn: Connection, tenant_id: str, query: str, qvec: list[float], k: int = 5) -> list[Hit]:
    """Vector (cosine) + full-text candidates, merged with RRF. Always tenant-scoped."""
    rows = conn.execute(
        HYBRID_SQL,
        {
            "qvec": np.asarray(qvec, dtype=np.float32),
            "tenant": tenant_id,
            "query": query,
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
