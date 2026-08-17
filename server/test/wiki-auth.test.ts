// wiki 认证单链测试（codex PR#346 P2）：生产下 orchestrator 与 wiki 同时挂载在 /api/v1/containers，
// 各自 router.use(requireAuth) —— wiki 请求会先过 containers router 的认证、落到 wiki router 再认证一次
// （每次 authenticate() 都验 JWT + 查用户表）。回归：wiki 请求全程只触发一次 authenticate（一次 findUnique）。
// 装配对齐 containers.test.ts：先建临时 app 拿 prisma，再装 orchestrator + wiki 重建 app（同一 DB）。
// #621：wiki 经 serviceFor 注入内存 fake（本用例到达存储层，缺省 Docker 适配器会隐依赖真 daemon）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { makeFleetTest } from './fleetTestUtils'
import { FakeWikiFileSystem } from './fakes'
import { WikiService } from '../src/wiki/service'
import * as authModule from '../src/auth/authenticate'

describe('wiki 认证单链（生产 orchestrator + wiki 同挂；codex PR#346 P2）', () => {
  let ctx: TestContext
  let name: string

  beforeAll(async () => {
    // 内存 fake 存储（原 fixture 一页 a.md）；homeDir 不再被 wiki 使用，给占位值。
    const fs = new FakeWikiFileSystem({ 'concepts/a.md': '# A\n' })
    const serviceFor = () => new WikiService(fs)
    ctx = await setupTestApp({ wiki: { compile: { trigger: () => {} }, serviceFor } })
    const fl = makeFleetTest(ctx.prisma)
    const { createApp } = await import('../src/app')
    const supertest = (await import('supertest')).default
    const app = createApp({
      prisma: ctx.prisma,
      orchestrator: fl.orch,
      runtime: fl.runtime,
      wiki: { compile: { trigger: () => {} }, serviceFor },
    })
    ctx.request = supertest(app) as unknown as TestContext['request']

    const u = await seedUser(ctx.prisma, 'usingle', 'pw-usingle-secure')
    name = 'asingle'
    await ctx.prisma.container.create({
      data: { name, port: 19999, ownerId: u.id, token: 't', homeDir: '/unused', image: 'img', status: 'running' },
    })
  })

  afterAll(async () => {
    await ctx.cleanup()
  })

  it('wiki 请求全程只触发一次 authenticate（不双重查用户表）', async () => {
    const l = await login(ctx.request, 'usingle', 'pw-usingle-secure')
    const spy = vi.spyOn(authModule, 'authenticate')
    spy.mockClear()
    const res = await ctx.request.get(`/api/v1/containers/${name}/wiki/tree`).set(bearer(l.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.groups).toBeDefined()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
