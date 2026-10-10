#!/usr/bin/env python3
"""Compatibility entry point for the local Hybrid Search RAG MVP."""

from pathlib import Path
import sys

PACKAGE_ROOT = Path(__file__).resolve().parent / "packages" / "rag-core"
sys.path.insert(0, str(PACKAGE_ROOT))

from rag_core.cli import main


if __name__ == "__main__":
    main()
