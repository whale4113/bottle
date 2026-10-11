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
    repo = {'id': 1, 'full_name': 'org/tool', 'stargazers_count': 1}
    store._store_chunks('alice', repo, '# Usage\nrun tool')
    assert len(calls) == 2
    store._store_chunks('alice', repo, '# Usage\nrun tool')
    assert len(calls) == 2
    store._store_chunks('alice', {**repo, 'stargazers_count': 2}, '# Usage\nrun tool')
    assert len(calls) == 3  # Only the volatile metadata block changes.
    store._store_chunks('bob', repo, '# Usage\nrun tool')
    assert len(calls) == 5
