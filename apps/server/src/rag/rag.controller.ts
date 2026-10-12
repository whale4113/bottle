import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Query,
  Res,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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

  @Get('/documents/embeddings')
  async embeddings(@Query('source') source: string, @Query('offset') offset: string | undefined, @Req() request: Request) {
    const session = await this.requireSession(request)
    const start = Number(offset || 0)
    if (!source || !Number.isSafeInteger(start) || start < 0) throw new BadRequestException('Invalid embedding page')
    return this.ragService.embeddings(session.user.id, source, start)
  }

  @Post('/search')
  async search(@Body() body: SearchBody, @Req() request: Request) {
    const session = await this.requireSession(request)
    const query = String(body.query || '').trim()
    if (!query) {
      throw new BadRequestException('Query is required')
    }
    const topK = Math.max(1, Math.min(Number(body.top_k || 5), 20))
    return this.ragService.search(query, topK, session.user.id)
  }

  @Get('/settings/embedding')
  async embeddingSettings(@Req() request: Request) {
    const session = await this.requireSession(request)
    return this.ragService.embeddingSettings(session.user.id)
  }

  @Post('/settings/embedding')
  async saveEmbeddingSettings(@Body() body: unknown, @Req() request: Request) {
    const session = await this.requireSession(request)
    return this.ragService.configureEmbedding(session.user.id, body)
  }

  @Post('/settings/embedding/test')
  async testEmbeddingSettings(@Body() body: unknown, @Req() request: Request) {
    const session = await this.requireSession(request)
    return this.ragService.configureEmbedding(session.user.id, body, true)
  }

  @Get('/settings/llm')
  async llmSettings(@Req() request: Request) {
    const session = await this.requireSession(request)
    return this.ragService.llmSettings(session.user.id)
  }

  @Post('/settings/llm')
  async saveLlmSettings(@Body() body: unknown, @Req() request: Request) {
    const session = await this.requireSession(request)
    return this.ragService.configureLlm(session.user.id, body)
  }

  @Post('/settings/llm/test')
  async testLlmSettings(@Body() body: unknown, @Req() request: Request) {
    const session = await this.requireSession(request)
    return this.ragService.configureLlm(session.user.id, body, true)
  }

  @Post('/answer')
  async answer(@Body() body: unknown, @Req() request: Request) {
    const session = await this.requireSession(request)
    return this.ragService.answer(session.user.id, body)
  }

  @Post('/answer/stream')
  async answerStream(
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const session = await this.requireSession(request)
    const controller = new AbortController()
    const disconnect = () => controller.abort()
    response.on('close', disconnect)
    try {
      const upstream = await this.ragService.answerStream(
        session.user.id,
        body,
        controller.signal,
      )
      response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      response.setHeader('Cache-Control', 'no-cache, no-transform')
      response.setHeader('X-Accel-Buffering', 'no')
      response.flushHeaders()
      await pipeline(
        Readable.fromWeb(
          upstream.body as import('node:stream/web').ReadableStream,
        ),
        response,
      )
    } catch (error) {
      if (!controller.signal.aborted && !response.headersSent) throw error
      if (!response.destroyed) response.destroy()
    } finally {
      response.off('close', disconnect)
      controller.abort()
    }
  }

  private async requireSession(request: Request) {
    return this.sessionService.requireSession(request)
  }
}
