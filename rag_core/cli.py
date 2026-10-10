"""Command-line interface for the local RAG MVP."""

from __future__ import annotations

import argparse
from pathlib import Path

from .answering import build_answer, print_hits
from .markdown import load_markdown
from .models import Chunk
from .retrieval import HybridIndex


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local Hybrid Search RAG MVP")
    parser.add_argument("query", nargs="*", help="Question to ask the local knowledge base.")
    parser.add_argument("--docs", nargs="*", type=Path, help="Markdown files to index.")
    parser.add_argument("--top-k", type=int, default=5, help="Number of chunks to retrieve.")
    parser.add_argument("--show-hits", action="store_true", help="Print raw retrieval hits.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    docs = args.docs if args.docs is not None else default_docs()
    chunks = load_chunks(docs)
    if not chunks:
        raise SystemExit("没有可索引的 Markdown 内容。请通过 --docs 指定知识库文件。")

    query = " ".join(args.query).strip()
    if not query:
        query = input("请输入问题: ").strip()

    index = HybridIndex(chunks)
    hits = index.search(query, top_k=args.top_k)
    print("\n答案草稿：")
    print(build_answer(query, hits))

    print("\n引用来源：")
    for hit in hits:
        print(f"- {hit.chunk.chunk_id}: {hit.chunk.source} / {hit.chunk.section}")

    if args.show_hits:
        print("\n检索明细：")
        print_hits(hits)
