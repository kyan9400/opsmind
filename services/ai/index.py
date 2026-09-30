"""Vercel entrypoint (deploy/vercel/README.md).

Vercel's Python runtime serves the top-level ``app`` of the first of app.py, index.py, main.py, ...
it finds; this re-export makes the choice explicit and imports app.main as a package, so its relative
imports work. Containers keep running ``uvicorn app.main:app``.
"""

from app.main import app

__all__ = ["app"]
