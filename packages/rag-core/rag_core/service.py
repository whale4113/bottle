"""Application service for querying the local knowledge base."""

from __future__ import annotations

from collections import Counter, OrderedDict
from dataclasses import asdict
from pathlib import Path
import threading

from .answering import build_answer
from .embedding_settings import EmbeddingConfig, use_config
from . import github_stars as embeddings
from .documents import default_docs, load_chunks
from .models import Chunk, SearchHit
from .retrieval import HybridIndex


class RagService:
    def __init__(self, docs_root: Path) -> None:
        self.docs_root = docs_root
        self._signature: tuple[tuple[str, float], ...] = ()
        self._chunks: list[Chunk] = []
        self._index: HybridIndex | None = None
        self._embedding_cache: OrderedDict[tuple, list] = OrderedDict()
        self._embedding_lock = threading.Lock()
        self._index_lock = threading.Lock()

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

    def ask(self, query: str, top_k: int = 5, embedding_config: EmbeddingConfig | None = None, user_id: str = "") -> dict[str, object]:
        self._ensure_index()
        if self._index is None:
            return {
                "answer": "没有可索引的 Markdown 内容。请先在 materials 目录补充知识库文档。",
                "sources": [],
                "hits": [],
                "document_count": 0,
                "chunk_count": 0,
            }

        hits = self._semantic_search(query, top_k, embedding_config, user_id) if embedding_config else self._index.search(query, top_k=top_k)
        return {
            "answer": build_answer(query, hits),
            "sources": [self._source(hit) for hit in hits],
            "hits": [self._hit(hit) for hit in hits],
            "document_count": len(self.documents()),
            "chunk_count": len(self._chunks),
        }

    def _semantic_search(self, query: str, top_k: int, config: EmbeddingConfig, user_id: str) -> list[SearchHit]:
        config.validate()
        # Snapshot the index: another request may refresh the source files.
        index = self._index
        key = (user_id, config.identity, tuple(index.chunks))
        with use_config(config):
            with self._embedding_lock:
                vectors = self._embedding_cache.get(key)
                if vectors is None:
                    vectors = [embeddings._embed_document(chunk.text) for chunk in index.chunks]
                    self._embedding_cache[key] = vectors
                    while len(self._embedding_cache) > 8:
                        self._embedding_cache.popitem(last=False)
                self._embedding_cache.move_to_end(key)
            query_vector = embeddings._embed_query(query)
            query_norm = embeddings._norm(query_vector)
            lexical = index.search(query, top_k=len(index.chunks), bm25_weight=1, vector_weight=0)
            bm25 = {hit.chunk.chunk_id: hit.bm25_score for hit in lexical}
            semantic = {chunk.chunk_id: embeddings._cosine(query_vector, query_norm, vector, embeddings._norm(vector))
                        for chunk, vector in zip(index.chunks, vectors)}
            normalized_bm25 = embeddings._normalize_scores(bm25)
            normalized_semantic = embeddings._normalize_scores(semantic)
            hits = []
            for chunk in index.chunks:
                score = .55 * normalized_bm25.get(chunk.chunk_id, 0) + .45 * normalized_semantic.get(chunk.chunk_id, 0)
                if score > 0:
                    hits.append(SearchHit(chunk, score, bm25.get(chunk.chunk_id, 0), semantic.get(chunk.chunk_id, 0)))
            return sorted(hits, key=lambda hit: hit.score, reverse=True)[:top_k]

    def _ensure_index(self) -> None:
        with self._index_lock:
            self._refresh_index()

    def _refresh_index(self) -> None:
        docs = default_docs(self.docs_root)
        signature = tuple((str(path), path.stat().st_mtime) for path in docs)
        if signature == self._signature:
            return

        chunks = load_chunks(docs)
        index = HybridIndex(chunks) if chunks else None
        self._chunks = chunks
        self._index = index
        self._signature = signature

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
