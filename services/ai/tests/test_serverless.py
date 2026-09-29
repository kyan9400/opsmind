"""The serverless profile (deploy/vercel): the entrypoint Vercel imports and the switches it sets."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from psycopg_pool import ConnectionPool

import app.db as db
from app.config import Settings

ROOT = Path(__file__).resolve().parents[1]


def test_vercel_entrypoint_is_the_app():
    from app.main import app
    from index import app as entry

    assert entry is app and isinstance(entry, FastAPI)


def _metrics_status(**env: str) -> int:
    # Settings are read once, at import; a fresh interpreter sees the variable.
    code = (
        "from fastapi.testclient import TestClient; from index import app; "
        "print(TestClient(app).get('/metrics').status_code)"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT, env={**os.environ, **env}, capture_output=True, text=True, check=True
    )
    return int(out.stdout.split()[-1])


def test_metrics_can_be_hidden_on_hosts_without_a_private_network():
    assert _metrics_status(METRICS_PUBLIC="false") == 404
    assert _metrics_status(METRICS_PUBLIC="") == 200  # unset keeps the default


def test_switches_default_to_the_container_behaviour(monkeypatch):
    for name in ("DB_POOL_MAX", "DB_POOL_CHECK", "METRICS_PUBLIC"):
        monkeypatch.delenv(name, raising=False)
    s = Settings()
    assert (s.db_pool_max, s.db_pool_check, s.metrics_public) == (10, False, True)

    monkeypatch.setenv("DB_POOL_MAX", "2")
    monkeypatch.setenv("DB_POOL_CHECK", "TRUE")
    monkeypatch.setenv("METRICS_PUBLIC", "0")
    s = Settings()
    assert (s.db_pool_max, s.db_pool_check, s.metrics_public) == (2, True, False)

    # A field cleared in a hosting dashboard arrives as "", which means unset.
    for name in ("DB_POOL_MAX", "DB_POOL_CHECK", "METRICS_PUBLIC"):
        monkeypatch.setenv(name, "")
    s = Settings()
    assert (s.db_pool_max, s.db_pool_check, s.metrics_public) == (10, False, True)

    monkeypatch.setenv("METRICS_PUBLIC", "no")
    with pytest.raises(ValueError, match="METRICS_PUBLIC"):
        Settings()
    monkeypatch.delenv("METRICS_PUBLIC")
    monkeypatch.setenv("DB_POOL_MAX", "two")
    with pytest.raises(ValueError, match="DB_POOL_MAX"):
        Settings()


@pytest.mark.parametrize("check", [False, True])
def test_pool_follows_the_switches(monkeypatch, check):
    seen: dict = {}

    class Recorder(ConnectionPool):
        def __init__(self, conninfo: str, **kwargs):  # records instead of connecting
            seen.update(kwargs)

        def __del__(self):
            pass

    monkeypatch.setenv("DB_POOL_MAX", "3")
    monkeypatch.setenv("DB_POOL_CHECK", str(check).lower())
    monkeypatch.setattr(db, "settings", Settings())
    monkeypatch.setattr(db, "ConnectionPool", Recorder)
    db.get_pool.cache_clear()
    try:
        db.get_pool()
    finally:
        db.get_pool.cache_clear()
    assert seen["max_size"] == 3 and seen["min_size"] == 1
    assert (seen["check"] is not None) == check
