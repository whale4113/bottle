import { BadRequestException, Body, Controller, Get, Inject, Post, Req } from '@nestjs/common'
import type { Request } from 'express'

import { SessionService } from '../auth/session.service.js'
import { RagService } from './rag.service.js'

type SearchBody = {
  query?: string
  top_k?: number
}

@Controller('/api')
export class RagController {
  constructor(
    @Inject(SessionService) private readonly sessionService: SessionService,
    @Inject(RagService) private readonly ragService: RagService,
  ) {}

  @Get('/health')
  health() {
    return { status: 'ok' }
  }

  @Get('/documents')
  async documents(@Req() request: Request) {
    await this.requireSession(request)
    return this.ragService.documents()
  }

  @Post('/search')
  async search(@Body() body: SearchBody, @Req() request: Request) {
    await this.requireSession(request)
    const query = String(body.query || '').trim()
    if (!query) {
      throw new BadRequestException('Query is required')
    }
    const topK = Math.max(1, Math.min(Number(body.top_k || 5), 20))
    return this.ragService.search(query, topK)
  }

  private async requireSession(request: Request) {
    return this.sessionService.requireSession(request)
  }
}
