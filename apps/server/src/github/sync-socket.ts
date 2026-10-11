import type { IncomingMessage, Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

const path = '/api/github/stars/sync/ws'

function devLog(event: string) {
  if (process.env.NODE_ENV === 'development') {
    console.debug(`[github-stars] websocket.${event}`)
  }
}

export function attachSyncSocket(
  server: Server,
  authenticate: (request: IncomingMessage) => Promise<string>,
  apiBaseUrl = process.env.RAG_API_BASE_URL || 'http://127.0.0.1:8787',
  origins = (process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:3000').split(',').map((origin) => origin.trim()),
) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 })
  server.on('upgrade', (request, socket, head) => {
    if (request.url?.split('?')[0] !== path) {
      socket.destroy()
      return
    }
    // Browser cookies authenticate the connection; never accept a client user ID.
    if (!request.headers.origin || !origins.includes(request.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    socket.on('error', () => socket.destroy())
    void authenticate(request).then((userId) => {
      if (socket.destroyed) return
      sockets.handleUpgrade(request, socket, head, (client) => {
        sockets.emit('connection', client, request)
        const url = new URL(apiBaseUrl)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.pathname = `/api/github/stars/sync/${encodeURIComponent(userId)}/ws`
        url.search = ''
        const upstream = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 1024 * 1024 })
        devLog('connected')
        let alive = true
        client.on('pong', () => { alive = true })
        const heartbeat = setInterval(() => {
          if (!alive) { client.terminate(); return }
          alive = false
          client.ping()
        }, 30000)
        heartbeat.unref()
        upstream.on('message', (data) => {
          if (client.readyState === WebSocket.OPEN) client.send(data.toString())
        })
        upstream.on('error', () => {
          devLog('upstream-error')
          client.close(1011, 'Sync service unavailable')
        })
        upstream.on('close', () => client.close(1012, 'Sync service disconnected'))
        client.on('error', () => client.terminate())
        client.on('close', () => {
          clearInterval(heartbeat)
          upstream.terminate()
          devLog('disconnected')
        })
      })
    }).catch(() => {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    })
  })
  server.on('close', () => {
    for (const client of sockets.clients) client.terminate()
    sockets.close()
  })
  return sockets
}
