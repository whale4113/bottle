#!/usr/bin/env python3
"""FastAPI server for the local RAG app."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = REPO_ROOT / "packages" / "rag-core"
DOCS_ROOT = REPO_ROOT / "materials"
API_ENV_PATH = REPO_ROOT / "apps" / "api" / ".env"

sys.path.insert(0, str(PACKAGE_ROOT))


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env(API_ENV_PATH)

from rag_core.service import RagService  # noqa: E402
from rag_core.github_stars import GithubStarsStore  # noqa: E402


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)


class HealthResponse(BaseModel):
    status: str


class DocumentsResponse(BaseModel):
    documents: list[dict[str, Any]]


class GithubStarsSyncRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    access_token: str = Field(..., min_length=1)
    max_pages: int = Field(default=50, ge=1, le=200)


class GithubStarsSearchRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    query: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)


app = FastAPI(
    title="Local RAG API",
    version="0.1.0",
    description="Hybrid BM25 and TF-IDF search API for local Markdown knowledge bases.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

rag_service = RagService(DOCS_ROOT)
github_stars_store = GithubStarsStore(REPO_ROOT / "apps" / "api" / "data" / "github_stars.sqlite")


@app.get("/api/health", response_model=HealthResponse)
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/documents", response_model=DocumentsResponse)
def documents() -> dict[str, object]:
    return {"documents": rag_service.documents()}


@app.post("/api/search")
def search(request: SearchRequest) -> dict[str, object]:
    query = request.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query is required")
    return rag_service.ask(query, top_k=request.top_k)


@app.post("/api/github/stars/sync")
def github_stars_sync(request: GithubStarsSyncRequest) -> dict[str, object]:
    return github_stars_store.start_sync(
        request.user_id,
        request.access_token,
        max_pages=request.max_pages,
    )


@app.get("/api/github/stars/sync/{user_id}")
def github_stars_sync_status(user_id: str) -> dict[str, object]:
    return github_stars_store.sync_status(user_id)


@app.post("/api/github/stars/sync/{user_id}/cancel")
def github_stars_sync_cancel(user_id: str) -> dict[str, object]:
    return github_stars_store.cancel_sync(user_id)


@app.post("/api/github/stars/sync/{user_id}/reset")
def github_stars_sync_reset(user_id: str) -> dict[str, object]:
    return github_stars_store.reset_sync(user_id)


@app.get("/api/github/stars/{user_id}")
def github_stars_list(user_id: str, limit: int = 50, offset: int = 0) -> dict[str, object]:
    normalized_limit = max(1, min(limit, 100))
    normalized_offset = max(0, offset)
    return github_stars_store.list_repositories(user_id, limit=normalized_limit, offset=normalized_offset)


@app.post("/api/github/stars/{user_id}/repositories/{repo_id}/reset")
def github_stars_repository_reset(user_id: str, repo_id: int) -> dict[str, object]:
    return github_stars_store.reset_repository(user_id, repo_id)


@app.post("/api/github/stars/search")
def github_stars_search(request: GithubStarsSearchRequest) -> dict[str, object]:
    query = request.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query is required")
    return github_stars_store.search(request.user_id, query, top_k=request.top_k)


def main() -> None:
    uvicorn.run("apps.api.server:app", host="127.0.0.1", port=8787, reload=False)


if __name__ == "__main__":
    main()
