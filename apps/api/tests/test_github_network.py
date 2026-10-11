"""Transient GitHub TLS failures retry without disabling certificate verification."""
import http.client
import ssl
import urllib.error
from unittest.mock import Mock, MagicMock

import pytest
from rag_core import github_stars as stars


def response(body=b'[]'):
    result = MagicMock()
    result.__enter__.return_value = result
    result.headers = {"Link": "next"}
    result.read.return_value = body
    return result


@pytest.mark.parametrize('error', [
    urllib.error.URLError(ssl.SSLEOFError(8, 'unexpected EOF')),
    ssl.SSLEOFError(8, 'unexpected EOF'),
    TimeoutError('timed out'),
    ConnectionResetError('reset'),
    http.client.IncompleteRead(b'partial', 100),
    urllib.error.HTTPError('https://api.github.com', 503, 'unavailable', {}, None),
])
def test_transient_network_errors_retry_then_succeed(monkeypatch, error):
    first = response()
    if isinstance(error, http.client.IncompleteRead):
        first.read.side_effect = error
        outcomes = [first, response()]
    else:
        outcomes = [error, response()]
    request = Mock(side_effect=outcomes)
    sleep = Mock()
    monkeypatch.setattr(stars.urllib.request, 'urlopen', request)
    monkeypatch.setattr(stars.time, 'sleep', sleep)
    assert stars._github_text_with_headers('https://api.github.com/user/starred', 'secret', 'application/json')[0] == '[]'
    assert request.call_count == 2
    sleep.assert_called_once_with(1)
    assert 'context' not in request.call_args.kwargs


def test_retries_are_bounded_and_failure_is_actionable(monkeypatch):
    request = Mock(side_effect=urllib.error.URLError(ssl.SSLEOFError(8, 'EOF')))
    sleep = Mock()
    monkeypatch.setattr(stars.urllib.request, 'urlopen', request)
    monkeypatch.setattr(stars.time, 'sleep', sleep)
    with pytest.raises(stars.GithubNetworkError, match='已尝试 4 次'):
        stars._github_text_with_headers('https://api.github.com/user/starred', 'secret', 'application/json')
    assert request.call_count == 4
    assert [call.args[0] for call in sleep.call_args_list] == [1, 2, 4]


@pytest.mark.parametrize('error', [
    urllib.error.HTTPError('https://api.github.com', 401, 'unauthorized', {}, None),
    urllib.error.HTTPError('https://api.github.com', 403, 'forbidden', {}, None),
    urllib.error.HTTPError('https://api.github.com', 404, 'not found', {}, None),
    urllib.error.HTTPError('https://api.github.com', 429, 'rate limit', {}, None),
    urllib.error.URLError(ssl.SSLCertVerificationError(1, 'invalid certificate')),
])
def test_permanent_errors_are_not_retried(monkeypatch, error):
    request = Mock(side_effect=error)
    sleep = Mock()
    monkeypatch.setattr(stars.urllib.request, 'urlopen', request)
    monkeypatch.setattr(stars.time, 'sleep', sleep)
    with pytest.raises((urllib.error.HTTPError, stars.GithubNetworkError)):
        stars._github_text_with_headers('https://api.github.com/user/starred', 'secret', 'application/json')
    assert request.call_count == 1
    sleep.assert_not_called()


def test_github_total_count_uses_graphql_without_fetching_repository_nodes(monkeypatch):
    import json
    request = Mock(return_value=response(b'{"data":{"viewer":{"starredRepositories":{"totalCount":12345}}}}'))
    monkeypatch.setattr(stars.urllib.request, "urlopen", request)
    assert stars._github_star_count("secret") == 12345
    sent = request.call_args.args[0]
    assert sent.full_url == "https://api.github.com/graphql" and sent.get_method() == "POST"
    assert "totalCount" in json.loads(sent.data)["query"]
    assert "nodes" not in json.loads(sent.data)["query"]
