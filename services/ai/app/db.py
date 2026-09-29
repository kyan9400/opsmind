from functools import lru_cache

from pgvector.psycopg import register_vector
from psycopg_pool import ConnectionPool

from .config import settings


@lru_cache(maxsize=1)
def get_pool() -> ConnectionPool:
    return ConnectionPool(
        settings.database_url,
        min_size=1,
        max_size=settings.db_pool_max,
        # Costs one round trip per checkout, and swaps a dead connection for a fresh one instead of
        # failing the request (see Settings.db_pool_check).
        check=ConnectionPool.check_connection if settings.db_pool_check else None,
        configure=register_vector,
        open=True,
    )
