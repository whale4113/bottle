import type { AllRepositorySelection } from './repository-selection.js'
import {
  BadGatewayException,
  ForbiddenException,
  HttpException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import Database from 'better-sqlite3'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type AccountRow = {
  userId: string
  accessToken: string | null
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const databasePath = join(currentDir, '..', '..', 'data', 'auth.sqlite')

@Injectable()
export class GithubService implements OnModuleInit, OnModuleDestroy {
  private readonly db = new Database(databasePath)
  private readonly ragApiBaseUrl =
    process.env.RAG_API_BASE_URL || 'http://127.0.0.1:8787'
  private syncTimer: ReturnType<typeof setInterval> | undefined

  async searchStars(
    userId: string,
    query: string,
    limit: number,
  ): Promise<unknown> {
    return this.request('/api/github/stars/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        query,
        top_k: limit,
      }),
    })
  }

  async startSync(
    userId: string,
    selection: number[] | AllRepositorySelection,
  ): Promise<unknown> {
    const accessToken = this.getGithubAccessToken(userId)
    return this.startSyncWithToken(
      userId,
      accessToken,
      Array.isArray(selection) ? selection : undefined,
      Array.isArray(selection) ? undefined : selection,
    )
  }

  async availableStars(userId: string, page: number): Promise<unknown> {
    return this.request('/api/github/stars/available', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        access_token: this.getGithubAccessToken(userId),
        page,
        max_pages: this.maxPages(),
      }),
    })
  }

  async syncStatus(userId: string): Promise<unknown> {
    return this.request(`/api/github/stars/sync/${encodeURIComponent(userId)}`)
  }

  async listSyncedStars(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<unknown> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    })
    return this.request(
      `/api/github/stars/${encodeURIComponent(userId)}?${params.toString()}`,
    )
  }

  async cancelSync(userId: string): Promise<unknown> {
    return this.request(
      `/api/github/stars/sync/${encodeURIComponent(userId)}/cancel`,
      {
        method: 'POST',
      },
    )
  }

  async resetSync(userId: string): Promise<unknown> {
    return this.request(
      `/api/github/stars/sync/${encodeURIComponent(userId)}/reset`,
      {
        method: 'POST',
      },
    )
  }

  async resetRepository(userId: string, repoId: number): Promise<unknown> {
    return this.request(
      `/api/github/stars/${encodeURIComponent(userId)}/repositories/${repoId}/reset`,
      {
        method: 'POST',
      },
    )
  }

  onModuleInit(): void {
    const intervalMs = Number(
      process.env.GITHUB_STARS_SYNC_INTERVAL_MS || 6 * 60 * 60 * 1000,
    )
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return
    }
    this.syncTimer = setInterval(() => {
      this.syncAllGithubAccounts().catch((error) => {
        console.error('Scheduled GitHub Stars sync failed', error)
      })
    }, intervalMs)
  }

  onModuleDestroy(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
    }
  }

  private getGithubAccessToken(userId: string): string {
    const account = this.db
      .prepare(
        `
          select userId, accessToken
          from account
          where userId = ? and providerId = 'github'
          order by updatedAt desc
          limit 1
        `,
      )
      .get(userId) as AccountRow | undefined

    if (!account?.accessToken) {
      throw new ForbiddenException('当前账号未关联 GitHub 登录')
    }

    return account.accessToken
  }

  private maxPages(): number {
    const value = Number(process.env.GITHUB_STARS_MAX_PAGES || 50)
    return Number.isSafeInteger(value) && value >= 1 && value <= 200
      ? value
      : 50
  }

  private async startSyncWithToken(
    userId: string,
    accessToken: string,
    repositoryIds?: number[],
    allSelection?: AllRepositorySelection,
  ): Promise<unknown> {
    return this.request('/api/github/stars/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        access_token: accessToken,
        max_pages: this.maxPages(),
        repository_ids: repositoryIds,
        ...(allSelection
          ? {
              select_all: true,
              excluded_repository_ids: allSelection.excludedRepositoryIds,
            }
          : {}),
      }),
    })
  }

  private async syncAllGithubAccounts(): Promise<void> {
    const accounts = this.db
      .prepare(
        `
          select userId, accessToken
          from account
          where providerId = 'github' and accessToken is not null
        `,
      )
      .all() as AccountRow[]

    for (const account of accounts) {
      if (account.accessToken) {
        await this.startSyncWithToken(account.userId, account.accessToken)
      }
    }
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.ragApiBaseUrl}${path}`, init)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      if ([400, 401, 403, 404, 409, 422, 429].includes(response.status)) {
        throw new HttpException(
          payload.detail || payload.error || 'GitHub Stars 请求失败',
          response.status,
        )
      }
      throw new BadGatewayException(
        payload.detail ||
          payload.error ||
          'GitHub Stars service request failed',
      )
    }
    return payload
  }
}
