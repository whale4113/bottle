"""Compatibility import for the packaged RAG API."""

from rag_api.server import app, main

__all__ = ["app", "main"]

if __name__ == "__main__":
    main()
