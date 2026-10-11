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
