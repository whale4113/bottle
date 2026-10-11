import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import type { Request } from 'express'

import { SessionService } from '../auth/session.service.js'
import { GithubService } from './github.service.js'
import { parseImportSelection, parseStarsPage } from './repository-selection.js'

@Controller('/api/github')
export class GithubController {
  constructor(
    @Inject(SessionService) private readonly sessionService: SessionService,
    @Inject(GithubService) private readonly githubService: GithubService,
  ) {}

  @Get('/stars')
  async searchStars(
    @Query('query') query: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: Request,
  ) {
    const session = await this.sessionService.requireSession(request)
    const resultLimit = Math.max(1, Math.min(Number(limit || 20), 50))
    return this.githubService.searchStars(
      session.user.id,
      String(query || ''),
      resultLimit,
    )
  }

  @Post('/stars/sync')
  async startSync(@Body() body: unknown, @Req() request: Request) {
    const session = await this.sessionService.requireSession(request)
    return this.githubService.startSync(
      session.user.id,
      parseImportSelection(body),
    )
  }

  @Get('/stars/available')
  async availableStars(
    @Query('page') page: string | undefined,
    @Req() request: Request,
  ) {
    const session = await this.sessionService.requireSession(request)
    return this.githubService.availableStars(
      session.user.id,
      parseStarsPage(page),
    )
  }

  @Get('/stars/sync')
  async syncStatus(@Req() request: Request) {
    const session = await this.sessionService.requireSession(request)
    return this.githubService.syncStatus(session.user.id)
  }

  @Post('/stars/sync/cancel')
  async cancelSync(@Req() request: Request) {
    const session = await this.sessionService.requireSession(request)
    return this.githubService.cancelSync(session.user.id)
  }

  @Post('/stars/sync/reset')
  async resetSync(@Req() request: Request) {
    const session = await this.sessionService.requireSession(request)
    return this.githubService.resetSync(session.user.id)
  }

  @Get('/stars/index')
  async listSyncedStars(
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Req() request: Request,
  ) {
    const session = await this.sessionService.requireSession(request)
    const resultLimit = Math.max(1, Math.min(Number(limit || 50), 100))
    const resultOffset = Math.max(0, Number(offset || 0))
    return this.githubService.listSyncedStars(
      session.user.id,
      resultLimit,
      resultOffset,
    )
  }

  @Post('/stars/repositories/:repoId/reset')
  async resetRepository(
    @Param('repoId') repoId: string,
    @Req() request: Request,
  ) {
    const session = await this.sessionService.requireSession(request)
    const normalizedRepoId = Number(repoId)
    if (!Number.isSafeInteger(normalizedRepoId) || normalizedRepoId <= 0) {
      throw new BadRequestException('Invalid repository id')
    }
    return this.githubService.resetRepository(session.user.id, normalizedRepoId)
  }
}
