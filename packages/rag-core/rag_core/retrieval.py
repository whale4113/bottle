"""Hybrid BM25 and TF-IDF retrieval."""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Iterable

from .models import Chunk, SearchHit
from .tokenization import query_tokens, tokenize


class HybridIndex:
    def __init__(self, chunks: list[Chunk]) -> None:
        if not chunks:
            raise ValueError("No chunks to index.")

        self.chunks = chunks
        self.tokens = [tokenize(chunk.text + " " + chunk.section) for chunk in chunks]
        self.term_freqs = [Counter(tokens) for tokens in self.tokens]
        self.doc_freqs = Counter(token for tokens in self.tokens for token in set(tokens))
        self.avg_doc_len = sum(len(tokens) for tokens in self.tokens) / len(self.tokens)
        self.idf = {
            term: math.log((len(self.chunks) - freq + 0.5) / (freq + 0.5) + 1)
            for term, freq in self.doc_freqs.items()
        }

        self.doc_vectors = [self._tfidf_vector(tokens) for tokens in self.tokens]
        self.doc_norms = [self._norm(vector) for vector in self.doc_vectors]

    def search(
        self,
        query: str,
        top_k: int = 5,
        bm25_weight: float = 0.55,
        vector_weight: float = 0.45,
    ) -> list[SearchHit]:
        terms = query_tokens(query)
        if not terms:
            return []

        query_vector = self._tfidf_vector(terms)
        query_norm = self._norm(query_vector)

        bm25_scores = [self._bm25_score(terms, index) for index in range(len(self.chunks))]
        vector_scores = [
            self._cosine(query_vector, query_norm, self.doc_vectors[index], self.doc_norms[index])
            for index in range(len(self.chunks))
        ]

        normalized_bm25 = self._normalize(bm25_scores)
        normalized_vector = self._normalize(vector_scores)

        hits: list[SearchHit] = []
        for index, chunk in enumerate(self.chunks):
            score = bm25_weight * normalized_bm25[index] + vector_weight * normalized_vector[index]
            if score <= 0:
                continue
            hits.append(
                SearchHit(
                    chunk=chunk,
                    score=score,
                    bm25_score=bm25_scores[index],
                    vector_score=vector_scores[index],
                )
            )

        hits.sort(key=lambda hit: hit.score, reverse=True)
        return hits[:top_k]

    def _bm25_score(self, terms: list[str], doc_index: int) -> float:
        k1 = 1.5
        b = 0.75
        doc_tokens = self.tokens[doc_index]
        term_freq = self.term_freqs[doc_index]
        doc_len = len(doc_tokens) or 1
        score = 0.0

        for token in terms:
            if token not in term_freq:
                continue
            idf = self.idf.get(token, 0.0)
            frequency = term_freq[token]
            denominator = frequency + k1 * (1 - b + b * doc_len / self.avg_doc_len)
            score += idf * (frequency * (k1 + 1)) / denominator
        return score

    def _tfidf_vector(self, tokens: Iterable[str]) -> dict[str, float]:
        counts = Counter(tokens)
        if not counts:
            return {}
        total = sum(counts.values())
        return {
            term: (count / total) * self.idf.get(term, 0.0)
            for term, count in counts.items()
        }

    @staticmethod
    def _norm(vector: dict[str, float]) -> float:
        return math.sqrt(sum(value * value for value in vector.values()))

    @staticmethod
    def _cosine(
        left: dict[str, float],
        left_norm: float,
        right: dict[str, float],
        right_norm: float,
    ) -> float:
        if left_norm == 0 or right_norm == 0:
            return 0.0
        shared_terms = set(left) & set(right)
        dot = sum(left[term] * right[term] for term in shared_terms)
        return dot / (left_norm * right_norm)

    @staticmethod
    def _normalize(scores: list[float]) -> list[float]:
        highest = max(scores) if scores else 0
        if highest <= 0:
            return [0.0 for _ in scores]
        return [score / highest for score in scores]



def fuse_candidates(query: str, chunks: list[Chunk], lexical: dict[str, float],
                    semantic: dict[str, float], top_k: int, diversify: bool = False) -> list[SearchHit]:
    """Bounded rank fusion; raw similarities determine evidence, never normalized scores."""
    if not query.strip() or top_k <= 0:
        return []
    identifiers = re.findall(r"[\w.+#-]+/[\w.+#-]+|[A-Za-z_]+[._-][A-Za-z0-9_.-]+|[A-Z]+[0-9]+", query)
    lexical_weight = .8 if identifiers or len(query.split()) == 1 else .45
    limit = max(30, top_k * 6)
    ranks = []
    for scores in (lexical, semantic):
        ordered = sorted(((key, value) for key, value in scores.items() if value > 0),
                         key=lambda item: (-item[1], item[0]))[:limit]
        ranks.append({key: rank for rank, (key, _) in enumerate(ordered, 1)})
    terms = set(query_tokens(query))
    hits = []
    for chunk in chunks:
        key = chunk.chunk_id
        bm25, similarity = lexical.get(key, 0), semantic.get(key, 0)
        if key not in ranks[0] and key not in ranks[1]:
            continue
        # Relative rankings alone cannot prove relevance for an unrelated query.
        if bm25 <= 0 and similarity < .3:
            continue
        score = sum(weight * 61 / (60 + rank[key]) for weight, rank in
                    zip((lexical_weight, 1 - lexical_weight), ranks) if key in rank)
        coverage = len(terms & set(tokenize(chunk.text + " " + chunk.section))) / max(1, len(terms))
        exact = query.strip().casefold() == chunk.section.casefold()
        score += .1 * coverage + .2 * exact
        hits.append(SearchHit(chunk, score, bm25, similarity))
    hits.sort(key=lambda hit: (-hit.score, hit.chunk.chunk_id))
    if diversify:
        seen = set()
        unique = []
        for hit in hits:
            if hit.chunk.section not in seen:
                unique.append(hit)
                seen.add(hit.chunk.section)
        hits = unique
    return hits[:top_k]
