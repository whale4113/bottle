from unittest.mock import Mock

from rag_core import github_stars as stars
from rag_core import embedding_text
from rag_core.llm import LlmConfig
from rag_core.embedding_settings import EmbeddingConfig
from rag_core.service import RagService


def test_repository_summarizes_full_readme_once_before_chunking_and_scopes_inspection(tmp_path, monkeypatch):
    embedding_text._summarize.cache_clear()
    source = '# Usage\n' + 'Search documents and return evidence.\n' * 100
    completion = Mock(return_value='A document search engine returning evidence.')
    monkeypatch.setattr(embedding_text.llm, 'complete', completion)
    monkeypatch.setattr(stars, '_embed_document', lambda text: [1., 0.])
    store = stars.GithubStarsStore(tmp_path / 'index.sqlite')
    store.llm_settings.save('alice', LlmConfig(enabled=True, embedding_summary_enabled=True, model='test', base_url='http://localhost:8000/v1'))
    assert store._store_chunks('alice', {'id': 1, 'full_name': 'org/search'}, source) == 1
    assert completion.call_count == 1
    assert 'Search documents' in completion.call_args.args[1][1]['content']
    details = store.embedding_details('alice', 1)
    assert details['total'] == 1
    assert details['chunks'][0]['source_text'] == source
    assert details['chunks'][0]['embedding_input'] == 'A document search engine returning evidence.'
    assert details['chunks'][0]['vector'] == [1., 0.]
    assert details['chunks'][0]['dimensions'] == 2
    assert store.embedding_details('bob', 1)['chunks'] == []
    assert store.embedding_details('alice', 1, offset=1)['chunks'] == []


def test_local_document_summarizes_before_chunking_and_inspects_user_cache(tmp_path, monkeypatch):
    embedding_text._summarize.cache_clear()
    original = '# First\n' + 'Search documents.\n' * 100 + '# Second\nReturn evidence.'
    (tmp_path / 'guide.md').write_text(original)
    complete = Mock(return_value='Search documents and return evidence.')
    monkeypatch.setattr(embedding_text.llm, 'complete', complete)
    batches = []
    monkeypatch.setattr(stars, '_embed_documents', lambda texts: batches.append(texts) or [[1., 0.] for _ in texts])
    monkeypatch.setattr(stars, '_embed_query', lambda text: [1., 0.])
    service = RagService(tmp_path)
    config = LlmConfig(enabled=True, embedding_summary_enabled=True, model='test', base_url='http://localhost:8000/v1')
    service.ask('search', embedding_config=EmbeddingConfig(), user_id='alice', llm_config=config)
    assert complete.call_count == 1
    assert len(batches[0]) == 1
    source = service.documents()[0]['path']
    detail = service.embedding_details('alice', source)
    assert detail['total'] == 1
    assert detail['chunks'][0]['source_text'] == original
    assert detail['chunks'][0]['embedding_input'] == 'Search documents and return evidence.'
    assert service.embedding_details('bob', source)['chunks'] == []


def test_long_summary_splits_only_after_one_completion(tmp_path, monkeypatch):
    embedding_text._summarize.cache_clear()
    complete = Mock(return_value='extraordinarytechnicalcapability ' * 90)
    monkeypatch.setattr(embedding_text.llm, 'complete', complete)
    monkeypatch.setattr(stars, '_embed_document', lambda text: [1., 0.])
    store = stars.GithubStarsStore(tmp_path / 'index.sqlite')
    store.llm_settings.save('alice', LlmConfig(enabled=True, embedding_summary_enabled=True, model='test', base_url='http://localhost:8000/v1'))
    count = store._store_chunks('alice', {'id': 1, 'full_name': 'org/search'}, '# Usage\nReadme facts')
    assert count > 1
    assert complete.call_count == 1
    assert all(len(chunk['embedding_input']) <= 1200 for chunk in store.embedding_details('alice', 1)['chunks'])
