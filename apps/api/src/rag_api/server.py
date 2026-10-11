#!/usr/bin/env python3
"""FastAPI server for the local RAG app."""

from __future__ import annotations

import os
import asyncio
import urllib.error
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, StrictInt
from typing import Annotated


REPO_ROOT = Path(__file__).resolve().parents[4]
DOCS_ROOT = REPO_ROOT / "materials"
API_ENV_PATH = REPO_ROOT / "apps" / "api" / ".env"


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
from rag_core.github_stars import GithubNetworkError, GithubStarsStore  # noqa: E402


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
    repository_ids: list[Annotated[StrictInt, Field(gt=0, le=9007199254740991)]] | None = Field(default=None, min_length=1, max_length=20000)


class GithubStarsAvailableRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    access_token: str = Field(..., min_length=1)
    page: int = Field(default=1, ge=1, le=200)
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
    try:
        return github_stars_store.start_sync(
            request.user_id, request.access_token,
            max_pages=request.max_pages, repository_ids=request.repository_ids,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/github/stars/available")
def github_stars_available(request: GithubStarsAvailableRequest) -> dict[str, object]:
    try:
        return github_stars_store.available_repositories(
            request.user_id, request.access_token, request.page, request.max_pages,
        )
    except GithubNetworkError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except urllib.error.HTTPError as error:
        message = "无法读取 GitHub Stars，请稍后重试"
        status_code = 502
        if error.code == 401:
            message, status_code = "GitHub 授权已失效，请重新登录 GitHub", 401
        elif error.code in {403, 429}:
            message, status_code = "GitHub 请求受限，请检查授权或稍后重试", error.code
        raise HTTPException(status_code=status_code, detail=message) from error


@app.get("/api/github/stars/sync/{user_id}")
def github_stars_sync_status(user_id: str) -> dict[str, object]:
    return github_stars_store.sync_status(user_id)


@app.websocket("/api/github/stars/sync/{user_id}/ws")
async def github_stars_sync_events(websocket: WebSocket, user_id: str) -> None:
    await websocket.accept()
    loop = asyncio.get_running_loop()
    changes: asyncio.Queue[None] = asyncio.Queue(maxsize=1)

    def enqueue() -> None:
        if changes.empty():
            changes.put_nowait(None)

    unsubscribe = github_stars_store.subscribe(user_id, lambda: loop.call_soon_threadsafe(enqueue))

    async def send_updates() -> None:
        enqueue()  # Reconnections always receive a current snapshot.
        while True:
            await changes.get()
            status = await asyncio.to_thread(github_stars_store.sync_status, user_id)
            await websocket.send_json({"type": "sync.status", "data": status})

    async def receive_disconnect() -> None:
        while True:
            await websocket.receive_text()

    tasks = [asyncio.create_task(send_updates()), asyncio.create_task(receive_disconnect())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    finally:
        unsubscribe()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


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
    uvicorn.run("rag_api.server:app", host="127.0.0.1", port=8787, reload=False)


if __name__ == "__main__":
    main()
