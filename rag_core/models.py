"""Shared data models for the local RAG pipeline."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    source: str
    section: str
    text: str


@dataclass(frozen=True)
class SearchHit:
    chunk: Chunk
    score: float
    bm25_score: float
    vector_score: float

