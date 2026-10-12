from rag_core.models import Chunk
from rag_core.retrieval import fuse_candidates
from rag_core.github_stars import _repository_chunks
from rag_core.service import RagService
from rag_core.embedding_settings import EmbeddingConfig
from rag_core import github_stars as embeddings


def test_identifier_prefers_lexical_and_weak_semantic_is_rejected():
    chunks = [Chunk('a', 'a', 'owner/lib', 'E401 authentication'),
              Chunk('b', 'b', 'other/lib', 'deployment'),
              Chunk('c', 'c', 'unrelated', 'cooking')]
    hits = fuse_candidates('E401', chunks, {'a': 4}, {'a': .4, 'b': .8, 'c': .1}, 5)
    assert hits[0].chunk.chunk_id == 'a'
    assert 'c' not in [hit.chunk.chunk_id for hit in hits]
    assert fuse_candidates('unknown', chunks, {}, {'a': .1}, 5) == []


def test_repository_discovery_diversifies_but_detail_keeps_passages():
    chunks = [Chunk('a', 'url', 'owner/lib', 'search'),
              Chunk('b', 'url', 'owner/lib', 'search setup'),
              Chunk('c', 'other', 'other/lib', 'search')]
    scores = {'a': 3, 'b': 2, 'c': 1}
    assert len(fuse_candidates('search', chunks, scores, {}, 5, diversify=True)) == 2
    assert len(fuse_candidates('search', chunks, scores, {}, 5)) == 3


def test_readme_chunks_keep_section_context_without_volatile_metadata():
    chunks = _repository_chunks({'full_name': 'org/tool', 'stargazers_count': 42},
                                '# Install\npip install tool\n# Usage\nrun tool')
    assert len(chunks) == 3
    assert 'Section: Install' in chunks[1][1]
    assert 'Section: Usage' in chunks[2][1]
    assert 'Stars:' not in chunks[1][1]


def test_document_edit_reuses_unchanged_section_vectors(tmp_path, monkeypatch):
    path = tmp_path / 'guide.md'
    path.write_text('# Install\ninstallation\n# Usage\nusage')
    calls = []
    monkeypatch.setattr(embeddings, '_embed_document', lambda text: calls.append(text) or [1., 0.])
    monkeypatch.setattr(embeddings, "_embed_documents", lambda texts: [embeddings._embed_document(text) for text in texts])
    monkeypatch.setattr(embeddings, '_embed_query', lambda text: [1., 0.])
    service = RagService(tmp_path)
    config = EmbeddingConfig()
    service.ask('installation', embedding_config=config, user_id='a')
    assert len(calls) == 2
    path.write_text('# Install\ninstallation\n# Usage\nchanged usage')
    service.ask('installation', embedding_config=config, user_id='a')
    assert len(calls) == 3
    assert 'Document: guide\nSection: Usage' in calls[-1]


def test_repository_refresh_reuses_vectors_in_same_space(tmp_path, monkeypatch):
    store = embeddings.GithubStarsStore(tmp_path / 'index.sqlite')
    calls = []
    monkeypatch.setattr(embeddings, '_embed_document', lambda text: calls.append(text) or [1., 0.])
    monkeypatch.setattr(embeddings, "_embed_documents", lambda texts: [embeddings._embed_document(text) for text in texts])
    repo = {'id': 1, 'full_name': 'org/tool', 'stargazers_count': 1}
    store._store_chunks('alice', repo, '# Usage\nrun tool')
    assert len(calls) == 2
    store._store_chunks('alice', repo, '# Usage\nrun tool')
    assert len(calls) == 2
    store._store_chunks('alice', {**repo, 'stargazers_count': 2}, '# Usage\nrun tool')
    assert len(calls) == 3  # Only the volatile metadata block changes.
    store._store_chunks('bob', repo, '# Usage\nrun tool')
    assert len(calls) == 5


def test_score_threshold_keeps_boundary_and_rejects_nonfinite_scores(monkeypatch):
    from rag_core.models import SearchHit
    from rag_core.retrieval import filter_search_hits
    monkeypatch.setenv('SEARCH_MIN_SCORE', '0.5')
    chunk = Chunk('a', 'guide.md', 'Guide', 'evidence')
    hits = [SearchHit(chunk, score, 0, 0) for score in [.49999, .5, .8, float('nan'), float('inf')]]
    assert [hit.score for hit in filter_search_hits(hits)] == [.5, .8]
    monkeypatch.setenv('SEARCH_MIN_SCORE', '.9')
    assert filter_search_hits(hits) == []


def test_document_threshold_filters_hits_sources_and_answer(tmp_path, monkeypatch):
    from rag_core.models import SearchHit
    (tmp_path / 'guide.md').write_text('retrieval evidence')
    service = RagService(tmp_path)
    service._ensure_index()
    high = Chunk('high', str(tmp_path / 'guide.md'), 'Guide', 'accepted evidence')
    low = Chunk('low', str(tmp_path / 'guide.md'), 'Guide', 'rejected evidence')
    monkeypatch.setenv('SEARCH_MIN_SCORE', '.5')
    monkeypatch.setattr(service._index, 'search', lambda *args, **kwargs: [SearchHit(high, .5, 1, 1), SearchHit(low, .49, 1, 1)])
    result = service.ask('evidence')
    assert [hit['chunk']['chunk_id'] for hit in result['hits']] == ['high']
    assert [source['chunk_id'] for source in result['sources']] == ['high']
    assert 'rejected evidence' not in result['answer']
    monkeypatch.setenv('SEARCH_MIN_SCORE', '.6')
    result = service.ask('evidence')
    assert result['hits'] == result['sources'] == []
    assert 'accepted evidence' not in result['answer']


def test_github_threshold_filters_every_hit_and_empty_answer(tmp_path, monkeypatch):
    from rag_core.models import SearchHit
    store = embeddings.GithubStarsStore(tmp_path / 'index.sqlite')
    monkeypatch.setattr(embeddings, '_embed_document', lambda text: [1., 0.])
    monkeypatch.setattr(store, '_vector_scores', lambda *args: {})
    store._store_repository('alice', {'id': 1, 'full_name': 'org/tool'}, '# Usage\nevidence')
    store._store_chunks('alice', {'id': 1, 'full_name': 'org/tool'}, '# Usage\nevidence')
    def candidates(query, chunks, *args, **kwargs):
        return [SearchHit(chunks[0], .5, 1, 1), SearchHit(chunks[1], .49, 1, 1)]
    monkeypatch.setattr(embeddings, 'fuse_candidates', candidates)
    monkeypatch.setenv('SEARCH_MIN_SCORE', '.5')
    result = store.search('alice', 'evidence')
    assert len(result['hits']) == len(result['sources']) == len(result['stars']) == 1
    assert result['hits'][0]['score'] == .5
    monkeypatch.setenv('SEARCH_MIN_SCORE', '.6')
    result = store.search('alice', 'evidence')
    assert result['hits'] == result['sources'] == result['stars'] == []
    assert '没有' in result['answer']


def test_query_embedding_is_shared_between_concurrent_searches(monkeypatch):
    import concurrent.futures
    import threading
    import time
    from collections import OrderedDict
    from rag_core.embedding_settings import use_config
    calls = []
    barrier = threading.Barrier(2)
    def embed(text, input_type):
        calls.append((text, input_type))
        time.sleep(.02)
        return [1., 0.]
    monkeypatch.setattr(embeddings, '_QUERY_EMBEDDING_CACHE', OrderedDict())
    monkeypatch.setattr(embeddings, '_embed', embed)
    def query(_):
        with use_config(EmbeddingConfig(model='cache-test')):
            barrier.wait(timeout=2)
            return embeddings._embed_query('same query')
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(query, range(2))) == [[1., 0.], [1., 0.]]
    assert calls == [('same query', 'query')]
    with use_config(EmbeddingConfig(model='another-model')):
        embeddings._embed_query('same query')
    assert len(calls) == 2


def test_local_document_vectors_are_generated_in_one_batch(tmp_path, monkeypatch):
    (tmp_path / 'guide.md').write_text('# Install\ninstallation\n# Usage\nusage')
    batches = []
    def batch(texts):
        batches.append(texts)
        return [[1., 0.] for _ in texts]
    monkeypatch.setattr(embeddings, '_embed_documents', batch)
    monkeypatch.setattr(embeddings, '_embed_query', lambda text: [1., 0.])
    service = RagService(tmp_path)
    service.ask('installation', embedding_config=EmbeddingConfig(), user_id='alice')
    assert len(batches) == 1 and len(batches[0]) == 2
    service.ask('usage', embedding_config=EmbeddingConfig(), user_id='alice')
    assert len(batches) == 1


def test_different_query_embeddings_do_not_serialize_remote_requests(monkeypatch):
    import concurrent.futures
    import threading
    from collections import OrderedDict
    from rag_core.embedding_settings import use_config
    barrier = threading.Barrier(2)
    def embed(text, input_type):
        barrier.wait(timeout=2)
        return [1., 0.]
    monkeypatch.setattr(embeddings, '_QUERY_EMBEDDING_CACHE', OrderedDict())
    monkeypatch.setattr(embeddings, '_embed', embed)
    def query(text):
        with use_config(EmbeddingConfig(provider='openai', model='remote')):
            return embeddings._embed_query(text)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(query, ['first', 'second'])) == [[1., 0.], [1., 0.]]


def test_chinese_query_retains_cross_language_semantic_match(monkeypatch):
    from rag_core.retrieval import filter_search_hits
    monkeypatch.setenv('SEARCH_MIN_SCORE', '.5')
    chunks = [Chunk('whistle', 'whistle', 'avwo/whistle-client', '网络请求调试'),
              Chunk('requestly', 'requestly', 'requestly/requestly', 'Design and test APIs and HTTP requests')]
    hits = fuse_candidates('请求', chunks, {'whistle': 3.6592}, {'whistle': .2928, 'requestly': .5104}, 10)
    kept = filter_search_hits(hits)
    assert {hit.chunk.chunk_id for hit in kept} == {'whistle', 'requestly'}
    requestly = next(hit for hit in kept if hit.chunk.chunk_id == 'requestly')
    assert .5 <= requestly.score <= .6


def test_semantic_rank_cannot_promote_weak_evidence_past_threshold(monkeypatch):
    from rag_core.retrieval import filter_search_hits
    monkeypatch.setenv('SEARCH_MIN_SCORE', '.5')
    chunks = [Chunk('a', 'a', 'unrelated', 'English source')]
    for query in ['请求', 'request', '寻找请求调试工具']:
        assert filter_search_hits(fuse_candidates(query, chunks, {}, {'a': .3}, 10)) == []
        assert len(filter_search_hits(fuse_candidates(query, chunks, {}, {'a': .51}, 10))) == 1


def test_script_query_uses_calibrated_semantic_scores(monkeypatch):
    from rag_core.retrieval import filter_search_hits
    monkeypatch.setenv('SEARCH_MIN_SCORE', '.5')
    chunks = [Chunk('raycast', 'raycast', 'raycast/script-commands', 'Run custom scripts'),
              Chunk('requestly', 'requestly', 'requestly/requestly', 'Test HTTP APIs')]
    hits = filter_search_hits(fuse_candidates('脚本', chunks, {},
                              {'raycast': .4897, 'requestly': .3502}, 10))
    assert [hit.chunk.chunk_id for hit in hits] == ['raycast']
    assert .52 < hits[0].score < .53


def test_vector_evidence_outweighs_incidental_keyword_match():
    chunks = [Chunk('semantic', 's', 'scripts', 'Automate workflows'),
              Chunk('keyword', 'k', 'other', '脚本')]
    hits = fuse_candidates('脚本', chunks, {'keyword': 4},
                           {'semantic': .65, 'keyword': .1}, 10)
    assert hits[0].chunk.chunk_id == 'semantic'
