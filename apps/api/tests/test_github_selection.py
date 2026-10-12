"""Selective sync tests: all GitHub and embedding calls stay local to the test."""

import threading
from unittest.mock import Mock

import pytest

from rag_core import github_stars as stars

def repository(repo_id):
    return {
        "id": repo_id, "name": f"repo-{repo_id}", "full_name": f"owner/repo-{repo_id}",
        "html_url": f"https://github.com/owner/repo-{repo_id}",
        "description": "Useful repository", "owner": {"login": "owner"}, "topics": [],
    }

@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(stars, "_embedding_provider", lambda: "voyage")
    monkeypatch.setattr(stars, "_embed_document", lambda text: [1.0, 0.0])
    monkeypatch.setattr(stars, "_github_star_count", lambda token: 3)
    return stars.GithubStarsStore(tmp_path / "stars.sqlite")

def finish(store, user="user"):
    store._active_workers[user].join(timeout=5)
    assert not store._active_workers[user].is_alive()
    return store.sync_status(user)

def test_only_selected_repositories_are_indexed_and_remembered(store, monkeypatch):
    pages = Mock(side_effect=[
        ([repository(1), repository(2)], {"Link": '<https://api.github.com/page2>; rel="next"'}),
        ([repository(3)], {}),
    ])
    monkeypatch.setattr(stars, "_github_json_with_headers", pages)
    readmes = Mock(return_value="README content")
    monkeypatch.setattr(store, "_fetch_readme", readmes)
    store.start_sync("user", "token", repository_ids=[3, 1, 3])
    status = finish(store)
    assert status["status"] == "completed"
    assert status["total"] == status["processed"] == 2
    assert [call.args[1]["id"] for call in readmes.call_args_list] == [1, 3]
    assert {repo["repoId"] for repo in store.list_repositories("user")["stars"]} == {1, 3}
    assert store.selected_repository_ids("other-user") == []
    restarted = stars.GithubStarsStore(store.database_path)
    assert restarted.selected_repository_ids("user") == [1, 3]

def test_scheduled_sync_uses_last_selection_and_keeps_other_indexed_data(store, monkeypatch):
    monkeypatch.setattr(stars, "_github_json_with_headers", lambda *args: ([repository(1), repository(2)], {}))
    readmes = Mock(return_value="README")
    monkeypatch.setattr(store, "_fetch_readme", readmes)
    store.start_sync("user", "token", repository_ids=[1, 2])
    assert finish(store)["status"] == "completed"
    store.start_sync("user", "token", repository_ids=[2])
    assert finish(store)["status"] == "completed"
    readmes.reset_mock()
    store.start_sync("user", "token")
    assert finish(store)["status"] == "completed"
    assert [call.args[1]["id"] for call in readmes.call_args_list] == [2]
    assert store.list_repositories("user")["total"] == 2

def test_new_user_scheduled_sync_does_not_fetch_all_stars(store, monkeypatch):
    github = Mock()
    monkeypatch.setattr(stars, "_github_json_with_headers", github)
    assert store.start_sync("user", "token")["status"] == "idle"
    github.assert_not_called()
    assert "user" not in store._active_workers

@pytest.mark.parametrize("ids", [[], [0], [-1], [True], ["1"]])
def test_empty_or_invalid_selection_is_rejected(store, ids):
    with pytest.raises(ValueError):
        store.start_sync("user", "token", repository_ids=ids)
    assert "user" not in store._active_workers

def test_unstarred_selection_fails_before_model_load_or_storage(store, monkeypatch):
    monkeypatch.setattr(stars, "_embedding_provider", lambda: "local")
    model = Mock()
    monkeypatch.setattr(stars, "_load_local_embedding_model", model)
    monkeypatch.setattr(stars, "_github_json_with_headers", lambda *args: ([repository(1)], {}))
    readme = Mock()
    monkeypatch.setattr(store, "_fetch_readme", readme)
    store.start_sync("user", "token", repository_ids=[999])
    assert finish(store)["status"] == "failed"
    model.assert_not_called()
    readme.assert_not_called()
    assert store.list_repositories("user")["total"] == 0
    assert store.selected_repository_ids("user") == []

def test_catalog_is_paginated_scoped_and_does_not_download_readmes(store, monkeypatch):
    store._store_repository("user", repository(2), "previous README")
    store._store_repository("other-user", repository(3), "private index")
    github = Mock(return_value=([repository(2), repository(3)], {"link": '<https://api.github.com/next>; rel="next"'}))
    monkeypatch.setattr(stars, "_github_json_with_headers", github)
    readme = Mock()
    monkeypatch.setattr(store, "_fetch_readme", readme)
    result = store.available_repositories("user", "secret-token", page=2, max_pages=2)
    assert result["truncated"] and not result["has_more"]
    assert result["total_star_count"] == 3
    assert [repo["synced"] for repo in result["stars"]] == [True, False]
    assert result["selected_repository_ids"] == [2]
    assert "secret-token" not in str(result)
    assert "page=2" in github.call_args.args[0]
    readme.assert_not_called()

def test_fetch_stops_after_all_selected_repositories_are_found(store, monkeypatch):
    github = Mock(return_value=([repository(1), repository(2)], {"Link": '<https://api.github.com/next>; rel="next"'}))
    monkeypatch.setattr(stars, "_github_json_with_headers", github)
    monkeypatch.setattr(store, "_fetch_readme", lambda *args: "README")
    store.start_sync("user", "token", repository_ids=[1])
    assert finish(store)["status"] == "completed"
    assert github.call_count == 1

def test_cancel_during_catalog_fetch_prevents_indexing_and_restart_overlap(store, monkeypatch):
    started, release = threading.Event(), threading.Event()
    def fetch(*args):
        started.set()
        assert release.wait(timeout=5)
        return [repository(1)], {}
    monkeypatch.setattr(stars, "_github_json_with_headers", fetch)
    readme = Mock()
    monkeypatch.setattr(store, "_fetch_readme", readme)
    store.start_sync("user", "token", repository_ids=[1])
    assert started.wait(timeout=5)
    try:
        with pytest.raises(RuntimeError, match="已有同步任务"):
            store.start_sync("user", "token", repository_ids=[2])
        store.cancel_sync("user")
        with pytest.raises(RuntimeError):
            store.start_sync("user", "token", repository_ids=[1])
    finally:
        release.set()
    assert finish(store)["status"] == "canceled"
    readme.assert_not_called()
    assert store.list_repositories("user")["total"] == 0

def test_cancel_during_embedding_keeps_canceled_status(store, monkeypatch):
    monkeypatch.setattr(stars, "_github_json_with_headers", lambda *args: ([repository(1)], {}))
    monkeypatch.setattr(store, "_fetch_readme", lambda *args: "README")
    def embed(text):
        store.cancel_sync("user")
        return [1.0, 0.0]
    monkeypatch.setattr(stars, "_embed_document", embed)
    store.start_sync("user", "token", repository_ids=[1])
    assert finish(store)["status"] == "canceled"

@pytest.mark.parametrize("environment, expected", [("development", True), ("production", False), ("", False)])
def test_debug_logs_only_in_development(monkeypatch, capsys, environment, expected):
    monkeypatch.setenv("APP_ENV", environment)
    stars._dev_log("embedding.start", chunk=1)
    assert bool(capsys.readouterr().out) is expected

def test_interrupted_jobs_become_retryable_after_restart(store):
    with store._connect() as connection:
        connection.execute(
            """insert into github_star_sync_jobs
               (job_id, user_id, status, total, processed, indexed, message,
                cancel_requested, started_at, updated_at)
               values ('interrupted', 'user', 'running', 30, 0, 0, 'indexing', 0, 1, 1)"""
        )
    restarted = stars.GithubStarsStore(store.database_path)
    status = restarted.sync_status("user")
    assert status["status"] == "failed"
    assert status["message"] == "服务已重启，请重新同步"

def test_manual_import_skips_existing_valid_indexes(store, monkeypatch):
    monkeypatch.setattr(stars, "_github_json_with_headers", lambda *args: ([repository(1), repository(2)], {}))
    readmes = Mock(return_value="README")
    monkeypatch.setattr(store, "_fetch_readme", readmes)
    store.start_sync("user", "token", repository_ids=[1])
    assert finish(store)["status"] == "completed"
    readmes.reset_mock()
    store.start_sync("user", "token", repository_ids=[1, 2])
    result = finish(store)
    assert result["status"] == "completed"
    assert result["total"] == result["processed"] == 2
    assert "skipped 1" in result["message"]
    assert [call.args[1]["id"] for call in readmes.call_args_list] == [2]
    assert store.selected_repository_ids("user") == [1, 2]

def test_all_imported_selection_avoids_readme_and_model_calls(store, monkeypatch):
    monkeypatch.setattr(stars, "_embedding_provider", lambda: "local")
    monkeypatch.setattr(stars, "_github_json_with_headers", lambda *args: ([repository(1)], {}))
    store._store_repository("user", repository(1), "README")
    store._store_chunks("user", repository(1), "README")
    model = Mock(side_effect=AssertionError("must not load model"))
    readme = Mock(side_effect=AssertionError("must not fetch README"))
    monkeypatch.setattr(stars, "_load_local_embedding_model", model)
    monkeypatch.setattr(store, "_fetch_readme", readme)
    store.start_sync("user", "token", repository_ids=[1])
    result = finish(store)
    assert result["status"] == "completed" and result["processed"] == 1
    assert result["indexed"] == 0 and "skipped 1" in result["message"]
    model.assert_not_called()
    readme.assert_not_called()

def test_skip_is_account_scoped_and_reindexes_missing_or_changed_vectors(store, monkeypatch):
    monkeypatch.setattr(stars, "_github_json_with_headers", lambda *args: ([repository(1), repository(2), repository(3)], {}))
    store._store_repository("other-user", repository(1), "README")
    store._store_chunks("other-user", repository(1), "README")
    store._store_repository("user", repository(2), "interrupted import")
    store._store_repository("user", repository(3), "old model")
    store._store_chunks("user", repository(3), "old model")
    from rag_core.embedding_settings import EmbeddingConfig
    store.embedding_settings.save("user", EmbeddingConfig(model="new-model"))
    readmes = Mock(return_value="README")
    monkeypatch.setattr(store, "_fetch_readme", readmes)
    store.start_sync("user", "token", repository_ids=[1, 2, 3])
    assert finish(store)["status"] == "completed"
    assert [call.args[1]["id"] for call in readmes.call_args_list] == [1, 2, 3]

def test_all_import_reads_next_page_only_after_indexing_current_page(store, monkeypatch):
    order = []
    def fetch(url, token):
        if "page=1" in url:
            order.append("page1")
            return [repository(1), repository(2)], {"Link": '<https://api.github.com/user/starred?page=2>; rel="next"'}
        order.append("page2")
        return [repository(3)], {}
    monkeypatch.setattr(stars, "_github_json_with_headers", fetch)
    monkeypatch.setattr(store, "_fetch_readme", lambda token, repo: order.append(f"readme{repo['id']}") or "README")
    store.start_sync("user", "token", select_all=True, excluded_repository_ids=[2])
    result = finish(store)
    assert result["status"] == "completed"
    assert order == ["page1", "readme1", "page2", "readme3"]
    assert result["processed"] == result["total"] == 3
    assert store.selected_repository_ids("user") == [1, 3]

def test_all_import_skips_existing_and_reports_page_limit(store, monkeypatch):
    store._store_repository("user", repository(1), "README")
    store._store_chunks("user", repository(1), "README")
    monkeypatch.setattr(stars, "_github_json_with_headers", lambda *args: ([repository(1)], {"Link": '<https://api.github.com/user/starred?page=2>; rel="next"'}))
    readme = Mock(side_effect=AssertionError("already indexed"))
    monkeypatch.setattr(store, "_fetch_readme", readme)
    store.start_sync("user", "token", select_all=True, max_pages=1)
    result = finish(store)
    assert result["status"] == "failed" and "page limit" in result["error"]
    readme.assert_not_called()

def test_cancel_all_import_stops_before_fetching_more_pages(store, monkeypatch):
    fetched = Mock(return_value=([repository(1)], {"Link": '<https://api.github.com/user/starred?page=2>; rel="next"'}))
    monkeypatch.setattr(stars, "_github_json_with_headers", fetched)
    def readme(*args):
        store.cancel_sync("user")
        return "README"
    monkeypatch.setattr(store, "_fetch_readme", readme)
    store.start_sync("user", "token", select_all=True)
    assert finish(store)["status"] == "canceled"
    assert fetched.call_count == 1
