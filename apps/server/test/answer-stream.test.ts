import 'reflect-metadata'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { once } from 'node:events'
import { RagController } from '../src/rag/rag.controller.js'

test(
  'proxy forwards chunks immediately, scopes identity and aborts upstream on disconnect',
  { timeout: 10000 },
  async () => {
    const app = express()
    app.use(express.json())
    let identity = ''
    let signal: AbortSignal | undefined
    let writer: ReadableStreamDefaultController<Uint8Array> | undefined
    const controller = new RagController(
      { requireSession: async () => ({ user: { id: 'session-user' } }) } as any,
      {
        answerStream: async (
          userId: string,
          body: unknown,
          abort: AbortSignal,
        ) => {
          identity = userId
          signal = abort
          return new Response(
            new ReadableStream<Uint8Array>({
              start(source) {
                writer = source
                source.enqueue(
                  new TextEncoder().encode('{"type":"delta","text":"first"}\n'),
                )
              },
            }),
          )
        },
      } as any,
    )
    app.post(
      '/api/answer/stream',
      (req, res, next) =>
        void controller.answerStream(req.body, req, res).catch(next),
    )
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const port = (server.address() as { port: number }).port
      const response = await fetch(
        `http://127.0.0.1:${port}/api/answer/stream`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: 'spoofed', query: 'q', sources: [] }),
        },
      )
      assert.equal(identity, 'session-user')
      assert.equal(response.headers.get('x-accel-buffering'), 'no')
      const reader = response.body!.getReader()
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /first/,
      )
      assert.equal(signal?.aborted, false)
      const aborted = once(signal!, 'abort')
      await reader.cancel()
      await aborted
      assert.equal(signal?.aborted, true)
    } finally {
      try {
        writer?.close()
      } catch {}
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)
