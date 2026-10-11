"""Document discovery and loading helpers."""

from __future__ import annotations

import os
from pathlib import Path

from .markdown import load_markdown
from .models import Chunk


def default_docs(root: Path | None = None) -> list[Path]:
    search_root = root or Path.cwd()
    ignored_directories = {
        ".venv", "venv", "node_modules", ".git", ".cache",
        ".pytest_cache", "__pycache__", "build", "dist",
    }
    paths: list[Path] = []
    for directory, children, files in os.walk(search_root):
        children[:] = [
            child for child in children
            if child not in ignored_directories and not child.endswith(".egg-info")
        ]
        paths.extend(
            Path(directory) / name for name in files
            if name.endswith(".md") and not name.lower().startswith("readme")
        )
    return sorted(paths)


def load_chunks(paths: list[Path]) -> list[Chunk]:
    docs = [path for path in paths if path.exists() and path.suffix.lower() == ".md"]
    return [chunk for path in docs for chunk in load_markdown(path)]

