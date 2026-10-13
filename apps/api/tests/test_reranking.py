import json
from unittest.mock import Mock

import pytest

from rag_core import llm, reranking
from rag_core.models import Chunk, SearchHit
from rag_core.retrieval import filter_search_hits


@pytest.fixture(autouse=True)
def clear_cache():
    reranking._relevance.cache_clear()


def config(**kwargs):
    return llm.LlmConfig(search_mode=kwargs.pop('search_mode', 'quality'), model='test', base_url='http://localhost:8080/v1', **kwargs)


def candidates():
    return [SearchHit(Chunk('requestly', 'r', 'Requestly', 'Test APIs and run scripts.'), .503, 0, .435),
            SearchHit(Chunk('figma', 'f', 'FigmaToCode', 'Generate React code from Figma.'), .569, 0, .528)]


def response():
    return json.dumps({'results': [
        {'id': 1, 'score': .95, 'evidence': 'Generate React code from Figma.'},
        {'id': 0, 'score': .1, 'evidence': ''},
    ]})


def test_intent_reranking_filters_false_positive_and_caches(monkeypatch):
    completion = Mock(return_value=response())
    monkeypatch.setattr(llm, 'complete', completion)
    for _ in range(2):
        hits = reranking.rerank_candidates('代码生成', candidates(), config(enabled=False))
        assert [hit.chunk.chunk_id for hit in filter_search_hits(hits)] == ['figma']
        assert hits[0].bm25_score == 0 and hits[0].vector_score == .528
    assert completion.call_count == 1
    assert completion.call_args.args[0].timeout == 5
    reranking.rerank_candidates('脚本', candidates(), config())
    assert completion.call_count == 2


@pytest.mark.parametrize('result', [
    'not JSON', '{}', '{"results":[]}',
    '{"results":[{"id":0,"score":0.9,"evidence":"invented"},{"id":1,"score":0.1}]}',
    '{"results":[{"id":0,"score":0.1},{"id":0,"score":0.1}]}',
    '{"results":[{"id":0,"score":true},{"id":1,"score":0.1}]}',
    '{"results":[{"id":0,"score":NaN},{"id":1,"score":0.1}]}',
])
def test_invalid_results_fall_back_without_poisoning_cache(monkeypatch, result):
    completion = Mock(side_effect=[result, response()])
    monkeypatch.setattr(llm, 'complete', completion)
    hits = candidates()
    assert reranking.rerank_candidates('代码生成', hits, config()) == hits
    assert reranking.rerank_candidates('代码生成', hits, config())[0].chunk.chunk_id == 'figma'
    assert completion.call_count == 2


def test_disabled_unconfigured_and_empty_do_not_call_model(monkeypatch):
    completion = Mock()
    monkeypatch.setattr(llm, 'complete', completion)
    hits = candidates()
    for setting in [None, llm.LlmConfig(), config(rerank_enabled=False)]:
        assert reranking.rerank_candidates('query', hits, setting) == hits
    assert reranking.rerank_candidates('query', [], config()) == []
    completion.assert_not_called()


def test_timeout_falls_back_and_inputs_are_bounded(monkeypatch):
    completion = Mock(side_effect=RuntimeError('timeout'))
    monkeypatch.setattr(llm, 'complete', completion)
    hits = candidates() * 30
    assert reranking.rerank_candidates('query', hits, config(), {'figma': 'x' * 10000}) == hits
    payload = json.loads(completion.call_args.args[1][1]['content'])
    assert len(payload['candidates']) == 20
    assert max(len(item['text']) for item in payload['candidates']) < 3010


def test_github_search_applies_reranking_before_sources(tmp_path, monkeypatch):
    from rag_core import github_stars as stars
    store = stars.GithubStarsStore(tmp_path / 'index.sqlite')
    store.llm_settings.save('alice', config(enabled=False))
    monkeypatch.setattr(stars, '_embed_documents', lambda texts: [[1., 0.] for _ in texts])
    monkeypatch.setattr(stars, '_embed_document', lambda text: [1., 0.])
    for i, name in enumerate(['Requestly', 'FigmaToCode'], 1):
        repo = {'id': i, 'full_name': name}
        store._store_repository('alice', repo, candidates()[i - 1].chunk.text)
        store._store_chunks('alice', repo, candidates()[i - 1].chunk.text)
    monkeypatch.setattr(store, '_vector_scores', lambda query, rows: {row['chunk_id']: .6 for row in rows})
    def complete(settings, messages):
        payload = json.loads(messages[1]['content'])
        return json.dumps({'results': [
            {'id': item['id'], 'score': .95 if item['title'] == 'FigmaToCode' else .1,
             'evidence': item['text'] if item['title'] == 'FigmaToCode' else ''}
            for item in payload['candidates']
        ]})
    monkeypatch.setattr(llm, 'complete', complete)
    result = store.search('alice', '代码生成', top_k=1)
    assert len(result['hits']) == len(result['stars']) == len(result['sources']) == 1
    assert result['hits'][0]['chunk']['section'] == 'FigmaToCode'


def test_local_search_reranks_before_building_sources(tmp_path, monkeypatch):
    from rag_core.service import RagService
    (tmp_path / 'guide.md').write_text('Indexed source')
    service = RagService(tmp_path)
    monkeypatch.setattr(service, '_semantic_search', lambda *args: candidates())
    monkeypatch.setattr(llm, 'complete', Mock(return_value=response()))
    from rag_core.embedding_settings import EmbeddingConfig
    result = service.ask('代码生成', top_k=1, user_id='alice',
                         embedding_config=EmbeddingConfig(), llm_config=config(enabled=False))
    assert [hit['chunk']['chunk_id'] for hit in result['hits']] == ['figma']
    assert len(result['sources']) == 1


def test_reranking_settings_are_account_scoped(tmp_path):
    store = llm.LlmSettingsStore(tmp_path / 'settings.sqlite')
    store.save('alice', config(rerank_enabled=False))
    assert store.get('alice').public()['rerank_enabled'] is False
    assert store.get('bob').public()['rerank_enabled'] is True
    assert store.candidate('alice', {'answer_enabled': False}).rerank_enabled is False
    assert store.candidate('alice', {'rerank_enabled': True}).rerank_enabled is True


def test_fast_mode_skips_llm(monkeypatch):
    completion = Mock()
    monkeypatch.setattr(llm, 'complete', completion)
    hits = candidates()
    assert reranking.rerank_candidates('query', hits, config(search_mode='fast')) == hits
    assert reranking.candidate_limit(5, config(search_mode='fast')) == 5
    completion.assert_not_called()


def test_balanced_limits_model_work_and_falls_back(monkeypatch):
    completion = Mock(side_effect=RuntimeError('timeout'))
    monkeypatch.setattr(llm, 'complete', completion)
    hits = candidates() * 10
    assert reranking.rerank_candidates('query', hits, config(search_mode='balanced')) == hits
    assert completion.call_args.args[0].timeout == 1
    assert len(json.loads(completion.call_args.args[1][1]['content'])['candidates']) == 8
    assert reranking.candidate_limit(5, config(search_mode='balanced')) == 8


def test_search_mode_is_persisted_and_validated(tmp_path):
    store = llm.LlmSettingsStore(tmp_path / 'settings.sqlite')
    store.save('alice', store.candidate('alice', {'search_mode': 'fast'}))
    assert store.get('alice').search_mode == 'fast'
    assert store.get('bob').search_mode == 'balanced'
    with pytest.raises(ValueError):
        store.candidate('alice', {'search_mode': 'unknown'})


def test_successful_balanced_rerank_preserves_tail(monkeypatch):
    def complete(settings, messages):
        items = json.loads(messages[1]['content'])['candidates']
        return json.dumps({'results': [
            {'id': item['id'], 'score': .8, 'evidence': item['text']}
            for item in items
        ]})
    monkeypatch.setattr(llm, 'complete', complete)
    hits = candidates() * 10
    ranked = reranking.rerank_candidates('query', hits, config(search_mode='balanced'))
    assert len(ranked) == len(hits)
    assert ranked[8:] == hits[8:]
