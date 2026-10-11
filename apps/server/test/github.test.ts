import 'reflect-metadata'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GithubService } from '../src/github/github.service.js'
import {
  parseRepositorySelection,
  parseStarsPage,
} from '../src/github/repository-selection.js'

test('manual sync rejects missing, empty and invalid IDs and deduplicates selection', () => {
  for (const body of [
    undefined,
    {},
    { repositoryIds: [] },
    { repositoryIds: [0] },
    { repositoryIds: ['1'] },
    { repositoryIds: [true] },
    { repositoryIds: [1.2] },
  ]) {
    assert.throws(() => parseRepositorySelection(body), /选择一个有效仓库/)
  }
  assert.deepEqual(
    parseRepositorySelection({
      repositoryIds: [2, 2, 7],
      userId: 'spoofed-user',
    }),
    [2, 7],
  )
})

test('available repositories validate page boundaries', () => {
  for (const page of ['0', '-1', 'abc', '1.5', '201']) {
    assert.throws(() => parseStarsPage(page), /页码无效/)
  }
  assert.equal(parseStarsPage(undefined), 1)
  assert.equal(parseStarsPage('200'), 200)
})

test('service forwards selected IDs and scheduled sync omits IDs to reuse saved preferences', async (context) => {
  const service = Object.create(GithubService.prototype) as GithubService
  const lookedUpUsers: unknown[] = []
  Object.assign(service, {
    ragApiBaseUrl: 'http://rag.test',
    db: {
      prepare: () => ({
        get: (user: unknown) => {
          lookedUpUsers.push(user)
          return { accessToken: 'server-only-token' }
        },
      }),
    },
  })
  const requests: { path: string; body: Record<string, unknown> }[] = []
  context.mock.method(
    globalThis,
    'fetch',
    async (url: string, options: RequestInit) => {
      requests.push({ path: url, body: JSON.parse(String(options.body)) })
      return Response.json({ status: 'queued' })
    },
  )
  await service.startSync('user', [1, 5])
  await service.availableStars('user', 2)
  const scheduled = service as unknown as {
    startSyncWithToken: (user: string, token: string) => Promise<unknown>
  }
  await scheduled.startSyncWithToken('user', 'server-only-token')
  assert.deepEqual(lookedUpUsers, ['user', 'user'])
  assert.deepEqual(requests[0].body.repository_ids, [1, 5])
  assert.equal(requests[1].body.page, 2)
  assert.equal(requests[1].body.access_token, 'server-only-token')
  assert.equal('repository_ids' in requests[2].body, false)
})
