import json
from unittest.mock import Mock

import pytest

from rag_core import embedding_text as processing
from rag_core.llm import LlmConfig


def test_normalization_removes_noise_but_preserves_code_spacing():
    text = '\ufeffTitle\t  here\r\n\r\n\r\n<!-- comment\nnoise -->Body\u200b\n```python\n    x  =  "a  b"\n<!-- literal -->\n```\n'
    assert processing.normalize_embedding_text(text) == 'Title here\n\nBody\n```python\n    x  =  "a  b"\n<!-- literal -->\n```'
    assert processing.normalize_embedding_text('    x  =  1\n') == '    x  =  1'


def test_llm_summarizes_and_caches_per_configuration(monkeypatch):
    processing._summarize.cache_clear()
    completion = Mock(return_value='Search API. Run tool to search documents.')
    monkeypatch.setattr(processing.llm, 'complete', completion)
    text = '# Tool\nSearch API\nSponsor unrelated products\nUsage: run tool'
    config = LlmConfig(enabled=True, embedding_summary_enabled=True, model='model', base_url='http://localhost:8080/v1')
    expected = 'Search API. Run tool to search documents.'
    assert processing.prepare_embedding_text(text, 'Search Tool', config) == expected
    assert processing.prepare_embedding_text(text, 'Search Tool', config) == expected
    assert completion.call_count == 1
    processing.prepare_embedding_text(text, 'Another topic', config)
    assert completion.call_count == 2
    messages = completion.call_args.args[1]
    assert 'untrusted' in messages[0]['content']


@pytest.mark.parametrize('result', ['', 'https://example.com', '<p></p>', '仅中文摘要'])
def test_invalid_summary_falls_back_to_cleaned_source(monkeypatch, result):
    processing._summarize.cache_clear()
    monkeypatch.setattr(processing.llm, 'complete', Mock(return_value=result))
    config = LlmConfig(enabled=True, embedding_summary_enabled=True, model='model')
    text = 'Title\nSource  fact\nMore facts'
    assert processing.prepare_embedding_text(text, 'topic', config) == 'Title\nSource fact\nMore facts'


def test_disabled_filter_does_not_call_llm_and_errors_can_retry(monkeypatch):
    processing._summarize.cache_clear()
    completion = Mock(side_effect=RuntimeError('offline'))
    monkeypatch.setattr(processing.llm, 'complete', completion)
    text = 'Title\nFact\nExample'
    config = LlmConfig(enabled=True, model='model')
    assert processing.prepare_embedding_text(text, 'topic', config) == text
    completion.assert_not_called()
    config = LlmConfig(enabled=True, embedding_summary_enabled=True, model='model')
    assert processing.prepare_embedding_text(text, 'topic', config) == text
    assert processing.prepare_embedding_text(text, 'topic', config) == text
    assert completion.call_count == 2


def test_repository_embeddings_use_summaries_preserve_source_and_reuse_cache(tmp_path, monkeypatch):
    from rag_core import github_stars as stars
    processing._summarize.cache_clear()
    def complete(config, messages):
        return 'A search engine for documents. Run search to retrieve evidence.'
    monkeypatch.setattr(processing.llm, 'complete', complete)
    generated = []
    monkeypatch.setattr(stars, '_embed_document', lambda text: generated.append(text) or [1., 0.])
    store = stars.GithubStarsStore(tmp_path / 'index.sqlite')
    store.llm_settings.save('alice', LlmConfig(enabled=True, embedding_summary_enabled=True, model='model', base_url='http://localhost:8080/v1'))
    repo = {'id': 1, 'full_name': 'org/search', 'description': 'Search engine'}
    readme = '# Usage\nSearch documents\nSponsor unrelated products\nRun search'
    store._store_chunks('alice', repo, readme)
    assert generated and all('Sponsor' not in text for text in generated)
    with store._connect() as db:
        row = db.execute("select text, embedding_input from github_star_chunks where source_type != 'metadata'").fetchone()
    assert 'Sponsor' in row['text']
    assert 'Sponsor' not in row['embedding_input']
    count = len(generated)
    store._store_chunks('alice', repo, readme)
    assert len(generated) == count
    from dataclasses import replace
    store.llm_settings.save('alice', replace(store.llm_settings.get('alice'), embedding_summary_enabled=False))
    store._store_chunks('alice', repo, readme)
    assert len(generated) > count  # A filtered vector cannot be reused for raw input.


def test_summary_scenario_prompt_cache_and_plain_text_limit(monkeypatch):
    from dataclasses import replace
    processing._summarize.cache_clear()
    completion = Mock(return_value='# Summary\n**Useful** [tool](https://example.com) <b>details</b> ' + 'word ' * 120)
    monkeypatch.setattr(processing.llm, 'complete', completion)
    config = LlmConfig(enabled=True, embedding_summary_enabled=True, model='test',
                       github_summary_prompt='Focus on repository features.', document_summary_prompt='Focus on decisions.')
    result = processing.prepare_embedding_text('Source facts', 'topic', config, scenario='github')
    assert len(result.split()) == 100
    assert not any(marker in result for marker in ['https://', '<b>', '**', '#', '['])
    assert 'Focus on repository features.' in completion.call_args.args[1][0]['content']
    processing.prepare_embedding_text('Source facts', 'topic', config, scenario='document')
    assert 'Focus on decisions.' in completion.call_args.args[1][0]['content']
    assert completion.call_count == 2
    processing.prepare_embedding_text('Source facts', 'topic', replace(config, github_summary_prompt='Focus on deployment.'), scenario='github')
    assert completion.call_count == 3
