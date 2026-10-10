import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { authClient } from '../lib/auth-client'

type DocumentItem = {
  path: string
  title: string
  chunk_count: number
}

type SourceItem = {
  chunk_id: string
  source: string
  section: string
  score: number
}

type SearchHit = {
  chunk: {
    chunk_id: string
    source: string
    section: string
    text: string
  }
  score: number
  bm25_score: number
  vector_score: number
}

type SearchResult = {
  answer: string
  sources: SourceItem[]
  hits: SearchHit[]
  document_count: number
  chunk_count: number
}

type AuthUser = {
  id: string
  email: string
  name?: string
  image?: string | null
}

type GithubStar = {
  id: number | string
  name: string
  fullName: string
  description: string | null
  htmlUrl: string
  language: string | null
  stargazersCount: number
  updatedAt: string
  topics: string[]
  owner: {
    login: string
    avatarUrl: string
  }
}

type SyncedGithubStar = GithubStar & {
  repoId: number
  syncedAt: number
  readmeLength: number
  chunkCount: number
}

type GithubStarsRagResult = {
  answer: string
  sources: Array<{
    repository: string
    url: string
    score: number
    bm25_score: number
    vector_score: number
  }>
  hits: Array<{
    chunk: {
      chunk_id: string
      source: string
      section: string
      text: string
    }
    score: number
    bm25_score: number
    vector_score: number
    evidence: string
  }>
  stars: GithubStar[]
  repository_count: number
  filtered_repository_count: number
  chunk_count: number
  embedding_provider?: string
  embedding_model?: string
  pipeline: Array<{
    step: string
    description: string
  }>
}

type GithubSyncStatus = {
  status: 'idle' | 'queued' | 'downloading_model' | 'running' | 'completed' | 'failed' | 'canceled'
  total: number
  processed: number
  indexed: number
  progress: number
  message: string
  repository_count: number
  chunk_count: number
  embedding_provider?: string
  embedding_model?: string
  error?: string | null
}

type GithubStarsIndexResult = {
  stars: SyncedGithubStar[]
  total: number
  limit: number
  offset: number
  embedding_provider?: string
  embedding_model?: string
}

const EXAMPLE_QUERIES = [
  '为什么生产级 RAG 需要混合搜索？',
  '重排序 RAG 解决什么问题？',
  '什么时候需要 SQL + Vector RAG？',
]
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const { data: session, isPending: sessionPending, refetch: refetchSession } = authClient.useSession()
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [documents, setDocuments] = useState<DocumentItem[]>([])
  const [query, setQuery] = useState('')
  const [topK, setTopK] = useState(5)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [status, setStatus] = useState<'connecting' | 'ok' | 'loading' | 'error'>('connecting')
  const [error, setError] = useState('')
  const [githubQuery, setGithubQuery] = useState('')
  const [githubResult, setGithubResult] = useState<GithubStarsRagResult | null>(null)
  const [githubStatus, setGithubStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [githubError, setGithubError] = useState('')
  const [githubSync, setGithubSync] = useState<GithubSyncStatus | null>(null)
  const [githubIndex, setGithubIndex] = useState<GithubStarsIndexResult | null>(null)

  const chunkCount = documents.reduce((sum, doc) => sum + Number(doc.chunk_count || 0), 0)
  const user = session?.user as AuthUser | undefined

  async function loadSession() {
    if (sessionPending) {
      return
    }
    if (user) {
      await loadDocuments(false)
      await loadGithubSyncStatus()
      return
    }
    setStatus('ok')
  }

  async function submitAuth() {
    setStatus('loading')
    setError('')
    try {
      const result =
        authMode === 'login'
          ? await authClient.signIn.email({ email, password, rememberMe: true })
          : await authClient.signUp.email({ name: email.split('@')[0] || email, email, password })
      if (result.error) {
        throw new Error(result.error.message || '认证失败')
      }
      setPassword('')
      await refetchSession()
      await loadDocuments(false)
    } catch (requestError) {
      setStatus('error')
      setError(getErrorMessage(requestError))
    }
  }

  async function logout() {
    await authClient.signOut()
    await refetchSession()
    setDocuments([])
    setResult(null)
    setGithubResult(null)
    setGithubSync(null)
    setGithubIndex(null)
    setStatus('ok')
  }

  async function loginWithGithub() {
    setError('')
    try {
      const result = await authClient.signIn.social({
        provider: 'github',
        callbackURL: window.location.origin,
      })
      if (result.error) {
        throw new Error(result.error.message || 'GitHub 登录失败')
      }
    } catch (requestError) {
      setStatus('error')
      setError(getErrorMessage(requestError))
    }
  }

  async function loadDocuments(requireUser = true) {
    if (requireUser && !user) {
      return
    }
    setStatus('connecting')
    setError('')
    try {
      const payload = await fetchJson<{ documents: DocumentItem[] }>('/api/documents')
      setDocuments(payload.documents || [])
      setStatus('ok')
    } catch (requestError) {
      setStatus('error')
      setError(getErrorMessage(requestError))
    }
  }

  async function submitSearch(nextQuery = query) {
    const normalizedQuery = nextQuery.trim()
    if (!normalizedQuery) {
      return
    }
    if (!user) {
      setError('请先登录后再检索知识库')
      return
    }

    setQuery(normalizedQuery)
    setStatus('loading')
    setError('')

    try {
      const payload = await fetchJson<SearchResult>('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: normalizedQuery, top_k: topK }),
      })
      setResult(payload)
      setStatus('ok')
    } catch (requestError) {
      setResult(null)
      setStatus('error')
      setError(getErrorMessage(requestError))
    }
  }

  async function searchGithubStars() {
    if (!user) {
      setGithubError('请先登录后再搜索 GitHub Stars')
      return
    }
    if (!githubQuery.trim()) {
      setGithubError('请输入要检索的 GitHub Stars 问题或关键词')
      return
    }

    setGithubStatus('loading')
    setGithubError('')

    try {
      const params = new URLSearchParams({
        query: githubQuery.trim(),
        limit: '20',
      })
      const payload = await fetchJson<GithubStarsRagResult>(`/api/github/stars?${params.toString()}`)
      setGithubResult(payload)
      setGithubStatus('idle')
    } catch (requestError) {
      setGithubResult(null)
      setGithubStatus('error')
      setGithubError(getErrorMessage(requestError))
    }
  }

  async function loadGithubSyncStatus() {
    if (!user) {
      return
    }
    try {
      const payload = await fetchJson<GithubSyncStatus>('/api/github/stars/sync')
      setGithubSync(payload)
      if (payload.repository_count > 0) {
        await loadGithubIndex()
      } else {
        setGithubIndex(null)
      }
    } catch {
      setGithubSync(null)
    }
  }

  async function loadGithubIndex() {
    if (!user) {
      return
    }
    try {
      const params = new URLSearchParams({
        limit: '50',
        offset: '0',
      })
      const payload = await fetchJson<GithubStarsIndexResult>(`/api/github/stars/index?${params.toString()}`)
      setGithubIndex(payload)
    } catch (requestError) {
      setGithubError(getErrorMessage(requestError))
      setGithubIndex(null)
    }
  }

  async function startGithubSync() {
    setGithubError('')
    try {
      const payload = await fetchJson<GithubSyncStatus>('/api/github/stars/sync', { method: 'POST' })
      setGithubSync(payload)
    } catch (requestError) {
      setGithubError(getErrorMessage(requestError))
    }
  }

  async function resetGithubSync() {
    if (!window.confirm('确认重置 GitHub Stars 同步数据？已入库的仓库和向量分块会被删除。')) {
      return
    }
    setGithubError('')
    try {
      const payload = await fetchJson<GithubSyncStatus>('/api/github/stars/sync/reset', { method: 'POST' })
      setGithubSync(payload)
      setGithubIndex(null)
      setGithubResult(null)
    } catch (requestError) {
      setGithubError(getErrorMessage(requestError))
    }
  }

  async function resetGithubRepository(repoId: number) {
    if (!window.confirm('确认重置这条 GitHub Star 数据？该仓库的原始数据和向量分块会被删除。')) {
      return
    }
    setGithubError('')
    try {
      const payload = await fetchJson<{ sync: GithubSyncStatus }>(
        `/api/github/stars/repositories/${repoId}/reset`,
        { method: 'POST' },
      )
      setGithubSync(payload.sync)
      setGithubResult(null)
      await loadGithubIndex()
    } catch (requestError) {
      setGithubError(getErrorMessage(requestError))
    }
  }

  async function cancelGithubSync() {
    setGithubError('')
    try {
      const payload = await fetchJson<GithubSyncStatus>('/api/github/stars/sync/cancel', { method: 'POST' })
      setGithubSync(payload)
    } catch (requestError) {
      setGithubError(getErrorMessage(requestError))
    }
  }

  useEffect(() => {
    loadSession()
  }, [sessionPending, user?.id])

  useEffect(() => {
    if (!user || !githubSync || !isGithubSyncActive(githubSync.status)) {
      return undefined
    }
    const timer = window.setInterval(() => {
      loadGithubSyncStatus()
    }, 1500)
    return () => window.clearInterval(timer)
  }, [user?.id, githubSync?.status])

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            <h1>RAG Console</h1>
            <p>本地混合检索知识库</p>
          </div>
        </div>

        <img
          className="knowledge-visual"
          src="https://copilot-cn.bytedance.net/api/ide/v1/text_to_image?prompt=realistic%20desktop%20workspace%20showing%20markdown%20documents%20connected%20to%20a%20clean%20knowledge%20graph%20on%20a%20monitor%2C%20professional%20software%20engineering%20environment%2C%20natural%20lighting%2C%20sharp%20details%2C%20no%20text%20in%20image&image_size=landscape_4_3"
          alt="Knowledge graph workspace"
        />

        <section className="panel">
          <div className="panel-header">
            <h2>账户</h2>
          </div>
          {user ? (
            <div className="account-card">
              {user.image ? <img className="avatar" src={user.image} alt="" /> : null}
              <div>
                <div className="document-title">{user.name || user.email}</div>
                <div className="document-path">{user.email}</div>
              </div>
              <button className="secondary-button" type="button" onClick={logout}>
                退出
              </button>
            </div>
          ) : (
            <div className="auth-form">
              <div className="segmented">
                <button
                  type="button"
                  className={authMode === 'login' ? 'active' : ''}
                  onClick={() => setAuthMode('login')}
                >
                  登录
                </button>
                <button
                  type="button"
                  className={authMode === 'register' ? 'active' : ''}
                  onClick={() => setAuthMode('register')}
                >
                  注册
                </button>
              </div>
              <label htmlFor="emailInput">邮箱</label>
              <input
                id="emailInput"
                type="email"
                value={email}
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
              />
              <label htmlFor="passwordInput">密码</label>
              <input
                id="passwordInput"
                type="password"
                value={password}
                autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button className="primary-button full-width" type="button" onClick={submitAuth}>
                {authMode === 'login' ? '邮箱登录' : '邮箱注册'}
              </button>
              <button className="secondary-button full-width" type="button" onClick={loginWithGithub}>
                GitHub 登录
              </button>
              {error ? <div className="error-message compact">{error}</div> : null}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>知识库</h2>
            <button className="icon-button" type="button" title="刷新知识库" disabled={!user} onClick={() => loadDocuments()}>
              ↻
            </button>
          </div>
          <dl className="stats">
            <div>
              <dt>文档</dt>
              <dd>{documents.length}</dd>
            </div>
            <div>
              <dt>分块</dt>
              <dd>{chunkCount}</dd>
            </div>
          </dl>
          <div className="document-list">
            {documents.length > 0 ? (
              documents.map((doc) => (
                <article className="document-item" key={doc.path}>
                  <div className="document-title">{doc.title}</div>
                  <div className="document-path">
                    {doc.path} · {doc.chunk_count} 个分块
                  </div>
                </article>
              ))
            ) : (
              <div className={error ? 'error-message' : 'empty-state'}>
                {error || 'materials 目录暂无可索引 Markdown 文档'}
              </div>
            )}
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">Hybrid Search</p>
            <h2>面向 Markdown 知识库的本地问答</h2>
          </div>
          <div className={`status-pill ${statusClassName(status)}`}>{statusLabel(status)}</div>
        </header>

        <section className="query-panel">
          <label htmlFor="queryInput">问题</label>
          <textarea
            id="queryInput"
            rows={4}
            placeholder="例如：为什么生产级 RAG 需要混合搜索？"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                submitSearch()
              }
            }}
          />
          <div className="query-actions">
            <div className="topk-control">
              <label htmlFor="topKInput">返回片段</label>
              <input
                id="topKInput"
                type="number"
                min={1}
                max={20}
                value={topK}
                onChange={(event) => setTopK(Number(event.target.value || 5))}
              />
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={status === 'loading'}
              onClick={() => submitSearch()}
            >
              <span>⌕</span>
              <span>{status === 'loading' ? '检索中' : '检索'}</span>
            </button>
          </div>
          <div className="examples" aria-label="示例问题">
            {EXAMPLE_QUERIES.map((example) => (
              <button type="button" key={example} onClick={() => submitSearch(example)}>
                {example}
              </button>
            ))}
          </div>
        </section>

        {user ? (
          <section className="github-panel">
            <div className="section-title">
              <h3>GitHub Stars RAG</h3>
              <span>同步入库后检索本地索引</span>
            </div>
            <div className="github-sync-card">
              <div>
                <div className="document-title">Stars 索引</div>
                <div className="document-path">
                  {githubSync
                    ? [
                        syncStatusLabel(githubSync.status),
                        `${githubSync.repository_count} 个仓库`,
                        `${githubSync.chunk_count} 个分块`,
                        formatEmbeddingSummary(githubSync),
                      ].filter(Boolean).join(' · ')
                    : '尚未读取同步状态'}
                </div>
              </div>
              <div className="github-sync-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={isGithubSyncActive(githubSync?.status)}
                  onClick={startGithubSync}
                >
                  同步 Stars
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!isGithubSyncActive(githubSync?.status)}
                  onClick={cancelGithubSync}
                >
                  取消
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={isGithubSyncActive(githubSync?.status)}
                  onClick={loadGithubIndex}
                >
                  查看数据
                </button>
                <button
                  className="danger-button"
                  type="button"
                  onClick={resetGithubSync}
                >
                  重置同步
                </button>
              </div>
              {githubSync ? (
                <>
                  <div className="sync-progress" aria-label="GitHub Stars 同步进度">
                    <div style={{ width: `${githubSync.progress}%` }} />
                  </div>
                  <div className="document-path">
                    {formatGithubSyncProgress(githubSync)}
                    {githubSync.error ? ` · ${githubSync.error}` : ''}
                  </div>
                </>
              ) : null}
            </div>
            {githubIndex?.stars.length ? (
              <div className="github-index-panel">
                <div className="section-title">
                  <h3>已同步数据</h3>
                  <span>
                    {githubIndex.total} 个仓库 · {formatEmbeddingSummary(githubIndex)}
                  </span>
                </div>
                <div className="github-stars-list compact-list">
                  {githubIndex.stars.map((star) => (
                    <article className="github-star-item" key={star.repoId}>
                      <div className="github-star-header with-action">
                        {star.owner.avatarUrl ? <img className="github-owner-avatar" src={star.owner.avatarUrl} alt="" /> : null}
                        <div>
                          <a className="github-star-title" href={star.htmlUrl} target="_blank" rel="noreferrer">
                            {star.fullName}
                          </a>
                          <div className="document-path">
                            {formatSyncedGithubMeta(star)}
                          </div>
                        </div>
                        <button
                          className="danger-button compact-button"
                          type="button"
                          onClick={() => resetGithubRepository(star.repoId)}
                        >
                          重置
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="github-search">
              <input
                type="search"
                placeholder="搜索本地 Stars 索引，支持 language:python topic:rag owner:xxx"
                value={githubQuery}
                onChange={(event) => setGithubQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    searchGithubStars()
                  }
                }}
              />
              <button
                className="secondary-button"
                type="button"
                disabled={githubStatus === 'loading'}
                onClick={searchGithubStars}
              >
                {githubStatus === 'loading' ? '检索中' : '检索 Stars 索引'}
              </button>
            </div>
            {githubError ? <div className="error-message compact">{githubError}</div> : null}
            {githubResult ? (
              <div className="github-rag-answer">
                <div className="document-path">
                  {[
                    `候选仓库 ${githubResult.filtered_repository_count} / ${githubResult.repository_count}`,
                    `分块 ${githubResult.chunk_count}`,
                    formatEmbeddingSummary(githubResult),
                  ].filter(Boolean).join(' · ')}
                </div>
                {githubResult.answer
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => (
                    <div className="answer-line" key={line}>
                      {line}
                    </div>
                  ))}
              </div>
            ) : null}
            {githubResult?.stars.length ? (
              <div className="github-stars-list">
                {githubResult.stars.map((star, index) => {
                  const source = githubResult.sources[index]
                  return (
                  <article className="github-star-item" key={star.id}>
                    <div className="github-star-header">
                      {star.owner.avatarUrl ? <img className="github-owner-avatar" src={star.owner.avatarUrl} alt="" /> : null}
                      <div>
                        <a className="github-star-title" href={star.htmlUrl} target="_blank" rel="noreferrer">
                          {star.fullName}
                        </a>
                        <div className="document-path">
                          {formatGithubMeta(star)} · {formatScore(source?.score || 0)}
                        </div>
                      </div>
                    </div>
                    {star.description ? <p className="github-star-description">{star.description}</p> : null}
                    {star.topics.length > 0 ? (
                      <div className="github-topics">
                        {star.topics.slice(0, 6).map((topic) => (
                          <span key={topic}>{topic}</span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                  )
                })}
              </div>
            ) : null}
          </section>
        ) : null}

        {error && !result && user ? <div className="error-message">{error}</div> : null}

        {result ? (
          <>
            <section className="result-panel">
              <div className="section-title">
                <h3>答案草稿</h3>
                <span>
                  {result.document_count} 个文档 · {result.chunk_count} 个分块
                </span>
              </div>
              <div className="answer-output">
                {result.answer
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => (
                    <div className="answer-line" key={line}>
                      {line}
                    </div>
                  ))}
              </div>
            </section>

            {result.sources.length > 0 ? (
              <section className="sources-panel">
                <div className="section-title">
                  <h3>引用来源</h3>
                </div>
                <div className="sources-list">
                  {result.sources.map((source) => (
                    <article className="source-item" key={source.chunk_id}>
                      <div className="source-meta">
                        <div className="source-title">{source.section || source.chunk_id}</div>
                        <span className="score">{formatScore(source.score)}</span>
                      </div>
                      <div className="document-path">{source.source}</div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {result.hits.length > 0 ? (
              <section className="hits-panel">
                <div className="section-title">
                  <h3>检索明细</h3>
                </div>
                <div className="hits-list">
                  {result.hits.map((hit, index) => (
                    <article className="hit-item" key={hit.chunk.chunk_id}>
                      <div className="hit-meta">
                        <div className="hit-title">
                          #{index + 1} {hit.chunk.section}
                        </div>
                        <span className="score">{formatScore(hit.score)}</span>
                      </div>
                      <p className="hit-text">{hit.chunk.text}</p>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  )
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    credentials: 'include',
    ...options,
  })
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || '请求失败')
  }
  return payload
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败'
}

function statusClassName(status: 'connecting' | 'ok' | 'loading' | 'error') {
  if (status === 'ok') {
    return 'ok'
  }
  if (status === 'error') {
    return 'error'
  }
  return ''
}

function statusLabel(status: 'connecting' | 'ok' | 'loading' | 'error') {
  const labels = {
    connecting: '连接中',
    ok: '已连接',
    loading: '检索中',
    error: '异常',
  }
  return labels[status]
}

function formatScore(score: number) {
  return `score ${score.toFixed(3)}`
}

function formatGithubMeta(star: GithubStar) {
  const updatedAt = star.updatedAt ? new Date(star.updatedAt) : null
  const updatedLabel = updatedAt && !Number.isNaN(updatedAt.getTime())
    ? `updated ${updatedAt.toLocaleDateString()}`
    : ''
  const parts = [
    star.language,
    `★ ${star.stargazersCount.toLocaleString()}`,
    updatedLabel,
  ].filter(Boolean)

  return parts.join(' · ')
}

function formatSyncedGithubMeta(star: SyncedGithubStar) {
  const syncedAt = star.syncedAt ? new Date(star.syncedAt * 1000) : null
  const syncedLabel = syncedAt && !Number.isNaN(syncedAt.getTime())
    ? `synced ${syncedAt.toLocaleString()}`
    : ''
  const parts = [
    formatGithubMeta(star),
    `${star.chunkCount} 个分块`,
    star.readmeLength > 0 ? `README ${star.readmeLength.toLocaleString()} 字符` : '',
    syncedLabel,
  ].filter(Boolean)

  return parts.join(' · ')
}

function formatEmbeddingSummary(payload: { embedding_provider?: string; embedding_model?: string }) {
  const parts = [payload.embedding_provider, payload.embedding_model].filter(Boolean)
  return parts.length > 0 ? parts.join(' / ') : ''
}

function isGithubSyncActive(status: GithubSyncStatus['status'] | undefined) {
  return status === 'queued' || status === 'downloading_model' || status === 'running'
}

function formatGithubSyncProgress(sync: GithubSyncStatus) {
  if (sync.status === 'canceled') {
    return `${sync.message} · 已索引 ${sync.indexed}`
  }
  const indexingProgress = sync.total > 0
    ? `${sync.processed}/${sync.total}`
    : sync.processed > 0
      ? `已拉取 ${sync.processed} 个`
      : '等待仓库列表'
  return `${sync.message} · ${indexingProgress} · 已索引 ${sync.indexed}`
}

function syncStatusLabel(status: GithubSyncStatus['status']) {
  const labels = {
    idle: '未同步',
    queued: '排队中',
    downloading_model: '下载模型中',
    running: '同步中',
    completed: '已同步',
    failed: '同步失败',
    canceled: '已取消',
  }
  return labels[status]
}
