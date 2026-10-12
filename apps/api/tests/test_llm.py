"""LLM persistence, transport and source grounding without external API calls."""
import json
import urllib.error
from unittest.mock import MagicMock, Mock

import pytest

from rag_core import llm


@pytest.fixture
def store(tmp_path):
    return llm.LlmSettingsStore(tmp_path / "settings.sqlite")


def config():
    return llm.LlmConfig(enabled=True, model="custom-chat", base_url="http://localhost:8000/v1", api_key="private-key")


def test_account_isolation_and_private_keys(store):
    store.save("alice", config())
    assert store.get("alice") == config()
    assert store.get("bob").enabled is False
    assert "private-key" not in json.dumps(store.get("alice").public())
    assert "private-key" not in repr(config())
    assert llm.LlmSettingsStore(store.path).get("alice") == config()
    assert store.path.stat().st_mode & 0o777 == 0o600


def test_keep_remove_and_change_endpoint_keys(store):
    store.save("alice", config())
    values = {"enabled": True, "model": "custom-chat", "base_url": config().base_url}
    assert store.candidate("alice", values).api_key == "private-key"
    assert store.candidate("alice", {**values, "api_key": ""}).api_key == ""
    assert store.candidate("alice", {**values, "base_url": "http://other/v1"}).api_key == ""


@pytest.mark.parametrize("values", [
    {"enabled": True, "model": ""},
    {"enabled": True, "model": "chat"},
    {"base_url": "file:///tmp"},
    {"base_url": "https://key:secret@example.com/v1"},
    {"base_url": "https://example.com/v1/chat/completions"},
    {"timeout": 0}, {"api_key": "secret\nheader"},
])
def test_invalid_settings(store, values):
    with pytest.raises(ValueError):
        store.candidate("alice", values)


def test_transport_schema_and_grounded_prompt(monkeypatch):
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = json.dumps({"choices": [{"message": {"content": "Supported answer [1]."}}]}).encode()
    opener = Mock()
    opener.open.return_value = response
    monkeypatch.setattr(llm.urllib.request, "build_opener", lambda *args: opener)
    sources = [{"source": "guide.md", "title": "Guide", "passages": ["Document evidence."]}]
    assert llm.generate_answer(config(), "question", sources)["answer"] == "Supported answer [1]."
    request = opener.open.call_args.args[0]
    assert request.full_url == "http://localhost:8000/v1/chat/completions"
    assert request.get_header("Authorization") == "Bearer private-key"
    payload = json.loads(request.data)
    assert payload["model"] == "custom-chat" and payload["stream"] is False
    assert "untrusted data" in payload["messages"][0]["content"]
    assert json.loads(payload["messages"][1]["content"])["sources"][0]["citation"] == 1


def test_disabled_or_empty_sources_never_call_remote(monkeypatch):
    call = Mock(side_effect=AssertionError("must not call"))
    monkeypatch.setattr(llm, "complete", call)
    assert llm.generate_answer(llm.LlmConfig(), "question", [{"title": "a"}])["answer"] == ""
    assert llm.generate_answer(config(), "question", [])["answer"] == ""


def test_invalid_citations_are_rejected(monkeypatch):
    monkeypatch.setattr(llm, "complete", lambda *args: "Invented citation [2]")
    with pytest.raises(RuntimeError, match="invalid source citations"):
        llm.generate_answer(config(), "question", [{"source": "guide.md", "title": "Guide", "passages": ["Evidence"]}])


@pytest.mark.parametrize("payload", [{}, {"choices": []}, {"choices": [{"message": {"content": None}}]}, {"choices": [{"message": {"content": " "}}]}])
def test_invalid_completion_responses(monkeypatch, payload):
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = json.dumps(payload).encode()
    opener = Mock()
    opener.open.return_value = response
    monkeypatch.setattr(llm.urllib.request, "build_opener", lambda *args: opener)
    with pytest.raises(RuntimeError):
        llm.complete(config(), [])


def test_errors_do_not_echo_upstream_secrets(monkeypatch):
    opener = Mock()
    opener.open.side_effect = urllib.error.HTTPError("http://localhost", 401, "private-key", {}, None)
    monkeypatch.setattr(llm.urllib.request, "build_opener", lambda *args: opener)
    with pytest.raises(RuntimeError, match="authentication failed") as error:
        llm.complete(config(), [])
    assert "private-key" not in str(error.value)


def stream_response(monkeypatch, lines):
    response = MagicMock()
    response.__enter__.return_value = response
    response.__iter__.return_value = iter(lines)
    opener = Mock()
    opener.open.return_value = response
    monkeypatch.setattr(llm.urllib.request, "build_opener", lambda *args: opener)
    return response, opener


def test_stream_yields_deltas_before_completion_and_closes_response(monkeypatch):
    def event(text):
        return ("data: " + json.dumps({"choices": [{"delta": {"content": text}}]}, ensure_ascii=False) + "\r\n\r\n").encode()
    lines = (event("# 中文\n\n") + event("**Answer** [1]") + b'data: [DONE]\n\n').splitlines(keepends=True)
    response, opener = stream_response(monkeypatch, lines)
    events = llm.stream_answer(config(), "question", [{"source": "guide.md", "title": "Guide", "passages": ["Evidence"]}])
    assert next(events) == {"type": "delta", "text": "# 中文\n\n"}
    assert not response.__exit__.called
    assert list(events) == [{"type": "delta", "text": "**Answer** [1]"}, {"type": "done", "enabled": True, "model": "custom-chat"}]
    assert response.__exit__.called
    assert json.loads(opener.open.call_args.args[0].data)["stream"] is True


@pytest.mark.parametrize("lines, message", [
    ([b'data: {"choices":[{"delta":{"content":"partial"}}]}\n', b'\n'], "unexpectedly"),
    ([b'data: invalid\n', b'\n'], "invalid streaming response"),
    ([b'data: {"error":{"message":"private-key"}}\n', b'\n'], "invalid streaming response"),
    ([b'data: [DONE]\n', b'\n'], "empty answer"),
    ([b'data: {"choices":[{"delta":{"content":"invalid [9]"}}]}\n', b'\n', b'data: [DONE]\n', b'\n'], "invalid source citations"),
])
def test_stream_errors_are_explicit_and_sanitized(monkeypatch, lines, message):
    stream_response(monkeypatch, lines)
    events = list(llm.stream_answer(config(), "q", [{"source": "s", "title": "t", "passages": ["e"]}]))
    assert events[-1]["type"] == "error"
    assert message in events[-1]["message"]
    assert "private-key" not in json.dumps(events)


def test_stream_cancellation_closes_upstream(monkeypatch):
    response, _ = stream_response(monkeypatch, [b'data: {"choices":[{"delta":{"content":"first"}}]}\n', b'\n'])
    events = llm.stream_answer(config(), "q", [{"source": "s", "title": "t", "passages": ["e"]}])
    next(events)
    events.close()
    assert response.__exit__.called


def test_disabled_stream_does_not_call_api(monkeypatch):
    monkeypatch.setattr(llm.urllib.request, "build_opener", Mock(side_effect=AssertionError("unexpected call")))
    assert list(llm.stream_answer(llm.LlmConfig(), "q", [])) == [{"type": "done", "enabled": False}]


def test_summary_settings_are_account_scoped_and_preserve_omitted_prompts(tmp_path):
    from dataclasses import replace
    store = llm.LlmSettingsStore(tmp_path / 'settings.sqlite')
    config = llm.LlmConfig(model='summary-model', base_url='http://localhost:8080/v1', github_summary_prompt='Focus on APIs.', document_summary_prompt='Focus on constraints.', embedding_summary_enabled=True)
    store.save('alice', config)
    assert store.get('alice').github_summary_prompt == 'Focus on APIs.'
    assert store.get('bob').github_summary_prompt == llm.GITHUB_SUMMARY_PROMPT
    updated = store.candidate('alice', {'enabled': False})
    assert updated.github_summary_prompt == 'Focus on APIs.'
    assert updated.embedding_summary_enabled is True
    assert updated.public()['summary_prompt_defaults']['github'] == llm.GITHUB_SUMMARY_PROMPT
    with pytest.raises(ValueError):
        replace(config, github_summary_prompt=' ').validate()
    with pytest.raises(ValueError):
        replace(config, document_summary_prompt='x' * 6001).validate()


def test_answer_and_summary_switches_are_independent(store, monkeypatch):
    summary_only = store.candidate('alice', {
        'answer_enabled': False, 'embedding_summary_enabled': True,
        'model': 'summary-model', 'base_url': 'http://localhost:8080/v1',
    })
    store.save('alice', summary_only)
    assert store.get('alice').public()['answer_enabled'] is False
    assert store.get('alice').embedding_summary_enabled is True
    complete = Mock(return_value='An English summary.')
    monkeypatch.setattr(llm, 'complete', complete)
    from rag_core.embedding_text import prepare_embedding_text, _summarize
    _summarize.cache_clear()
    assert prepare_embedding_text('Original source', 'topic', summary_only) == 'An English summary.'
    assert llm.generate_answer(summary_only, 'question', [{'passages': ['evidence']}])['answer'] == ''
    assert complete.call_count == 1
    answer_only = store.candidate('alice', {
        'answer_enabled': True, 'embedding_summary_enabled': False,
        'model': 'summary-model', 'base_url': 'http://localhost:8080/v1',
    })
    assert prepare_embedding_text('Original source', 'topic', answer_only) == 'Original source'
    assert llm.generate_answer(answer_only, 'question', [{'source': 'guide', 'title': 'Guide', 'passages': ['evidence']}])['answer']
    assert complete.call_count == 2


def test_summary_only_requires_valid_model(store):
    with pytest.raises(ValueError, match='model ID'):
        store.candidate('alice', {'answer_enabled': False, 'embedding_summary_enabled': True})
