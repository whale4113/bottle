"""Smoke tests for the installed API, using temporary documents and storage."""

from importlib import import_module
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from rag_core.github_stars import GithubStarsStore
from rag_core.service import RagService


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    root = tmp_path_factory.mktemp("api")
    docs = root / "materials"
    docs.mkdir()
    (docs / "search.md").write_text(
        "# Hybrid search\n\nHybrid search combines keyword and vector retrieval.\n",
        encoding="utf-8",
    )
    # Importing the application must not open the developer's Stars database.
    with patch("rag_core.github_stars.GithubStarsStore") as store_factory:
        store_factory.return_value = GithubStarsStore(root / "stars.sqlite")
        server = import_module("rag_api.server")
    server.rag_service = RagService(docs)
    with TestClient(server.app) as api_client:
        yield api_client


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_document_search_preserves_sources(client):
    documents = client.get("/api/documents").json()["documents"]
    assert len(documents) == 1
    assert documents[0]["title"] == "search"
    response = client.post("/api/search", json={"query": "hybrid search", "top_k": 3})
    assert response.status_code == 200
    result = response.json()
    assert result["document_count"] == 1
    assert result["sources"]
    assert result["hits"]


@pytest.mark.parametrize("payload, status", [
    ({"query": "   "}, 400),
    ({"query": ""}, 422),
    ({"query": "search", "top_k": 0}, 422),
    ({"query": "search", "top_k": 21}, 422),
])
def test_invalid_search(client, payload, status):
    assert client.post("/api/search", json=payload).status_code == status


def test_stars_storage_is_available(client):
    response = client.get("/api/github/stars/test-user")
    assert response.status_code == 200
    assert response.json()["stars"] == []


@pytest.mark.parametrize("ids", [[], [0], [-1], [True], ["1"], [1.5]])
def test_sync_rejects_invalid_repository_ids(client, ids):
    response = client.post("/api/github/stars/sync", json={
        "user_id": "test-user", "access_token": "test-token", "repository_ids": ids,
    })
    assert response.status_code == 422


def test_sync_passes_selection_to_worker(client, monkeypatch):
    from unittest.mock import Mock
    server = import_module("rag_api.server")
    start = Mock(return_value={"status": "queued"})
    monkeypatch.setattr(server.github_stars_store, "start_sync", start)
    response = client.post("/api/github/stars/sync", json={
        "user_id": "test-user", "access_token": "test-token", "repository_ids": [2, 9],
    })
    assert response.status_code == 200
    start.assert_called_once_with("test-user", "test-token", max_pages=50, repository_ids=[2, 9])


def test_catalog_authorization_failure_has_actionable_error(client, monkeypatch):
    import urllib.error
    from unittest.mock import Mock
    server = import_module("rag_api.server")
    monkeypatch.setattr(server.github_stars_store, "available_repositories", Mock(
        side_effect=urllib.error.HTTPError("https://api.github.com", 401, "Unauthorized", {}, None),
    ))
    response = client.post("/api/github/stars/available", json={
        "user_id": "test-user", "access_token": "expired-token",
    })
    assert response.status_code == 401
    assert "重新登录" in response.json()["detail"]
    assert "expired-token" not in response.text


def test_websocket_sends_snapshot_updates_and_cleans_up(client, monkeypatch):
    server = import_module("rag_api.server")
    store = server.github_stars_store
    with client.websocket_connect("/api/github/stars/sync/socket-user/ws") as socket:
        initial = socket.receive_json()
        assert initial["type"] == "sync.status"
        assert initial["data"]["status"] == "idle"
        with store._connect() as connection:
            connection.execute(
                """insert into github_star_sync_jobs
                   (job_id, user_id, status, total, processed, indexed, message,
                    cancel_requested, started_at, updated_at)
                   values ('socket-job', 'socket-user', 'running', 1, 0, 0, 'start', 0, 1, 1)"""
            )
        store._update_job("socket-job", message="正在生成向量 1/3")
        assert socket.receive_json()["data"]["message"] == "正在生成向量 1/3"
        store.cancel_sync("socket-user")
        assert socket.receive_json()["data"]["status"] == "canceled"
    assert "socket-user" not in store._listeners
    with client.websocket_connect("/api/github/stars/sync/socket-user/ws") as socket:
        assert socket.receive_json()["data"]["status"] == "canceled"


def test_available_network_failure_returns_actionable_503(client, monkeypatch):
    server = import_module("rag_api.server")
    from rag_core.github_stars import GithubNetworkError

    def unavailable(*args):
        raise GithubNetworkError("连接 GitHub 失败，已尝试 4 次")

    monkeypatch.setattr(server.github_stars_store, "available_repositories", unavailable)
    response = client.post("/api/github/stars/available", json={"user_id": "user", "access_token": "secret"})
    assert response.status_code == 503
    assert "已尝试 4 次" in response.json()["detail"]
    assert "secret" not in response.text
