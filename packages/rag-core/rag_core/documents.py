"""Document discovery and loading helpers."""

from __future__ import annotations

from pathlib import Path

from .markdown import load_markdown
from .models import Chunk


def default_docs(root: Path | None = None) -> list[Path]:
    search_root = root or Path.cwd()
    return sorted(
        path
        for path in search_root.rglob("*.md")
        if not path.name.lower().startswith("readme")
    )


def load_chunks(paths: list[Path]) -> list[Chunk]:
    docs = [path for path in paths if path.exists() and path.suffix.lower() == ".md"]
    return [chunk for path in docs for chunk in load_markdown(path)]

