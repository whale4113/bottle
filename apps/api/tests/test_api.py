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


def test_http_sync_status_returns_latest_user_snapshot(client):
    server = import_module("rag_api.server")
    store = server.github_stars_store
    url = "/api/github/stars/sync/poll-user"
    assert client.get(url).json()["status"] == "idle"
    with store._connect() as connection:
        connection.execute(
            """insert into github_star_sync_jobs
               (job_id, user_id, status, total, processed, indexed, message,
                cancel_requested, started_at, updated_at)
               values ('poll-job', 'poll-user', 'running', 1, 0, 0, 'start', 0, 1, 1)"""
        )
    store._update_job("poll-job", message="正在生成向量 1/3")
    response = client.get(url)
    assert response.status_code == 200
    assert response.json()["message"] == "正在生成向量 1/3"
    assert client.get("/api/github/stars/sync/other-user").json()["status"] == "idle"
    store.cancel_sync("poll-user")
    assert client.get(url).json()["status"] == "canceled"


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


def test_embedding_settings_save_redacts_key_and_scopes_user(client):
    payload = {"user_id": "settings-owner", "provider": "openai", "model": "custom-model",
               "base_url": "http://localhost:8080/v1", "api_key": "private-credential", "dimensions": 3}
    response = client.post("/api/settings/embedding", json=payload)
    assert response.status_code == 200
    assert response.json()["has_api_key"] is True
    assert "private-credential" not in response.text
    assert "api_key" not in response.json()
    assert client.get("/api/settings/embedding/settings-owner").json()["model"] == "custom-model"
    assert client.get("/api/settings/embedding/other-owner").json()["model"] != "custom-model"


def test_embedding_connection_test_does_not_save(client, monkeypatch):
    from rag_core.embedding_settings import current_config
    def embed(text):
        assert current_config().model == "unsaved-model"
        return [1.0, 0.0, 0.0]
    monkeypatch.setattr("rag_core.github_stars._embed_query", embed)
    response = client.post("/api/settings/embedding/test", json={
        "user_id": "test-only-owner", "provider": "local", "model": "unsaved-model",
    })
    assert response.json() == {"status": "ok", "dimensions": 3}
    assert client.get("/api/settings/embedding/test-only-owner").json()["model"] != "unsaved-model"


def test_embedding_validation_does_not_echo_secret(client):
    secret = "private-credential" * 300
    response = client.post("/api/settings/embedding", json={
        "user_id": "validation-owner", "provider": "openai", "model": "test", "api_key": secret,
    })
    assert response.status_code == 422
    assert "private-credential" not in response.text


def test_search_uses_account_embedding_configuration(client, monkeypatch):
    from unittest.mock import Mock
    server = import_module("rag_api.server")
    server.github_stars_store.save_embedding_configuration("search-owner", {
        "provider": "local", "model": "account-model",
    })
    ask = Mock(return_value={"hits": []})
    monkeypatch.setattr(server.rag_service, "ask", ask)
    assert client.post("/api/search", json={"query": "question", "user_id": "search-owner"}).status_code == 200
    assert ask.call_args.kwargs["embedding_config"].model == "account-model"
    assert ask.call_args.kwargs["user_id"] == "search-owner"


def test_llm_save_get_test_and_answer(client, monkeypatch):
    server = import_module("rag_api.server")
    values = {"user_id": "llm-owner", "enabled": True, "model": "custom-chat",
              "base_url": "http://localhost:8000/v1", "api_key": "llm-private-key"}
    response = client.post("/api/settings/llm", json=values)
    assert response.status_code == 200
    assert response.json()["has_api_key"] is True
    assert "llm-private-key" not in response.text
    assert client.get("/api/settings/llm/llm-owner").json()["model"] == "custom-chat"
    assert client.get("/api/settings/llm/llm-other").json()["enabled"] is False
    monkeypatch.setattr(server, "complete", lambda config, messages: "OK")
    assert client.post("/api/settings/llm/test", json={**values, "model": "unsaved"}).json() == {"status": "ok"}
    assert client.get("/api/settings/llm/llm-owner").json()["model"] == "custom-chat"
    monkeypatch.setattr("rag_core.llm.complete", lambda config, messages: "Answer [1].")
    result = client.post("/api/answer", json={"user_id": "llm-owner", "query": "question", "sources": [
        {"source": "guide.md", "title": "Guide", "passages": ["Evidence"]},
    ]})
    assert result.status_code == 200 and result.json()["answer"] == "Answer [1]."


def test_llm_validation_redacts_key_and_bounds_sources(client):
    response = client.post("/api/settings/llm", json={"user_id": "owner", "api_key": "llm-secret" * 500})
    assert response.status_code == 422 and "llm-secret" not in response.text
    assert client.post("/api/answer", json={"user_id": "owner", "query": "question", "sources": [
        {"source": "s", "title": "t", "passages": ["p" * 4001]},
    ]}).status_code == 422


def test_answer_stream_delivers_json_lines(client, monkeypatch):
    import json
    server = import_module("rag_api.server")
    monkeypatch.setattr(server, "stream_answer", lambda config, query, sources: iter([
        {"type": "delta", "text": "中文 **answer**"}, {"type": "done", "enabled": True},
    ]))
    response = client.post("/api/answer/stream", json={"user_id": "stream-owner", "query": "question", "sources": []})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert response.headers["x-accel-buffering"] == "no"
    assert [json.loads(line) for line in response.text.splitlines()] == [
        {"type": "delta", "text": "中文 **answer**"}, {"type": "done", "enabled": True},
    ]


def test_all_import_passes_mode_without_enumerating_ids(client, monkeypatch):
    from unittest.mock import Mock
    server = import_module("rag_api.server")
    start = Mock(return_value={"status": "queued"})
    monkeypatch.setattr(server.github_stars_store, "start_sync", start)
    response = client.post("/api/github/stars/sync", json={"user_id": "owner", "access_token": "secret", "select_all": True, "excluded_repository_ids": [7]})
    assert response.status_code == 200
    start.assert_called_once_with("owner", "secret", max_pages=50, repository_ids=None, select_all=True, excluded_repository_ids=[7])
    assert client.post("/api/github/stars/sync", json={"user_id": "owner", "access_token": "secret", "select_all": True, "repository_ids": [1]}).status_code == 422


def test_summary_prompts_roundtrip_and_are_account_scoped(client):
    payload = {
        'user_id': 'summary-owner', 'answer_enabled': False,
        'model': 'summary-model', 'base_url': 'http://localhost:8080/v1',
        'embedding_summary_enabled': True,
        'github_summary_prompt': 'Summarize repository features in concise English.',
        'document_summary_prompt': 'Summarize decisions and constraints in English.',
    }
    response = client.post('/api/settings/llm', json=payload)
    assert response.status_code == 200
    for key in ('embedding_summary_enabled', 'github_summary_prompt', 'document_summary_prompt'):
        assert response.json()[key] == payload[key]
    saved = client.get('/api/settings/llm/summary-owner').json()
    assert saved['github_summary_prompt'] == payload['github_summary_prompt']
    other = client.get('/api/settings/llm/summary-other').json()
    assert other['embedding_summary_enabled'] is False
    assert other['github_summary_prompt'] == other['summary_prompt_defaults']['github']
    assert 'api_key' not in saved
    assert client.post('/api/settings/llm', json={**payload, 'github_summary_prompt': ' '}).status_code == 400


def test_embedding_inspection_pagination_validation_and_empty_cache(client):
    response = client.get('/api/github/stars/other-owner/repositories/1/embeddings')
    assert response.status_code == 200
    assert response.json()['chunks'] == []
    assert client.get('/api/github/stars/other-owner/repositories/1/embeddings?offset=-1').status_code == 422
    assert client.get('/api/github/stars/other-owner/repositories/1/embeddings?limit=100').status_code == 422
    response = client.get('/api/documents/embeddings/other-owner', params={'source': 'materials/search.md'})
    assert response.status_code == 200
    assert response.json()['chunks'] == []
