import { Module } from '@nestjs/common'

import { SessionService } from './auth/session.service.js'
import { GithubController } from './github/github.controller.js'
import { GithubService } from './github/github.service.js'
import { RagController } from './rag/rag.controller.js'
import { RagService } from './rag/rag.service.js'

@Module({
  controllers: [GithubController, RagController],
  providers: [GithubService, SessionService, RagService],
})
export class AppModule {}
