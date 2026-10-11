"""Persistent RAG pipeline for GitHub starred repositories."""

from __future__ import annotations

import json
import http.client
import math
import os
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from .markdown import split_text
from .models import Chunk, SearchHit
from .retrieval import HybridIndex
from .tokenization import query_tokens, tokenize


USER_AGENT = "local-rag-github-stars-sync"
VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings"
LOCAL_EMBEDDING_PROVIDER = "local"
LOCAL_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-0.6B"
REPO_ROOT = Path(__file__).resolve().parents[3]
LOCAL_EMBEDDING_CACHE_DIR = REPO_ROOT / "apps" / "api" / "data" / "models"
Vector = dict[str, float] | list[float]
_LOCAL_EMBEDDING_MODEL_CACHE: Any | None = None


class GithubNetworkError(RuntimeError):
    """A GitHub request could not complete over a verified HTTPS connection."""


def _dev_log(event: str, **fields: object) -> None:
    if os.environ.get("APP_ENV", os.environ.get("NODE_ENV", "")) == "development":
        print(f"[github-stars] {event} {json.dumps(fields, ensure_ascii=False, default=str)}", flush=True)


class GithubStarsStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._active_workers: dict[str, threading.Thread] = {}
        self._listeners_lock = threading.Lock()
        self._listeners: dict[str, set[Callable[[], None]]] = {}
        self._init_db()
        # Workers belong to this API process and cannot survive a restart.
        with self._connect() as connection:
            connection.execute(
                """update github_star_sync_jobs
                   set status = 'failed', message = '服务已重启，请重新同步',
                       error = '同步进程已中断', updated_at = ?, completed_at = ?
                   where status in ('queued', 'downloading_model', 'running')""",
                (_now(), _now()),
            )

    def subscribe(self, user_id: str, callback: Callable[[], None]) -> Callable[[], None]:
        with self._listeners_lock:
            self._listeners.setdefault(user_id, set()).add(callback)

        def unsubscribe() -> None:
            with self._listeners_lock:
                listeners = self._listeners.get(user_id)
                if listeners is not None:
                    listeners.discard(callback)
                    if not listeners:
                        self._listeners.pop(user_id, None)
        return unsubscribe

    def _notify(self, user_id: str) -> None:
        with self._listeners_lock:
            callbacks = tuple(self._listeners.get(user_id, ()))
        for callback in callbacks:
            try:
                callback()
            except RuntimeError:
                pass  # A disconnected subscriber may have already closed its loop.

    def selected_repository_ids(self, user_id: str) -> list[int]:
        with self._connect() as connection:
            preference = connection.execute(
                "select repository_ids_json from github_star_sync_preferences where user_id = ?",
                (user_id,),
            ).fetchone()
            if preference is not None:
                return json.loads(preference["repository_ids_json"])
            # Existing installations refresh only repositories already indexed.
            return [row["repo_id"] for row in connection.execute(
                "select repo_id from github_star_repositories where user_id = ? order by repo_id",
                (user_id,),
            )]

    def available_repositories(
        self, user_id: str, access_token: str, page: int = 1, max_pages: int = 50,
    ) -> dict[str, object]:
        if not 1 <= page <= max_pages <= 200:
            raise ValueError("仓库列表页码超出允许范围")
        payload, headers = _github_json_with_headers(
            f"https://api.github.com/user/starred?per_page=100&page={page}&sort=created&direction=desc",
            access_token,
        )
        if not isinstance(payload, list):
            raise ValueError("GitHub 返回的仓库列表无效")
        with self._connect() as connection:
            synced_ids = {row["repo_id"] for row in connection.execute(
                "select repo_id from github_star_repositories where user_id = ?", (user_id,),
            )}
        has_next = bool(_next_link_url(headers.get("Link", headers.get("link", ""))))
        return {
            "stars": [{**_star_payload(repo), "synced": repo.get("id") in synced_ids} for repo in payload],
            "page": page,
            "has_more": has_next and page < max_pages,
            "truncated": has_next and page == max_pages,
            "selected_repository_ids": self.selected_repository_ids(user_id),
        }

    def start_sync(
        self, user_id: str, access_token: str, max_pages: int = 10,
        repository_ids: list[int] | None = None,
    ) -> dict[str, object]:
        if repository_ids is not None and (
            not repository_ids or any(type(repo_id) is not int or repo_id <= 0 for repo_id in repository_ids)
        ):
            raise ValueError("请至少选择一个有效仓库")
        selected_ids = sorted(set(
            repository_ids if repository_ids is not None else self.selected_repository_ids(user_id)
        ))
        if not selected_ids:
            return {**self.sync_status(user_id), "message": "请先选择需要同步的仓库"}
        with self._lock:
            current = self.sync_status(user_id)
            if current.get("status") in {"queued", "downloading_model", "running"}:
                if repository_ids is not None:
                    raise RuntimeError("已有同步任务进行中，请等待完成或取消后重试")
                return current

            previous_worker = self._active_workers.get(user_id)
            if previous_worker and previous_worker.is_alive():
                raise RuntimeError("上次同步正在结束，请稍后重试")
            job_id = str(uuid.uuid4())
            now = _now()
            with self._connect() as connection:
                connection.execute(
                    """
                    insert into github_star_sync_jobs (
                      job_id, user_id, status, total, processed, indexed, message,
                      cancel_requested, started_at, updated_at
                    )
                    values (?, ?, 'queued', 0, 0, 0, '等待同步', 0, ?, ?)
                    """,
                    (job_id, user_id, now, now),
                )

            worker = threading.Thread(
                target=self._run_sync,
                args=(job_id, user_id, access_token, max_pages, selected_ids),
                daemon=True,
            )
            self._active_workers[user_id] = worker
            _dev_log("sync.queued", job_id=job_id, repositories=len(selected_ids))
            self._notify(user_id)
            worker.start()
            return self.sync_status(user_id)

    def cancel_sync(self, user_id: str) -> dict[str, object]:
        _dev_log("sync.cancel.requested")
        now = _now()
        with self._connect() as connection:
            connection.execute(
                """
                update github_star_sync_jobs
                set status = 'canceled',
                    cancel_requested = 1,
                    message = '同步已取消',
                    updated_at = ?,
                    completed_at = coalesce(completed_at, ?)
                where user_id = ? and status in ('queued', 'downloading_model', 'running')
                """,
                (now, now, user_id),
            )
        self._notify(user_id)
        return self.sync_status(user_id)

    def sync_status(self, user_id: str) -> dict[str, object]:
        with self._connect() as connection:
            job = connection.execute(
                """
                select job_id, user_id, status, total, processed, indexed, message,
                       cancel_requested, error, started_at, updated_at, completed_at
                from github_star_sync_jobs
                where user_id = ?
                order by started_at desc
                limit 1
                """,
                (user_id,),
            ).fetchone()
            repository_count = connection.execute(
                "select count(*) as count from github_star_repositories where user_id = ?",
                (user_id,),
            ).fetchone()["count"]
            chunk_count = connection.execute(
                "select count(*) as count from github_star_chunks where user_id = ?",
                (user_id,),
            ).fetchone()["count"]

        if job is None:
            return {
                "status": "idle",
                "total": 0,
                "processed": 0,
                "indexed": 0,
                "progress": 0,
                "message": "尚未同步 GitHub Stars",
                "repository_count": repository_count,
                "chunk_count": chunk_count,
                "embedding_provider": _embedding_provider(),
                "embedding_model": _embedding_model(),
            }

        payload = dict(job)
        if payload["status"] in {"queued", "downloading_model", "running"} and payload["cancel_requested"]:
            now = _now()
            with self._connect() as connection:
                connection.execute(
                    """
                    update github_star_sync_jobs
                    set status = 'canceled',
                        message = '同步已取消',
                        updated_at = ?,
                        completed_at = coalesce(completed_at, ?)
                    where job_id = ?
                    """,
                    (now, now, payload["job_id"]),
                )
            payload["status"] = "canceled"
            payload["message"] = "同步已取消"
            payload["updated_at"] = now
            payload["completed_at"] = payload["completed_at"] or now
        payload["repository_count"] = repository_count
        payload["chunk_count"] = chunk_count
        payload["progress"] = _progress(payload["processed"], payload["total"])
        payload["embedding_provider"] = _embedding_provider()
        payload["embedding_model"] = _embedding_model()
        return payload

    def list_repositories(self, user_id: str, limit: int = 50, offset: int = 0) -> dict[str, object]:
        with self._connect() as connection:
            total = connection.execute(
                "select count(*) as count from github_star_repositories where user_id = ?",
                (user_id,),
            ).fetchone()["count"]
            rows = connection.execute(
                """
                select repositories.repo_id, repositories.raw_json, repositories.readme_text,
                       repositories.synced_at, count(chunks.chunk_id) as chunk_count
                from github_star_repositories repositories
                left join github_star_chunks chunks
                  on chunks.user_id = repositories.user_id
                 and chunks.repo_id = repositories.repo_id
                where repositories.user_id = ?
                group by repositories.user_id, repositories.repo_id
                order by repositories.synced_at desc, repositories.full_name asc
                limit ? offset ?
                """,
                (user_id, limit, offset),
            ).fetchall()

        return {
            "stars": [_synced_star_payload(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "embedding_provider": _embedding_provider(),
            "embedding_model": _embedding_model(),
        }

    def reset_sync(self, user_id: str) -> dict[str, object]:
        _dev_log("sync.reset.requested")
        now = _now()
        with self._lock:
            with self._connect() as connection:
                connection.execute(
                    """
                    update github_star_sync_jobs
                    set status = 'canceled',
                        cancel_requested = 1,
                        message = '同步已重置',
                        updated_at = ?,
                        completed_at = coalesce(completed_at, ?)
                    where user_id = ? and status in ('queued', 'downloading_model', 'running')
                    """,
                    (now, now, user_id),
                )
                connection.execute("delete from github_star_chunks where user_id = ?", (user_id,))
                connection.execute("delete from github_star_repositories where user_id = ?", (user_id,))
        self._notify(user_id)
        return self.sync_status(user_id)

    def reset_repository(self, user_id: str, repo_id: int) -> dict[str, object]:
        with self._connect() as connection:
            repository = connection.execute(
                """
                select raw_json
                from github_star_repositories
                where user_id = ? and repo_id = ?
                """,
                (user_id, repo_id),
            ).fetchone()
            chunk_count = connection.execute(
                """
                select count(*) as count
                from github_star_chunks
                where user_id = ? and repo_id = ?
                """,
                (user_id, repo_id),
            ).fetchone()["count"]
            connection.execute(
                "delete from github_star_chunks where user_id = ? and repo_id = ?",
                (user_id, repo_id),
            )
            connection.execute(
                "delete from github_star_repositories where user_id = ? and repo_id = ?",
                (user_id, repo_id),
            )
        self._notify(user_id)
        return {
            "deleted": repository is not None,
            "repo_id": repo_id,
            "repository": _star_payload(json.loads(repository["raw_json"])) if repository is not None else None,
            "deleted_chunk_count": int(chunk_count),
            "sync": self.sync_status(user_id),
        }

    def search(self, user_id: str, query: str, top_k: int = 5) -> dict[str, object]:
        retrieval_query, metadata_filters = _extract_metadata_filters(query)
        rows = self._load_chunks(user_id, metadata_filters)
        if not rows:
            return {
                "answer": "当前还没有可检索的 GitHub Stars 索引。请先同步 GitHub Stars。",
                "sources": [],
                "hits": [],
                "stars": [],
                "repository_count": self._repository_count(user_id),
                "filtered_repository_count": 0,
                "chunk_count": 0,
                "embedding_provider": _embedding_provider(),
                "embedding_model": _embedding_model(),
                "pipeline": _pipeline_summary(),
            }

        chunks = [
            Chunk(
                chunk_id=row["chunk_id"],
                source=row["html_url"] or row["full_name"],
                section=row["full_name"],
                text=row["text"],
            )
            for row in rows
        ]
        index = HybridIndex(chunks)
        bm25_hits = index.search(
            retrieval_query,
            top_k=min(max(top_k * 6, 30), len(chunks)),
            bm25_weight=1.0,
            vector_weight=0.0,
        )
        bm25_by_id = {hit.chunk.chunk_id: hit.bm25_score for hit in bm25_hits}
        vector_by_id = self._vector_scores(retrieval_query, rows)
        normalized_bm25 = _normalize_scores(bm25_by_id)
        normalized_vector = _normalize_scores(vector_by_id)

        hits: list[SearchHit] = []
        for chunk in chunks:
            bm25_score = bm25_by_id.get(chunk.chunk_id, 0.0)
            vector_score = vector_by_id.get(chunk.chunk_id, 0.0)
            score = 0.55 * normalized_bm25.get(chunk.chunk_id, 0.0) + 0.45 * normalized_vector.get(chunk.chunk_id, 0.0)
            if score <= 0:
                continue
            hits.append(SearchHit(chunk=chunk, score=score, bm25_score=bm25_score, vector_score=vector_score))

        hits = _rerank(retrieval_query, hits)[:top_k]
        if not _has_sufficient_context(hits):
            return {
                "answer": f"没有在已同步的 GitHub Stars 索引中找到足够支持「{query.strip()}」的上下文。",
                "sources": [],
                "hits": [],
                "stars": [],
                "repository_count": self._repository_count(user_id),
                "filtered_repository_count": self._repository_count(user_id, metadata_filters),
                "chunk_count": len(rows),
                "embedding_provider": _embedding_provider(),
                "embedding_model": _embedding_model(),
                "pipeline": _pipeline_summary(),
            }

        return {
            "answer": _build_answer(retrieval_query, hits),
            "sources": [_source(hit) for hit in hits],
            "hits": [_hit(hit) for hit in hits],
            "stars": [self._star_from_chunk(user_id, hit.chunk.chunk_id) for hit in hits],
            "repository_count": self._repository_count(user_id),
            "filtered_repository_count": self._repository_count(user_id, metadata_filters),
            "chunk_count": len(rows),
            "embedding_provider": _embedding_provider(),
            "embedding_model": _embedding_model(),
            "pipeline": _pipeline_summary(),
        }

    def _run_sync(
        self, job_id: str, user_id: str, access_token: str, max_pages: int,
        repository_ids: list[int],
    ) -> None:
        try:
            self._update_job(job_id, status="running", processed=0, total=0, message="正在确认所选 GitHub Stars")
            repositories = self._fetch_starred_repositories(access_token, max_pages, job_id, set(repository_ids))
            if self._is_cancel_requested(job_id):
                return
            found_ids = {int(repo["id"]) for repo in repositories}
            if set(repository_ids) - found_ids:
                raise ValueError("部分所选仓库已取消收藏或超出列表页数上限，请重新选择仓库")
            with self._connect() as connection:
                connection.execute(
                    """insert into github_star_sync_preferences (user_id, repository_ids_json)
                       values (?, ?) on conflict(user_id) do update
                       set repository_ids_json = excluded.repository_ids_json""",
                    (user_id, json.dumps(repository_ids)),
                )
            self._update_job(job_id, processed=0, total=len(repositories))
            if _embedding_provider() == LOCAL_EMBEDDING_PROVIDER:
                self._update_job(
                    job_id,
                    status="downloading_model",
                    message=f"正在下载或加载本地 embedding 模型 {_embedding_model()}",
                )
                started = time.monotonic()
                _dev_log("model.load.start", model=_embedding_model())
                _load_local_embedding_model()
                _dev_log("model.load.done", seconds=round(time.monotonic() - started, 2))
                if self._is_cancel_requested(job_id):
                    self._update_job(
                        job_id,
                        status="canceled",
                        message="同步已取消",
                        completed_at=_now(),
                    )
                    return

            self._update_job(job_id, status="running", processed=0, total=len(repositories), message="正在写入所选仓库的本地索引")

            indexed = 0
            for index, repository in enumerate(repositories, start=1):
                if self._is_cancel_requested(job_id):
                    self._update_job(
                        job_id,
                        status="canceled",
                        processed=index - 1,
                        indexed=indexed,
                        message="同步已取消",
                        completed_at=_now(),
                    )
                    return

                self._update_job(job_id, message=f"正在读取 {repository.get('full_name')} 的 README")
                started = time.monotonic()
                readme = self._fetch_readme(access_token, repository)
                _dev_log("readme.done", job_id=job_id, repository=repository.get("full_name"), chars=len(readme), seconds=round(time.monotonic() - started, 2))
                if self._is_cancel_requested(job_id):
                    self._update_job(
                        job_id,
                        status="canceled",
                        processed=index - 1,
                        indexed=indexed,
                        message="同步已取消",
                        completed_at=_now(),
                    )
                    return
                self._store_repository(user_id, repository, readme)
                indexed += self._store_chunks(user_id, repository, readme, job_id=job_id)
                if self._is_cancel_requested(job_id):
                    self._update_job(
                        job_id, status="canceled", processed=index - 1,
                        indexed=indexed, message="同步已取消", completed_at=_now(),
                    )
                    return
                self._update_job(
                    job_id,
                    processed=index,
                    indexed=indexed,
                    message=f"已同步 {index}/{len(repositories)} 个仓库",
                )

            self._update_job(
                job_id,
                status="completed",
                processed=len(repositories),
                indexed=indexed,
                message="同步完成",
                completed_at=_now(),
            )
        except Exception as error:  # noqa: BLE001 - persist the job error for UI inspection.
            canceled = self._is_cancel_requested(job_id)
            self._update_job(
                job_id,
                status="canceled" if canceled else "failed",
                message="同步已取消" if canceled else "同步失败",
                error=None if canceled else str(error),
                completed_at=_now(),
            )

    def _fetch_starred_repositories(
        self,
        access_token: str,
        max_pages: int,
        job_id: str,
        selected_ids: set[int],
    ) -> list[dict[str, Any]]:
        repositories: list[dict[str, Any]] = []
        page = 1
        next_url = "https://api.github.com/user/starred?per_page=100&page=1"
        while next_url and page <= max_pages:
            if self._is_cancel_requested(job_id):
                break
            payload, headers = _github_json_with_headers(
                next_url,
                access_token,
            )
            if not isinstance(payload, list):
                raise ValueError("GitHub 返回的仓库列表无效")
            known_ids = {int(repo["id"]) for repo in repositories}
            for repo in payload:
                repo_id = int(repo.get("id") or 0)
                if repo_id in selected_ids and repo_id not in known_ids:
                    repositories.append(repo)
                    known_ids.add(repo_id)
            self._update_job(job_id, processed=0, total=len(selected_ids), message=f"已找到 {len(repositories)}/{len(selected_ids)} 个所选仓库")
            if known_ids == selected_ids:
                break
            next_url = _next_link_url(headers.get("Link", headers.get("link", "")))
            page += 1
        if next_url and page > max_pages:
            self._update_job(
                job_id,
                message=f"已拉取 {len(repositories)} 个 Stars，达到页数上限 {max_pages}",
            )
        return repositories

    def _fetch_readme(self, access_token: str, repository: dict[str, Any]) -> str:
        full_name = str(repository.get("full_name") or "")
        if not full_name:
            return ""
        url = f"https://api.github.com/repos/{urllib.parse.quote(full_name, safe='/')}/readme"
        try:
            return _github_text(url, access_token, accept="application/vnd.github.raw")
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return ""
            raise

    def _store_repository(self, user_id: str, repository: dict[str, Any], readme: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                insert into github_star_repositories (
                  user_id, repo_id, full_name, html_url, language, owner_login,
                  topics_json, raw_json, readme_text, synced_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(user_id, repo_id) do update set
                  full_name = excluded.full_name,
                  html_url = excluded.html_url,
                  language = excluded.language,
                  owner_login = excluded.owner_login,
                  topics_json = excluded.topics_json,
                  raw_json = excluded.raw_json,
                  readme_text = excluded.readme_text,
                  synced_at = excluded.synced_at
                """,
                (
                    user_id,
                    int(repository.get("id") or 0),
                    str(repository.get("full_name") or repository.get("name") or ""),
                    str(repository.get("html_url") or ""),
                    str(repository.get("language") or ""),
                    str((repository.get("owner") or {}).get("login") or ""),
                    json.dumps(repository.get("topics") or [], ensure_ascii=False),
                    json.dumps(repository, ensure_ascii=False),
                    readme,
                    _now(),
                ),
            )

    def _store_chunks(self, user_id: str, repository: dict[str, Any], readme: str, job_id: str | None = None) -> int:
        repo_id = int(repository.get("id") or 0)
        full_name = str(repository.get("full_name") or repository.get("name") or "")
        chunks = _repository_chunks(repository, readme)
        embedding_provider = _embedding_provider()
        embedding_model = _embedding_model()
        rows: list[tuple[object, ...]] = []
        # Embedding can take minutes. Keep it outside the SQLite write transaction
        # so progress/cancel requests can write, and cancellation preserves old chunks.
        for chunk_index, (source_type, text) in enumerate(chunks, start=1):
            if job_id and self._is_cancel_requested(job_id):
                return 0
            if job_id:
                self._update_job(job_id, message=f"{full_name}：正在生成向量 {chunk_index}/{len(chunks)}")
            started = time.monotonic()
            _dev_log("embedding.start", job_id=job_id, repository=full_name, chunk=chunk_index, total=len(chunks), chars=len(text))
            embedding = _embed_document(text)
            _dev_log("embedding.done", job_id=job_id, chunk=chunk_index, seconds=round(time.monotonic() - started, 2))
            if job_id and self._is_cancel_requested(job_id):
                return 0
            rows.append((
                user_id, f"github-star:{repo_id}:{source_type}:{chunk_index}", repo_id,
                full_name, source_type, text, json.dumps(embedding, separators=(",", ":")),
                embedding_provider, embedding_model, _now(),
            ))
        if job_id:
            self._update_job(job_id, message=f"{full_name}：正在写入 {len(rows)} 个分块")
        _dev_log("index.write.start", job_id=job_id, repository=full_name, chunks=len(rows))
        with self._connect() as connection:
            connection.execute(
                "delete from github_star_chunks where user_id = ? and repo_id = ?",
                (user_id, repo_id),
            )
            connection.executemany(
                """
                insert into github_star_chunks (
                  user_id, chunk_id, repo_id, full_name, source_type, text,
                  embedding_json, embedding_provider, embedding_model, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        _dev_log("index.write.done", job_id=job_id, repository=full_name, chunks=len(rows))
        return len(rows)

    def _load_chunks(self, user_id: str, metadata_filters: dict[str, str]) -> list[sqlite3.Row]:
        where = ["chunks.user_id = ?", "chunks.embedding_provider = ?", "chunks.embedding_model = ?"]
        params: list[object] = [user_id, _embedding_provider(), _embedding_model()]
        if language := metadata_filters.get("language"):
            where.append("lower(repositories.language) like ?")
            params.append(f"%{language}%")
        if owner := metadata_filters.get("owner"):
            where.append("lower(repositories.owner_login) like ?")
            params.append(f"%{owner}%")
        if topic := metadata_filters.get("topic"):
            where.append("lower(repositories.topics_json) like ?")
            params.append(f"%{topic}%")

        with self._connect() as connection:
            return connection.execute(
                f"""
                select chunks.chunk_id, chunks.full_name, chunks.text, chunks.embedding_json,
                       repositories.html_url, repositories.raw_json
                from github_star_chunks chunks
                join github_star_repositories repositories
                  on repositories.user_id = chunks.user_id
                 and repositories.repo_id = chunks.repo_id
                where {" and ".join(where)}
                """,
                params,
            ).fetchall()

    def _vector_scores(self, query: str, rows: list[sqlite3.Row]) -> dict[str, float]:
        query_embedding = _embed_query(query)
        query_norm = _norm(query_embedding)
        scores: dict[str, float] = {}
        for row in rows:
            embedding = json.loads(row["embedding_json"] or "{}")
            scores[row["chunk_id"]] = _cosine(query_embedding, query_norm, embedding, _norm(embedding))
        return scores

    def _star_from_chunk(self, user_id: str, chunk_id: str) -> dict[str, object]:
        with self._connect() as connection:
            row = connection.execute(
                """
                select repositories.raw_json
                from github_star_chunks chunks
                join github_star_repositories repositories
                  on repositories.user_id = chunks.user_id
                 and repositories.repo_id = chunks.repo_id
                where chunks.user_id = ? and chunks.chunk_id = ?
                """,
                (user_id, chunk_id),
            ).fetchone()
        if row is None:
            return {}
        return _star_payload(json.loads(row["raw_json"]))

    def _repository_count(self, user_id: str, metadata_filters: dict[str, str] | None = None) -> int:
        metadata_filters = metadata_filters or {}
        where = ["user_id = ?"]
        params: list[object] = [user_id]
        if language := metadata_filters.get("language"):
            where.append("lower(language) like ?")
            params.append(f"%{language}%")
        if owner := metadata_filters.get("owner"):
            where.append("lower(owner_login) like ?")
            params.append(f"%{owner}%")
        if topic := metadata_filters.get("topic"):
            where.append("lower(topics_json) like ?")
            params.append(f"%{topic}%")
        with self._connect() as connection:
            return int(
                connection.execute(
                    f"select count(*) as count from github_star_repositories where {' and '.join(where)}",
                    params,
                ).fetchone()["count"]
            )

    def _is_cancel_requested(self, job_id: str) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "select cancel_requested from github_star_sync_jobs where job_id = ?",
                (job_id,),
            ).fetchone()
        return bool(row and row["cancel_requested"])

    def _update_job(self, job_id: str, **updates: object) -> None:
        _dev_log("sync.progress", job_id=job_id, **updates)
        if not updates:
            return
        updates["updated_at"] = _now()
        columns = ", ".join(f"{key} = ?" for key in updates)
        values = list(updates.values())
        values.append(job_id)
        with self._connect() as connection:
            connection.execute(
                f"update github_star_sync_jobs set {columns} where job_id = ?",
                values,
            )
            job = connection.execute("select user_id from github_star_sync_jobs where job_id = ?", (job_id,)).fetchone()
        if job:
            self._notify(job["user_id"])

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_db(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                create table if not exists github_star_sync_preferences (
                  user_id text primary key,
                  repository_ids_json text not null
                );

                create table if not exists github_star_sync_jobs (
                  job_id text primary key,
                  user_id text not null,
                  status text not null,
                  total integer not null default 0,
                  processed integer not null default 0,
                  indexed integer not null default 0,
                  message text not null default '',
                  cancel_requested integer not null default 0,
                  error text,
                  started_at real not null,
                  updated_at real not null,
                  completed_at real
                );

                create index if not exists idx_github_star_sync_jobs_user
                  on github_star_sync_jobs(user_id, started_at);

                create table if not exists github_star_repositories (
                  user_id text not null,
                  repo_id integer not null,
                  full_name text not null,
                  html_url text not null,
                  language text,
                  owner_login text,
                  topics_json text not null,
                  raw_json text not null,
                  readme_text text not null,
                  synced_at real not null,
                  primary key (user_id, repo_id)
                );

                create table if not exists github_star_chunks (
                  user_id text not null,
                  chunk_id text not null,
                  repo_id integer not null,
                  full_name text not null,
                  source_type text not null,
                  text text not null,
                  embedding_json text not null,
                  embedding_provider text not null default 'local',
                  embedding_model text not null default 'Qwen/Qwen3-Embedding-0.6B',
                  created_at real not null,
                  primary key (user_id, chunk_id)
                );

                create index if not exists idx_github_star_chunks_user
                  on github_star_chunks(user_id);
                """
            )
            existing_columns = {
                row["name"]
                for row in connection.execute("pragma table_info(github_star_chunks)").fetchall()
            }
            if "embedding_provider" not in existing_columns:
                connection.execute(
                    "alter table github_star_chunks add column embedding_provider text not null default 'local'"
                )
            if "embedding_model" not in existing_columns:
                connection.execute(
                    "alter table github_star_chunks add column embedding_model text not null default 'Qwen/Qwen3-Embedding-0.6B'"
                )


def _github_json(url: str, access_token: str) -> object:
    payload = _github_text(url, access_token, accept="application/vnd.github+json")
    return json.loads(payload)


def _github_json_with_headers(url: str, access_token: str) -> tuple[object, dict[str, str]]:
    payload, headers = _github_text_with_headers(url, access_token, accept="application/vnd.github+json")
    return json.loads(payload), headers


def _github_text(url: str, access_token: str, accept: str) -> str:
    payload, _headers = _github_text_with_headers(url, access_token, accept)
    return payload


def _github_text_with_headers(url: str, access_token: str, accept: str) -> tuple[str, dict[str, str]]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": accept,
            "Authorization": f"Bearer {access_token}",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    for attempt in range(1, 5):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - URL is controlled by this service.
                headers = {key: value for key, value in response.headers.items()}
                return response.read().decode("utf-8", errors="replace"), headers
        except (urllib.error.URLError, ssl.SSLError, TimeoutError, ConnectionError, http.client.IncompleteRead, http.client.RemoteDisconnected) as error:
            reason = error.reason if isinstance(error, urllib.error.URLError) else error
            if isinstance(reason, ssl.SSLCertVerificationError):
                raise GithubNetworkError("GitHub HTTPS 证书校验失败，请检查系统证书和代理配置") from error
            if isinstance(error, urllib.error.HTTPError):
                if error.code not in {408, 502, 503, 504}:
                    raise
                error.close()
            if attempt == 4:
                raise GithubNetworkError("连接 GitHub 失败，已尝试 4 次。请检查网络或 HTTPS 代理后重新同步") from error
            delay = 2 ** (attempt - 1)
            _dev_log("github.request.retry", host=urllib.parse.urlsplit(url).hostname, attempt=attempt, delay_seconds=delay, error_type=type(reason).__name__)
            time.sleep(delay)
    raise AssertionError("unreachable")


def _next_link_url(link_header: str) -> str:
    for part in link_header.split(","):
        section = part.strip()
        if 'rel="next"' not in section:
            continue
        url_part = section.split(";", 1)[0].strip()
        if url_part.startswith("<") and url_part.endswith(">"):
            return url_part[1:-1]
    return ""


def _repository_chunks(repository: dict[str, Any], readme: str) -> list[tuple[str, str]]:
    metadata = _repository_metadata_text(repository)
    chunks = [("metadata", metadata)]
    for index, chunk in enumerate(split_text(readme, max_chars=1200, overlap=160), start=1):
        if chunk.strip():
            chunks.append((f"readme-{index}", f"{metadata}\n\nREADME excerpt:\n{chunk.strip()}"))
    return chunks


def _repository_metadata_text(repository: dict[str, Any]) -> str:
    owner = repository.get("owner") or {}
    topics = repository.get("topics") or []
    lines = [
        f"Repository: {repository.get('full_name') or repository.get('name') or ''}",
        f"Name: {repository.get('name') or ''}",
        f"Owner: {owner.get('login') or ''}",
        f"Description: {repository.get('description') or ''}",
        f"Language: {repository.get('language') or ''}",
        f"Topics: {', '.join(str(topic) for topic in topics)}",
        f"Stars: {repository.get('stargazers_count') or 0}",
        f"Forks: {repository.get('forks_count') or 0}",
        f"Updated at: {repository.get('updated_at') or ''}",
        f"URL: {repository.get('html_url') or ''}",
    ]
    return "\n".join(line for line in lines if not line.endswith(": "))


def _extract_metadata_filters(query: str) -> tuple[str, dict[str, str]]:
    filters: dict[str, str] = {}
    remaining_terms: list[str] = []
    for term in query.split():
        if ":" not in term:
            remaining_terms.append(term)
            continue
        key, value = term.split(":", 1)
        normalized_key = key.strip().lower()
        if normalized_key not in {"language", "topic", "owner"} or not value.strip():
            remaining_terms.append(term)
            continue
        filters[normalized_key] = value.strip().lower()
    retrieval_query = " ".join(remaining_terms).strip() or query.strip()
    return retrieval_query, filters


def _embed_document(text: str) -> Vector:
    return _embed(text, input_type="document")


def _embed_query(text: str) -> Vector:
    return _embed(text, input_type="query")


def _embed(text: str, input_type: str) -> Vector:
    provider = _embedding_provider()
    if provider == "voyage":
        return _voyage_embed(text, input_type=input_type)
    if provider == LOCAL_EMBEDDING_PROVIDER:
        return _local_model_embed(text)
    raise RuntimeError(f"Unsupported EMBEDDING_PROVIDER: {provider}")


def _voyage_embed(text: str, input_type: str) -> list[float]:
    api_key = os.environ.get("VOYAGE_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage")

    body = {
        "input": [text],
        "model": _embedding_model(),
        "input_type": input_type,
    }
    request = urllib.request.Request(
        VOYAGE_EMBEDDINGS_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - URL is a fixed Voyage endpoint.
        payload = json.loads(response.read().decode("utf-8"))

    data = payload.get("data") or []
    if not data or "embedding" not in data[0]:
        raise RuntimeError("Voyage embeddings response did not include an embedding")
    return [float(value) for value in data[0]["embedding"]]


def _local_model_embed(text: str) -> list[float]:
    model = _load_local_embedding_model()
    embedding = model.encode(
        [text],
        convert_to_numpy=False,
        normalize_embeddings=True,
    )[0]
    return [float(value) for value in embedding]


def _load_local_embedding_model() -> Any:
    global _LOCAL_EMBEDDING_MODEL_CACHE
    if _LOCAL_EMBEDDING_MODEL_CACHE is None:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as error:
            raise RuntimeError(
                "sentence-transformers is required for local embeddings. "
                "Run pnpm run setup:api or set EMBEDDING_PROVIDER=voyage."
            ) from error
        cache_folder = _local_embedding_cache_folder()
        cache_folder.mkdir(parents=True, exist_ok=True)
        _LOCAL_EMBEDDING_MODEL_CACHE = SentenceTransformer(
            _embedding_model(),
            cache_folder=str(cache_folder),
            trust_remote_code=True,
        )
    return _LOCAL_EMBEDDING_MODEL_CACHE


def _embedding_provider() -> str:
    configured_provider = os.environ.get("EMBEDDING_PROVIDER", "").strip().lower()
    if configured_provider:
        return configured_provider
    return LOCAL_EMBEDDING_PROVIDER


def _embedding_model() -> str:
    if _embedding_provider() == "voyage":
        return os.environ.get("VOYAGE_EMBEDDING_MODEL", "voyage-4-lite").strip() or "voyage-4-lite"
    return os.environ.get("LOCAL_EMBEDDING_MODEL", LOCAL_EMBEDDING_MODEL).strip() or LOCAL_EMBEDDING_MODEL


def _local_embedding_cache_folder() -> Path:
    configured_cache = os.environ.get("LOCAL_EMBEDDING_CACHE_DIR", "").strip()
    if configured_cache:
        cache_path = Path(configured_cache).expanduser()
        if cache_path.is_absolute():
            return cache_path
        return REPO_ROOT / cache_path
    return LOCAL_EMBEDDING_CACHE_DIR


def _norm(vector: Vector) -> float:
    values = vector.values() if isinstance(vector, dict) else vector
    return math.sqrt(sum(float(value) * float(value) for value in values))


def _cosine(
    left: Vector,
    left_norm: float,
    right: Vector,
    right_norm: float,
) -> float:
    if left_norm == 0 or right_norm == 0:
        return 0.0
    if isinstance(left, list) and isinstance(right, list):
        length = min(len(left), len(right))
        return sum(float(left[index]) * float(right[index]) for index in range(length)) / (left_norm * right_norm)
    if isinstance(left, list) or isinstance(right, list):
        return 0.0
    shared = set(left) & set(right)
    return sum(float(left[key]) * float(right[key]) for key in shared) / (left_norm * right_norm)


def _normalize_scores(scores: dict[str, float]) -> dict[str, float]:
    highest = max(scores.values()) if scores else 0.0
    if highest <= 0:
        return {key: 0.0 for key in scores}
    return {key: value / highest for key, value in scores.items()}


def _rerank(query: str, candidates: list[SearchHit]) -> list[SearchHit]:
    query_terms = set(query_tokens(query))

    def rerank_score(hit: SearchHit) -> float:
        chunk_terms = set(tokenize(hit.chunk.section + " " + hit.chunk.text))
        overlap = len(query_terms & chunk_terms)
        exact_section_bonus = 0.2 if query.strip().lower() in hit.chunk.section.lower() else 0.0
        return hit.score + overlap * 0.05 + exact_section_bonus

    return sorted(candidates, key=rerank_score, reverse=True)


def _has_sufficient_context(hits: list[SearchHit]) -> bool:
    return bool(hits and hits[0].score >= 0.05)


def _build_answer(query: str, hits: list[SearchHit]) -> str:
    lines = [f"基于已同步 GitHub Stars 索引，和「{query.strip()}」最相关的证据是："]
    seen: set[str] = set()
    for hit in hits:
        if hit.chunk.section in seen:
            continue
        seen.add(hit.chunk.section)
        fields = _parse_fields(hit.chunk.text)
        description = fields.get("Description", "")
        language = fields.get("Language", "")
        topics = fields.get("Topics", "")
        metadata = " · ".join(item for item in [language, topics] if item)
        suffix = f"（{metadata}）" if metadata else ""
        summary = f"{len(seen)}. {hit.chunk.section}{suffix}"
        if description:
            summary = f"{summary}：{description}"
        lines.append(summary)
        if len(lines) >= 6:
            break
    return "\n".join(lines)


def _source(hit: SearchHit) -> dict[str, object]:
    return {
        "repository": hit.chunk.section,
        "url": hit.chunk.source,
        "chunk_id": hit.chunk.chunk_id,
        "score": round(hit.score, 4),
        "bm25_score": round(hit.bm25_score, 4),
        "vector_score": round(hit.vector_score, 4),
    }


def _hit(hit: SearchHit) -> dict[str, object]:
    payload = asdict(hit)
    payload["evidence"] = hit.chunk.text
    return payload


def _star_payload(repository: dict[str, Any]) -> dict[str, object]:
    owner = repository.get("owner") or {}
    return {
        "id": repository.get("id"),
        "name": repository.get("name") or "",
        "fullName": repository.get("full_name") or repository.get("name") or "",
        "description": repository.get("description"),
        "htmlUrl": repository.get("html_url") or "",
        "language": repository.get("language"),
        "stargazersCount": repository.get("stargazers_count") or 0,
        "updatedAt": repository.get("updated_at") or "",
        "topics": repository.get("topics") or [],
        "owner": {
            "login": owner.get("login") or "",
            "avatarUrl": owner.get("avatar_url") or "",
        },
    }


def _synced_star_payload(row: sqlite3.Row) -> dict[str, object]:
    payload = _star_payload(json.loads(row["raw_json"]))
    payload["repoId"] = int(row["repo_id"])
    payload["syncedAt"] = float(row["synced_at"])
    payload["readmeLength"] = len(row["readme_text"] or "")
    payload["chunkCount"] = int(row["chunk_count"] or 0)
    return payload


def _parse_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip()
    return fields


def _pipeline_summary() -> list[dict[str, str]]:
    return [
        {"step": "sync", "description": "后台任务使用 GitHub Stars API 同步原始仓库数据和 README。"},
        {"step": "store_raw", "description": "SQLite 持久化 raw repository JSON、README 和同步进度。"},
        {"step": "embedding", "description": "对仓库元数据与 README chunk 生成 embedding 并写入本地向量库。"},
        {"step": "metadata_filtering", "description": "查询支持 language、topic、owner 源头过滤。"},
        {"step": "hybrid_search", "description": "从本地数据库加载 chunk，执行 BM25 search + vector search。"},
        {"step": "reranking", "description": "对混合召回候选按查询词覆盖和仓库名命中二次排序。"},
        {"step": "context_evaluation", "description": "检索证据不足时拒绝生成无依据答案。"},
    ]


def _progress(processed: object, total: object) -> int:
    total_number = int(total or 0)
    processed_number = int(processed or 0)
    if total_number <= 0:
        return 0
    return min(100, int(processed_number / total_number * 100))


def _now() -> float:
    return time.time()
