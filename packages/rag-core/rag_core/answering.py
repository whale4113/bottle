"""Answer construction and console formatting."""

from __future__ import annotations

import re
import textwrap

from .models import SearchHit
from .tokenization import query_tokens, tokenize


def clean_markdown(text: str) -> str:
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"[*_`>#|+-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def build_answer(query: str, hits: list[SearchHit], max_chars: int = 1200) -> str:
    if not hits:
        return "没有找到足够相关的上下文。可以换一种问法，或先补充更多知识库文档。"

    terms = set(query_tokens(query))
    selected: list[str] = []

    for hit in hits:
        chunk_text = clean_markdown(hit.chunk.text)
        sentences = re.split(r"(?<=[。！？.!?])\s*|\n+", chunk_text)
        matched = [
            sentence.strip()
            for sentence in sentences
            if sentence.strip() and terms.intersection(tokenize(sentence))
        ]
        summary = " ".join(matched[:3]) if matched else chunk_text[:260]
        selected.append(f"[{hit.chunk.chunk_id} | {hit.chunk.section}] {summary}")

    answer = "\n".join(selected)
    if len(answer) > max_chars:
        answer = answer[: max_chars - 3].rstrip() + "..."
    return answer


def print_hits(hits: list[SearchHit]) -> None:
    for index, hit in enumerate(hits, start=1):
        print(f"\n#{index} score={hit.score:.3f} bm25={hit.bm25_score:.3f} vector={hit.vector_score:.3f}")
        print(f"source={hit.chunk.source} section={hit.chunk.section} id={hit.chunk.chunk_id}")
        print(textwrap.shorten(hit.chunk.text.replace("\n", " "), width=260, placeholder="..."))

