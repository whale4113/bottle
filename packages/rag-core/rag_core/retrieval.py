"""Hybrid BM25 and TF-IDF retrieval."""

from __future__ import annotations

import math
import os
import re
from collections import Counter
from typing import Iterable

from .models import Chunk, SearchHit
from .tokenization import query_tokens, tokenize


def filter_search_hits(hits: list[SearchHit]) -> list[SearchHit]:
    """Apply the same final-score cutoff before returning evidence or answers."""
    threshold = float(os.environ.get("SEARCH_MIN_SCORE", "0.5"))
    if not math.isfinite(threshold) or threshold < 0:
        raise ValueError("SEARCH_MIN_SCORE must be a finite non-negative number")
    return [hit for hit in hits if math.isfinite(hit.score) and hit.score >= threshold]


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
    """Fuse calibrated relevance scores, with semantic retrieval as the primary signal."""
    if not query.strip() or top_k <= 0:
        return []
    identifiers = re.findall(r"[\w.+#-]+/[\w.+#-]+|[A-Za-z_]+[._-][A-Za-z0-9_.-]+|[A-Z]+[0-9]+", query)
    # Candidate limits bound work, but rank is not a relevance score.
    lexical_weight = .2
    limit = max(30, top_k * 6)
    candidates = set()
    for scores in (lexical, semantic):
        ordered = sorted(((key, value) for key, value in scores.items()
                          if math.isfinite(value) and value > 0),
                         key=lambda item: (-item[1], item[0]))[:limit]
        candidates.update(key for key, _ in ordered)
    lexical_max = max((value for value in lexical.values()
                       if math.isfinite(value) and value > 0), default=1.0)
    terms = set(query_tokens(query))
    hits = []
    for chunk in chunks:
        key = chunk.chunk_id
        bm25, similarity = lexical.get(key, 0), semantic.get(key, 0)
        if key not in candidates:
            continue
        # Relative rankings alone cannot prove relevance for an unrelated query.
        if bm25 <= 0 and similarity < .3:
            continue
        # A fixed monotonic mapping preserves absolute semantic evidence and
        # avoids making the best of several unrelated results look perfect.
        similarity = min(1.0, max(0.0, similarity)) if math.isfinite(similarity) else 0.0
        vector_score = 2 * similarity / (1 + similarity)
        keyword_score = max(0.0, bm25) / lexical_max if math.isfinite(bm25) else 0.0
        score = (1 - lexical_weight) * vector_score + lexical_weight * keyword_score
        coverage = len(terms & set(tokenize(chunk.text + " " + chunk.section))) / max(1, len(terms))
        exact = query.strip().casefold() == chunk.section.casefold()
        score += (.25 if identifiers else .1) * coverage + .2 * exact
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
