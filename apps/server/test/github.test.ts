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

test('all-repository mode validates exclusions and forwards mode without IDs', async (context) => {
  const { parseImportSelection } =
    await import('../src/github/repository-selection.js')
  assert.deepEqual(
    parseImportSelection({ selectAll: true, excludedRepositoryIds: [7, 7] }),
    { selectAll: true, excludedRepositoryIds: [7] },
  )
  for (const value of [
    { selectAll: true, repositoryIds: [1] },
    { selectAll: true, excludedRepositoryIds: ['7'] },
    { selectAll: 'true' },
  ])
    assert.throws(() => parseImportSelection(value))
  const service = Object.create(GithubService.prototype) as GithubService
  Object.assign(service, {
    ragApiBaseUrl: 'http://rag.test',
    db: { prepare: () => ({ get: () => ({ accessToken: 'secret' }) }) },
  })
  let body: any
  context.mock.method(
    globalThis,
    'fetch',
    async (_url: string, options: RequestInit) => {
      body = JSON.parse(String(options.body))
      return Response.json({ status: 'queued' })
    },
  )
  await service.startSync('owner', {
    selectAll: true,
    excludedRepositoryIds: [7],
  })
  assert.equal(body.user_id, 'owner')
  assert.equal(body.select_all, true)
  assert.deepEqual(body.excluded_repository_ids, [7])
  assert.equal('repository_ids' in body, false)
})

test('HTTP sync status uses the authenticated identity and rejects missing sessions', async (context) => {
  const { GithubController } = await import('../src/github/github.controller.js')
  const service = Object.create(GithubService.prototype) as GithubService
  Object.assign(service, { ragApiBaseUrl: 'http://rag.test' })
  const paths: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    paths.push(url)
    return Response.json({ status: 'running', message: 'Indexing' })
  })
  let authenticated = true
  const sessions = {
    requireSession: async () => {
      if (!authenticated) throw new Error('Unauthorized')
      return { user: { id: 'session/user' } }
    },
  }
  const controller = new GithubController(sessions as any, service)
  const request = { query: { user_id: 'other' } } as any
  assert.deepEqual(await controller.syncStatus(request), { status: 'running', message: 'Indexing' })
  assert.deepEqual(paths, ['http://rag.test/api/github/stars/sync/session%2Fuser'])
  authenticated = false
  await assert.rejects(controller.syncStatus(request), /Unauthorized/)
  assert.equal(paths.length, 1)
})

test('GitHub authorization failures expose a reconnect code without treating rate limits as expired tokens', async (context) => {
  const service = Object.create(GithubService.prototype) as GithubService
  Object.assign(service, {
    ragApiBaseUrl: 'http://rag.test',
    db: { prepare: () => ({ get: () => ({ accessToken: 'token' }) }) },
  })
  let status = 401
  context.mock.method(globalThis, 'fetch', async () =>
    Response.json({ detail: 'GitHub authorization failed' }, { status }),
  )
  await assert.rejects(service.availableStars('owner', 1), (error: any) => {
    assert.equal(error.getStatus(), 401)
    assert.equal(error.getResponse().code, 'GITHUB_REAUTH_REQUIRED')
    return true
  })
  status = 403
  await assert.rejects(service.availableStars('owner', 1), (error: any) => {
    assert.equal(error.getStatus(), 403)
    assert.notEqual(error.getResponse().code, 'GITHUB_REAUTH_REQUIRED')
    return true
  })
  Object.assign(service, { db: { prepare: () => ({ get: () => undefined }) } })
  await assert.rejects(service.availableStars('owner', 1), (error: any) => {
    assert.equal(error.getStatus(), 403)
    assert.equal(error.getResponse().code, 'GITHUB_REAUTH_REQUIRED')
    return true
  })
})
