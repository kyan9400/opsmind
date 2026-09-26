from functools import lru_cache

from pgvector.psycopg import register_vector
from psycopg_pool import ConnectionPool

from .config import settings


@lru_cache(maxsize=1)
def get_pool() -> ConnectionPool:
    return ConnectionPool(
        settings.database_url,
        min_size=1,
        max_size=10,
        configure=register_vector,
        open=True,
    )
