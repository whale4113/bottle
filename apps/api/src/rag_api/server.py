#!/usr/bin/env python3
"""FastAPI server for the local RAG app."""

from __future__ import annotations

import os
import json
import urllib.error
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, StrictInt, StrictBool, model_validator
from typing import Annotated
from typing import Literal


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
    user_id: str | None = None
    query: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)


class LlmSettingsRequest(BaseModel):
    user_id: str = Field(min_length=1)
    enabled: bool = False  # Backward-compatible answer toggle.
    answer_enabled: bool | None = None
    rerank_enabled: bool | None = None
    base_url: str = Field(default="https://api.openai.com/v1", max_length=2048)
    model: str = Field(default="", max_length=512)
    api_key: str | None = Field(default=None, max_length=4096, repr=False)
    timeout: float = Field(default=60, gt=0, le=300, allow_inf_nan=False)

    embedding_summary_enabled: bool | None = None
    github_summary_prompt: str | None = Field(default=None, min_length=1, max_length=6000)
    document_summary_prompt: str | None = Field(default=None, min_length=1, max_length=6000)


class AnswerSource(BaseModel):
    source: str = Field(max_length=2048)
    title: str = Field(max_length=512)
    passages: list[Annotated[str, Field(max_length=4000)]] = Field(min_length=1, max_length=4)


class AnswerRequest(BaseModel):
    user_id: str = Field(min_length=1)
    query: str = Field(min_length=1, max_length=4000)
    sources: list[AnswerSource] = Field(max_length=10)


class HealthResponse(BaseModel):
    status: str


class DocumentsResponse(BaseModel):
    documents: list[dict[str, Any]]


class GithubStarsSyncRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    access_token: str = Field(..., min_length=1)
    max_pages: int = Field(default=50, ge=1, le=200)
    repository_ids: list[Annotated[StrictInt, Field(gt=0, le=9007199254740991)]] | None = Field(default=None, min_length=1, max_length=20000)
    select_all: StrictBool = False
    excluded_repository_ids: list[Annotated[StrictInt, Field(gt=0, le=9007199254740991)]] = Field(default_factory=list, max_length=20000)

    @model_validator(mode="after")
    def validate_selection(self):
        if self.select_all and self.repository_ids is not None or self.excluded_repository_ids and not self.select_all:
            raise ValueError("Select either explicit repositories or all repositories with exclusions.")
        return self



class GithubStarsAvailableRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    access_token: str = Field(..., min_length=1)
    page: int = Field(default=1, ge=1, le=200)
    max_pages: int = Field(default=50, ge=1, le=200)


class GithubStarsSearchRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    query: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)


class EmbeddingSettingsRequest(BaseModel):
    user_id: str = Field(min_length=1)
    provider: Literal["local", "openai"]
    model: str = Field(min_length=1, max_length=512)
    base_url: str = Field(default="https://api.openai.com/v1", max_length=2048)
    api_key: str | None = Field(default=None, max_length=4096, repr=False)
    dimensions: Annotated[StrictInt, Field(ge=1, le=65536)] | None = None
    timeout: float = Field(default=60, gt=0, le=300, allow_inf_nan=False)


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


from rag_core.llm import LlmSettingsStore, complete, generate_answer, stream_answer

llm_settings_store = LlmSettingsStore(github_stars_store.database_path)


@app.get("/api/settings/llm/{user_id}")
def get_llm_settings(user_id: str):
    return llm_settings_store.get(user_id).public()


@app.post("/api/settings/llm")
def save_llm_settings(request: LlmSettingsRequest):
    try:
        config = llm_settings_store.candidate(request.user_id, request.model_dump(exclude={"user_id"}, exclude_unset=True))
        llm_settings_store.save(request.user_id, config)
        return config.public()
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@app.post("/api/settings/llm/test")
def test_llm_settings(request: LlmSettingsRequest):
    try:
        values = request.model_dump(exclude={"user_id"}, exclude_unset=True)
        values["answer_enabled"] = True
        config = llm_settings_store.candidate(request.user_id, values)
        complete(config, [{"role": "user", "content": "Reply with OK."}])
        return {"status": "ok"}
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except RuntimeError as error:
        raise HTTPException(502, str(error)) from error


@app.post("/api/answer")
def answer(request: AnswerRequest):
    try:
        return generate_answer(llm_settings_store.get(request.user_id), request.query,
                               [source.model_dump() for source in request.sources])
    except (ValueError, RuntimeError) as error:
        raise HTTPException(502, str(error)) from error


@app.post("/api/answer/stream")
def answer_stream(request: AnswerRequest):
    config = llm_settings_store.get(request.user_id)
    try:
        config.validate()
    except ValueError as error:
        raise HTTPException(400, str(error)) from error

    def events():
        for event in stream_answer(config, request.query, [source.model_dump() for source in request.sources]):
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, error: RequestValidationError):
    if request.url.path.startswith("/api/settings/"):
        # Validation failures must not echo API keys from request inputs.
        return JSONResponse(status_code=422, content={"detail": [
            {"loc": list(item["loc"]), "msg": item["msg"], "type": item["type"]}
            for item in error.errors()
        ]})
    return await request_validation_exception_handler(request, error)


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
    config = github_stars_store.embedding_settings.get(request.user_id) if request.user_id else None
    try:
        return rag_service.ask(query, top_k=request.top_k, embedding_config=config, user_id=request.user_id or "",
                               llm_config=llm_settings_store.get(request.user_id) if request.user_id else None)
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/settings/embedding/{user_id}")
def embedding_settings(user_id: str) -> dict[str, object]:
    return github_stars_store.embedding_configuration(user_id)


@app.post("/api/settings/embedding")
def save_embedding_settings(request: EmbeddingSettingsRequest) -> dict[str, object]:
    try:
        return github_stars_store.save_embedding_configuration(request.user_id, request.model_dump(exclude={"user_id"}, exclude_unset=True))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/settings/embedding/test")
def test_embedding_settings(request: EmbeddingSettingsRequest) -> dict[str, object]:
    from rag_core.embedding_settings import use_config
    from rag_core.github_stars import _embed_query
    try:
        config = github_stars_store.embedding_settings.candidate(request.user_id, request.model_dump(exclude={"user_id"}, exclude_unset=True))
        with use_config(config):
            vector = _embed_query("Bottle embedding connection test")
        return {"status": "ok", "dimensions": len(vector)}
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/github/stars/sync")
def github_stars_sync(request: GithubStarsSyncRequest) -> dict[str, object]:
    try:
        return github_stars_store.start_sync(
            request.user_id, request.access_token,
            max_pages=request.max_pages, repository_ids=request.repository_ids,
            **({"select_all": True, "excluded_repository_ids": request.excluded_repository_ids} if request.select_all else {}),
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


@app.get("/api/github/stars/{user_id}/repositories/{repo_id}/embeddings")
def github_embeddings(user_id: str, repo_id: int, offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=20)):
    return github_stars_store.embedding_details(user_id, repo_id, offset, limit)


@app.get("/api/documents/embeddings/{user_id}")
def document_embeddings(user_id: str, source: str, offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=20)):
    return rag_service.embedding_details(user_id, source, offset, limit)


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
