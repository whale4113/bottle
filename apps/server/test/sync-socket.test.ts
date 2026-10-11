import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { attachSyncSocket } from '../src/github/sync-socket.js'

test('authenticates sockets, scopes upstream path and forwards push updates', { timeout: 10000 }, async () => {
  const upstream = new WebSocketServer({ port: 0 })
  await once(upstream, 'listening')
  const upstreamPort = (upstream.address() as { port: number }).port
  const server = createServer()
  const sockets = attachSyncSocket(server, async (request) => {
    if (request.headers.cookie !== 'session=valid') throw new Error('Unauthorized')
    return 'authenticated-user'
  }, `http://127.0.0.1:${upstreamPort}`, ['http://localhost:3000'])
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const url = `ws://127.0.0.1:${port}/api/github/stars/sync/ws?user_id=other`
  const clients: WebSocket[] = []
  try {
    for (const headers of [{ origin: 'https://evil.example', cookie: 'session=valid' }, { origin: 'http://localhost:3000' }]) {
      const rejected = new WebSocket(url, { headers })
      clients.push(rejected)
      const [error] = await once(rejected, 'error')
      assert.match(error.message, /Unexpected server response: (401|403)/)
    }
    const connected = once(upstream, 'connection')
    const client = new WebSocket(url, { headers: { origin: 'http://localhost:3000', cookie: 'session=valid' } })
    clients.push(client)
    const opened = once(client, 'open')
    const [source, request] = await connected
    assert.equal(request.url, '/api/github/stars/sync/authenticated-user/ws')
    await opened
    const message = once(client, 'message')
    source.send(JSON.stringify({ type: 'sync.status', data: { status: 'running', message: 'vector 1/3' } }))
    const [data] = await message
    assert.equal(JSON.parse(data.toString()).data.message, 'vector 1/3')
    const disconnected = once(source, 'close')
    client.close()
    await disconnected
  } finally {
    for (const client of clients) client.terminate()
    for (const client of sockets.clients) client.terminate()
    for (const client of upstream.clients) client.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
