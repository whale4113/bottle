import 'reflect-metadata'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RagService } from '../src/rag/rag.service.js'

test('embedding requests use authenticated identity and only supported fields', async (context) => {
  const requests: { url: string; body?: Record<string, unknown> }[] = []
  context.mock.method(
    globalThis,
    'fetch',
    async (url: string, options?: RequestInit) => {
      requests.push({
        url,
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
      })
      return Response.json({ status: 'ok' })
    },
  )
  const service = new RagService()
  await service.configureEmbedding('session-user', {
    user_id: 'other',
    provider: 'local',
    model: 'model',
    unexpected: 'ignored',
  })
  await service.configureEmbedding(
    'session-user',
    { provider: 'local', model: 'test' },
    true,
  )
  await service.embeddingSettings('session/user')
  await service.search('question', 5, 'session-user')
  assert.deepEqual(requests[0].body, {
    user_id: 'session-user',
    provider: 'local',
    model: 'model',
  })
  assert.ok(requests[1].url.endsWith('/api/settings/embedding/test'))
  assert.ok(requests[2].url.endsWith('/session%2Fuser'))
  assert.equal(requests[3].body?.user_id, 'session-user')
})

test('configuration preserves actionable upstream conflict errors', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    Response.json({ detail: 'Wait for import to finish.' }, { status: 409 }),
  )
  await assert.rejects(
    new RagService().configureEmbedding('user', {}),
    (error: any) => {
      assert.equal(error.getStatus(), 409)
      assert.equal(error.message, 'Wait for import to finish.')
      return true
    },
  )
})

test('LLM settings and answers cannot override the authenticated account', async (context) => {
  const requests: { url: string; body?: Record<string, unknown> }[] = []
  context.mock.method(
    globalThis,
    'fetch',
    async (url: string, options?: RequestInit) => {
      requests.push({
        url,
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
      })
      return Response.json({ status: 'ok' })
    },
  )
  const service = new RagService()
  await service.configureLlm(
    'session-user',
    { user_id: 'other', enabled: true, model: 'chat', unexpected: true },
    true,
  )
  await service.llmSettings('session/user')
  await service.answer('session-user', {
    user_id: 'other',
    query: 'question',
    sources: [],
  })
  assert.deepEqual(requests[0].body, {
    user_id: 'session-user',
    enabled: true,
    model: 'chat',
  })
  assert.ok(requests[0].url.endsWith('/api/settings/llm/test'))
  assert.ok(requests[1].url.endsWith('/session%2Fuser'))
  assert.equal(requests[2].body?.user_id, 'session-user')
})

test('scenario summary prompts are forwarded with the authenticated identity', async (context) => {
  let body: Record<string, unknown> = {}
  context.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    body = JSON.parse(String(options?.body))
    return Response.json({ enabled: true })
  })
  await new RagService().configureLlm('session-owner', {
    user_id: 'other', enabled: true, model: 'chat',
    embedding_summary_enabled: true,
    github_summary_prompt: 'Focus on repository features.',
    document_summary_prompt: 'Focus on technical decisions.',
  })
  assert.equal(body.user_id, 'session-owner')
  assert.equal(body.embedding_summary_enabled, true)
  assert.equal(body.github_summary_prompt, 'Focus on repository features.')
  assert.equal(body.document_summary_prompt, 'Focus on technical decisions.')
})

test('embedding inspection proxies scope identity and encode local source paths', async (context) => {
  const { GithubService } = await import('../src/github/github.service.js')
  const requests: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    requests.push(url)
    return Response.json({ chunks: [], total: 0 })
  })
  const github = Object.create(GithubService.prototype) as GithubService
  Object.assign(github, { ragApiBaseUrl: 'http://rag.test' })
  await github.embeddings('session/user', 7, 20)
  const rag = new RagService()
  await rag.embeddings('session/user', 'materials/a & b.md', 0)
  assert.ok(requests[0].endsWith('/session%2Fuser/repositories/7/embeddings?offset=20'))
  assert.ok(requests[1].includes('/session%2Fuser?source=materials%2Fa+%26+b.md&offset=0'))
})
