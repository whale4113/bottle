"""Markdown document loading and chunking."""

from __future__ import annotations

import re
from pathlib import Path

from .models import Chunk


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


def split_text(text: str, max_chars: int = 850, overlap: int = 120) -> list[str]:
    paragraphs = [line.strip() for line in text.splitlines() if line.strip()]
    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        candidate = f"{current}\n{paragraph}".strip() if current else paragraph
        if len(candidate) <= max_chars:
            current = candidate
            continue

        if current:
            chunks.append(current)
            current = current[-overlap:] if overlap else ""

        while len(paragraph) > max_chars:
            chunks.append(paragraph[:max_chars])
            paragraph = paragraph[max_chars - overlap :]
        current = f"{current}\n{paragraph}".strip() if current else paragraph

    if current:
        chunks.append(current)

    return chunks


def load_markdown(path: Path) -> list[Chunk]:
    text = path.read_text(encoding="utf-8")
    sections: list[tuple[str, list[str]]] = []
    current_title = path.stem
    current_lines: list[str] = []

    for line in text.splitlines():
        heading = HEADING_RE.match(line)
        if heading:
            if current_lines:
                sections.append((current_title, current_lines))
                current_lines = []
            current_title = heading.group(2).strip()
            continue
        if line.strip().startswith("![]("):
            continue
        current_lines.append(line)

    if current_lines:
        sections.append((current_title, current_lines))

    chunks: list[Chunk] = []
    for section_title, lines in sections:
        section_text = "\n".join(lines).strip()
        if not section_text:
            continue
        for chunk_text in split_text(section_text):
            chunks.append(
                Chunk(
                    chunk_id=f"{path.stem}:{len(chunks) + 1}",
                    source=str(path),
                    section=section_title,
                    text=chunk_text,
                )
            )
    return chunks

