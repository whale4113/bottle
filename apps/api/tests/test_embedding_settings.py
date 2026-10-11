"""Embedding providers, account isolation and vector compatibility."""
import json
import threading
import urllib.error
from unittest.mock import MagicMock, Mock

import pytest

from rag_core.embedding_settings import EmbeddingConfig, EmbeddingSettingsStore, current_config, use_config
from rag_core.github_stars import GithubStarsStore, _cosine
from rag_core import github_stars as stars
from rag_core import openai_embeddings
from rag_core.service import RagService


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "local")
    return GithubStarsStore(tmp_path / "stars.sqlite")


def api_config(**changes):
    return EmbeddingConfig(provider="openai", model="test-model", base_url="http://127.0.0.1:1234/v1", api_key="test-secret", **changes)


def test_settings_persist_per_user_without_returning_keys(store):
    store.embedding_settings.save("alice", api_config())
    saved = store.embedding_configuration("alice")
    assert saved["has_api_key"] is True
    assert "api_key" not in saved and "test-secret" not in json.dumps(saved)
    assert "test-secret" not in repr(api_config())
    assert store.embedding_configuration("bob")["provider"] == "local"
    restarted = EmbeddingSettingsStore(store.database_path)
    assert restarted.get("alice").api_key == "test-secret"
    assert store.database_path.stat().st_mode & 0o777 == 0o600


def test_saved_key_is_not_sent_to_changed_endpoint(store):
    store.embedding_settings.save("alice", api_config())
    values = {"provider": "openai", "model": "test-model", "base_url": "http://127.0.0.1:1234/v1"}
    assert store.embedding_settings.candidate("alice", values).api_key == "test-secret"
    assert store.embedding_settings.candidate("alice", {**values, "base_url": "https://other.example/v1"}).api_key == ""
    assert store.embedding_settings.candidate("alice", {**values, "api_key": ""}).api_key == ""
    assert store.embedding_settings.candidate("alice", {"provider": "local", "model": "local-model"}).api_key == ""


def test_openai_payload_headers_and_dimensions(monkeypatch):
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = json.dumps({"data": [{"embedding": [1, 0]}]}).encode()
    opener = Mock()
    opener.open.return_value = response
    monkeypatch.setattr(openai_embeddings.urllib.request, "build_opener", lambda *args: opener)
    with use_config(api_config(dimensions=2)):
        assert openai_embeddings.embed("document text") == [1.0, 0.0]
    request = opener.open.call_args.args[0]
    assert request.full_url == "http://127.0.0.1:1234/v1/embeddings"
    assert request.get_header("Authorization") == "Bearer test-secret"
    assert json.loads(request.data) == {"model": "test-model", "input": ["document text"], "encoding_format": "float", "dimensions": 2}
    assert opener.open.call_args.kwargs["timeout"] == 60


@pytest.mark.parametrize("payload", [None, {}, {"data": []}, {"data": [{"embedding": []}]}, {"data": [{"embedding": "base64"}]}, {"data": [{"embedding": [True]}]}, {"data": [{"embedding": [float('nan')]}]}, {"data": [{"embedding": [1, 2, 3]}]}])
def test_invalid_remote_vectors_are_rejected(monkeypatch, payload):
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = json.dumps(payload).encode()
    opener = Mock()
    opener.open.return_value = response
    monkeypatch.setattr(openai_embeddings.urllib.request, "build_opener", lambda *args: opener)
    with use_config(api_config(dimensions=2)), pytest.raises(RuntimeError):
        openai_embeddings.embed("test")


def test_remote_errors_do_not_expose_upstream_content(monkeypatch):
    opener = Mock()
    opener.open.side_effect = urllib.error.HTTPError("https://private", 401, "test-secret and private text", {}, None)
    monkeypatch.setattr(openai_embeddings.urllib.request, "build_opener", lambda *args: opener)
    with use_config(api_config()), pytest.raises(RuntimeError, match="authentication failed") as error:
        openai_embeddings.embed("private document")
    assert "test-secret" not in str(error.value) and "private document" not in str(error.value)


@pytest.mark.parametrize("values", [
    {"provider": "unknown", "model": "model"},
    {"provider": "openai", "model": "model", "base_url": "file:///tmp"},
    {"provider": "openai", "model": "model", "base_url": "https://user:password@example.com/v1"},
    {"provider": "openai", "model": "model", "base_url": "https://example.com/v1/embeddings"},
    {"provider": "openai", "model": "model", "dimensions": 0},
    {"provider": "local", "model": ""},
    {"provider": "local", "model": "model", "timeout": float('nan')},
])
def test_invalid_configuration_is_rejected(store, values):
    with pytest.raises(ValueError):
        store.embedding_settings.candidate("alice", values)


def test_background_worker_keeps_account_configuration(store, monkeypatch):
    config = api_config()
    store.embedding_settings.save("alice", config)
    observed = []
    monkeypatch.setattr(store, "_run_sync", lambda *args: observed.append(current_config()))
    store.start_sync("alice", "github-token", repository_ids=[1])
    store._active_workers["alice"].join(2)
    assert observed == [config]
    assert current_config().provider == "local"


def test_configuration_cannot_change_during_import(store):
    running = threading.Event()
    worker = threading.Thread(target=lambda: running.wait(2))
    store._active_workers["alice"] = worker
    worker.start()
    try:
        with pytest.raises(RuntimeError, match="current import"):
            store.save_embedding_configuration("alice", {"provider": "local", "model": "new-model"})
    finally:
        running.set()
        worker.join(2)


def test_model_endpoint_and_dimensions_do_not_mix_vectors(store, monkeypatch):
    repository = {"id": 1, "full_name": "owner/repo", "html_url": "https://github.com/owner/repo"}
    monkeypatch.setattr(stars, "_embed_document", lambda text: [1.0, 0.0])
    store._store_repository("alice", repository, "README")
    with use_config(api_config(dimensions=2)):
        store._store_chunks("alice", repository, "README")
        assert store._load_chunks("alice", {})
    for config in [api_config(dimensions=3), EmbeddingConfig(provider="openai", model="other", base_url="http://127.0.0.1:1234/v1"), EmbeddingConfig(provider="openai", model="test-model", base_url="http://127.0.0.1:5678/v1", dimensions=2)]:
        store.embedding_settings.save("alice", config)
        with use_config(config):
            assert store._load_chunks("alice", {}) == []
        assert store.embedding_configuration("alice")["reindex_required"] is True
    with pytest.raises(ValueError, match="dimensions do not match"):
        _cosine([1, 0], 1, [1, 0, 0], 1)


def test_local_document_search_uses_config_and_caches_vectors(tmp_path, monkeypatch):
    (tmp_path / "guide.md").write_text("# Guide\n\nDocument retrieval with embeddings.")
    service = RagService(tmp_path)
    documents = Mock(side_effect=lambda text: [1.0, 0.0])
    queries = Mock(return_value=[1.0, 0.0])
    monkeypatch.setattr(stars, "_embed_document", documents)
    monkeypatch.setattr(stars, "_embed_query", queries)
    config = api_config()
    assert service.ask("retrieval", embedding_config=config, user_id="alice")["hits"]
    count = documents.call_count
    service.ask("embeddings", embedding_config=config, user_id="alice")
    assert documents.call_count == count
    service.ask("embeddings", embedding_config=EmbeddingConfig(model="another-local-model"), user_id="alice")
    assert documents.call_count > count
    assert queries.call_count == 3


def test_local_model_cache_changes_with_model_id(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    constructor = Mock(side_effect=lambda *args, **kwargs: object())
    monkeypatch.setitem(sys.modules, "sentence_transformers", SimpleNamespace(SentenceTransformer=constructor))
    monkeypatch.setenv("LOCAL_EMBEDDING_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(stars, "_LOCAL_EMBEDDING_MODEL_CACHE", None)
    monkeypatch.setattr(stars, "_LOCAL_EMBEDDING_MODEL_KEY", None)
    with use_config(EmbeddingConfig(model="model-a")):
        first = stars._load_local_embedding_model()
        assert stars._load_local_embedding_model() is first
    with use_config(EmbeddingConfig(model="model-b")):
        assert stars._load_local_embedding_model() is not first
    assert [call.args[0] for call in constructor.call_args_list] == ["model-a", "model-b"]
