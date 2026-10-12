import 'reflect-metadata'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { fetchRagApi, readRagJson } from '../src/common/rag-api.js'

const disconnected = () => new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } })

test('retries a disconnected GET and returns a fresh response', async (context) => {
  let attempts = 0
  context.mock.method(globalThis, 'fetch', async () => {
    if (++attempts === 1) throw disconnected()
    return Response.json({ status: 'running' })
  })
  assert.deepEqual(await readRagJson(await fetchRagApi('http://rag.test/status')), { status: 'running' })
  assert.equal(attempts, 2)
})

test('persistent connection errors return 503 and POST requests are never replayed', async (context) => {
  let attempts = 0
  context.mock.method(globalThis, 'fetch', async () => {
    attempts++
    throw disconnected()
  })
  await assert.rejects(fetchRagApi('http://rag.test/status'), (error: any) => error.getStatus() === 503)
  assert.equal(attempts, 2)
  attempts = 0
  await assert.rejects(fetchRagApi('http://rag.test/sync', { method: 'POST' }), (error: any) => error.getStatus() === 503)
  assert.equal(attempts, 1)
})

test('timeouts terminate stalled upstream requests', async (context) => {
  const oldTimeout = process.env.RAG_API_TIMEOUT_MS
  process.env.RAG_API_TIMEOUT_MS = '20'
  context.after(() => {
    if (oldTimeout === undefined) delete process.env.RAG_API_TIMEOUT_MS
    else process.env.RAG_API_TIMEOUT_MS = oldTimeout
  })
  const server = createServer(() => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const { port } = server.address() as { port: number }
    await assert.rejects(fetchRagApi(`http://127.0.0.1:${port}`), (error: any) => error.getStatus() === 503)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('caller cancellation is preserved without retrying', async (context) => {
  const controller = new AbortController()
  controller.abort()
  let attempts = 0
  context.mock.method(globalThis, 'fetch', async () => {
    attempts++
    throw controller.signal.reason
  })
  await assert.rejects(fetchRagApi('http://rag.test', { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(attempts, 1)
})

test('broken successful response bodies return 502; upstream error status remains available', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(disconnected()) } }))
  await assert.rejects(readRagJson(response), (error: any) => error.getStatus() === 502)
  assert.deepEqual(await readRagJson(new Response('Unavailable', { status: 503 })), {})
})
