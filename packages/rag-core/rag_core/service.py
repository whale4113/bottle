"""Application service for querying the local knowledge base."""

from __future__ import annotations

from collections import Counter, OrderedDict
from dataclasses import asdict
from pathlib import Path
import threading

from .embedding_text import prepare_embedding_text, llm_summary_enabled
from .llm import LlmConfig
from .answering import build_answer
from .embedding_settings import EmbeddingConfig, use_config
from . import github_stars as embeddings
from .documents import default_docs, load_chunks
from .models import Chunk, SearchHit
from .markdown import split_text
from .retrieval import HybridIndex, filter_search_hits, fuse_candidates


class RagService:
    def __init__(self, docs_root: Path) -> None:
        self.docs_root = docs_root
        self._signature: tuple[tuple[str, int, int], ...] = ()
        self._chunks: list[Chunk] = []
        self._index: HybridIndex | None = None
        self._embedding_cache: OrderedDict[tuple, list] = OrderedDict()
        self._embedding_details: OrderedDict[str, list[dict]] = OrderedDict()
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

    def ask(self, query: str, top_k: int = 5, embedding_config: EmbeddingConfig | None = None, user_id: str = "", llm_config: LlmConfig | None = None) -> dict[str, object]:
        self._ensure_index()
        if self._index is None:
            return {
                "answer": "没有可索引的 Markdown 内容。请先在 materials 目录补充知识库文档。",
                "sources": [],
                "hits": [],
                "document_count": 0,
                "chunk_count": 0,
            }

        hits = self._semantic_search(query, top_k, embedding_config, user_id, llm_config) if embedding_config else self._index.search(query, top_k=top_k)
        hits = filter_search_hits(hits)
        return {
            "answer": build_answer(query, hits),
            "sources": [self._source(hit) for hit in hits],
            "hits": [self._hit(hit) for hit in hits],
            "document_count": len(self.documents()),
            "chunk_count": len(self._chunks),
        }

    def _semantic_search(self, query: str, top_k: int, config: EmbeddingConfig, user_id: str, llm_config: LlmConfig | None = None) -> list[SearchHit]:
        config.validate()
        # Snapshot the index: another request may refresh the source files.
        index = self._index
        inputs = {}
        if llm_config and llm_config.enabled and llm_summary_enabled(llm_config):
            summarized_chunks = []
            for source in dict.fromkeys(chunk.source for chunk in index.chunks):
                original = Path(source).read_text(encoding="utf-8")
                summary = prepare_embedding_text(original, Path(source).stem, llm_config)
                if summary != embeddings.normalize_embedding_text(original):
                    for i, part in enumerate(split_text(summary, max_chars=1200, overlap=160)):
                        chunk = Chunk(f"{Path(source).stem}:summary:{i + 1}", source, Path(source).stem, original)
                        summarized_chunks.append(chunk)
                        inputs[chunk.chunk_id] = part
                else:
                    summarized_chunks.extend(chunk for chunk in index.chunks if chunk.source == source)
            index = HybridIndex(summarized_chunks)
        with use_config(config):
            vectors = []
            with self._embedding_lock:
                keys = []
                missing = {}
                for chunk in index.chunks:
                    text = inputs.get(chunk.chunk_id, f"Document: {Path(chunk.source).stem}\nSection: {chunk.section}\n\n{chunk.text}")
                    key = (user_id, config.identity, llm_config if llm_summary_enabled(llm_config) else None, text)
                    keys.append(key)
                    if key not in self._embedding_cache:
                        missing[key] = embeddings.normalize_embedding_text(text)
                if missing:
                    generated = embeddings._embed_documents(list(missing.values()))
                    self._embedding_cache.update(zip(missing, generated, strict=True))
                for key in keys:
                    vectors.append(self._embedding_cache[key])
                    self._embedding_cache.move_to_end(key)
                while len(self._embedding_cache) > 4096:
                    self._embedding_cache.popitem(last=False)
                self._embedding_details[user_id] = [
                    {"chunk_id": chunk.chunk_id, "source": self._relative_source(chunk.source),
                     "source_text": chunk.text, "embedding_input": embeddings.normalize_embedding_text(key[-1]), "vector": vector,
                     "dimensions": len(vector), "provider": config.provider, "model": config.model}
                    for chunk, key, vector in zip(index.chunks, keys, vectors)
                ]
                self._embedding_details.move_to_end(user_id)
                while len(self._embedding_details) > 32:
                    self._embedding_details.popitem(last=False)
            query_vector = embeddings._embed_query(query)
            query_norm = embeddings._norm(query_vector)
            lexical = index.search(query, top_k=len(index.chunks), bm25_weight=1, vector_weight=0)
            bm25 = {hit.chunk.chunk_id: hit.bm25_score for hit in lexical}
            semantic = {chunk.chunk_id: embeddings._cosine(query_vector, query_norm, vector, embeddings._norm(vector))
                        for chunk, vector in zip(index.chunks, vectors)}
            return fuse_candidates(query, index.chunks, bm25, semantic, top_k)

    def embedding_details(self, user_id: str, source: str, offset: int = 0, limit: int = 20) -> dict:
        with self._embedding_lock:
            chunks = [chunk for chunk in self._embedding_details.get(user_id, []) if chunk["source"] == source]
            return {"chunks": chunks[offset:offset + limit], "total": len(chunks), "offset": offset, "limit": limit}

    def _ensure_index(self) -> None:
        with self._index_lock:
            self._refresh_index()

    def _refresh_index(self) -> None:
        docs = default_docs(self.docs_root)
        signature = tuple((str(path), path.stat().st_mtime_ns, path.stat().st_size) for path in docs)
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
