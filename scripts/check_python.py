#!/usr/bin/env python3
"""Parse project Python files without writing bytecode caches."""

from __future__ import annotations

import ast
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON_ROOTS = [
    ROOT / "apps" / "api",
    ROOT / "packages" / "rag-core" / "rag_core",
]
PYTHON_FILES = [ROOT / "rag_mvp.py"]

for root in PYTHON_ROOTS:
    for directory, children, files in os.walk(root):
        children[:] = sorted(
            child for child in children
            if child not in {".venv", "build", "__pycache__"}
        )
        PYTHON_FILES.extend(
            Path(directory) / name for name in sorted(files) if name.endswith(".py")
        )

for path in PYTHON_FILES:
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

print(f"syntax ok: {len(PYTHON_FILES)} files")

