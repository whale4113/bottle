import 'reflect-metadata'
import './env.js'

import { NestFactory } from '@nestjs/core'
import { toNodeHandler } from 'better-auth/node'
import { json } from 'express'
import type { Request } from 'express'

import { AppModule } from './app.module.js'
import { auth } from './auth/auth.js'
import { SessionService } from './auth/session.service.js'
import { attachSyncSocket } from './github/sync-socket.js'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false })
  const expressApp = app.getHttpAdapter().getInstance()

  expressApp.all('/api/auth/*splat', toNodeHandler(auth))
  expressApp.use('/api/answer', json({ limit: '512kb' }))
  expressApp.use(json())

  const sessions = app.get(SessionService)
  attachSyncSocket(app.getHttpServer(), async (request) => {
    const session = await sessions.requireSession(request as Request)
    return session.user.id
  })

  const port = Number(process.env.PORT || 4000)
  await app.listen(port, '127.0.0.1')
  console.log(`NestJS app running at http://127.0.0.1:${port}`)
}

bootstrap()
