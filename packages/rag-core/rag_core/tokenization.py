"""Tokenization helpers used by retrieval and answer extraction."""

from __future__ import annotations

import re


TOKEN_RE = re.compile(r"[a-zA-Z0-9_+#.-]+|[\u4e00-\u9fff]+")
STOPWORDS = {
    "什么",
    "为什",
    "为什么",
    "怎么",
    "如何",
    "是否",
    "时候",
    "需要",
    "问题",
    "一个",
    "哪些",
    "什么时",
    "么时候",
}


def tokenize(text: str) -> list[str]:
    tokens: list[str] = []
    for raw_token in TOKEN_RE.findall(text):
        token = raw_token.lower()
        if re.fullmatch(r"[\u4e00-\u9fff]+", token):
            if len(token) == 1:
                tokens.append(token)
                continue
            tokens.extend(token[index : index + 2] for index in range(len(token) - 1))
            if len(token) >= 3:
                tokens.extend(token[index : index + 3] for index in range(len(token) - 2))
            if len(token) <= 6:
                tokens.append(token)
            continue
        tokens.append(token)
    return tokens


def query_tokens(text: str) -> list[str]:
    tokens = [token for token in tokenize(text) if token not in STOPWORDS]
    return tokens or tokenize(text)

