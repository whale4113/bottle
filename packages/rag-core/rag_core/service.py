"""Application service for querying the local knowledge base."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict
from pathlib import Path

from .answering import build_answer
from .documents import default_docs, load_chunks
from .models import Chunk, SearchHit
from .retrieval import HybridIndex


class RagService:
    def __init__(self, docs_root: Path) -> None:
        self.docs_root = docs_root
        self._signature: tuple[tuple[str, float], ...] = ()
        self._chunks: list[Chunk] = []
        self._index: HybridIndex | None = None

    def documents(self) -> list[dict[str, object]]:
        self._ensure_index()
        chunk_counts = Counter(chunk.source for chunk in self._chunks)
        return [
            {
                "path": self._relative_source(str(path)),
                "title": path.stem,
                "chunk_count": chunk_counts.get(str(path), 0),
            }
            for path in default_docs(self.docs_root)
        ]

    def ask(self, query: str, top_k: int = 5) -> dict[str, object]:
        self._ensure_index()
        if self._index is None:
            return {
                "answer": "没有可索引的 Markdown 内容。请先在 materials 目录补充知识库文档。",
                "sources": [],
                "hits": [],
                "document_count": 0,
                "chunk_count": 0,
            }

        hits = self._index.search(query, top_k=top_k)
        return {
            "answer": build_answer(query, hits),
            "sources": [self._source(hit) for hit in hits],
            "hits": [self._hit(hit) for hit in hits],
            "document_count": len(self.documents()),
            "chunk_count": len(self._chunks),
        }

    def _ensure_index(self) -> None:
        docs = default_docs(self.docs_root)
        signature = tuple((str(path), path.stat().st_mtime) for path in docs)
        if signature == self._signature:
            return

        self._signature = signature
        self._chunks = load_chunks(docs)
        self._index = HybridIndex(self._chunks) if self._chunks else None

    def _source(self, hit: SearchHit) -> dict[str, object]:
        return {
            "chunk_id": hit.chunk.chunk_id,
            "source": self._relative_source(hit.chunk.source),
            "section": hit.chunk.section,
            "score": round(hit.score, 4),
        }

    def _hit(self, hit: SearchHit) -> dict[str, object]:
        payload = asdict(hit)
        payload["chunk"]["source"] = self._relative_source(hit.chunk.source)
        return payload

    def _relative_source(self, source: str) -> str:
        path = Path(source)
        try:
            return str(path.relative_to(self.docs_root.parent))
        except ValueError:
            return str(path)
