// T01 —— Authenticated Figure creation（docs/autofigure/tickets/T01-authenticated-figure-creation.md）
// T02 —— Idempotent figure creation（docs/autofigure/tickets/T02-idempotent-figure-creation.md）
// 接缝：REST 信封接缝（setupTestApp + seedUser + login + bearer）+ 事务 seam（createFigureWithJobInTx
// fake tx）+ 幂等 seam（createOrReplayFigure fake deps 确定性分支，含并发竞态）+ 重启持久化
//（同 DB 文件两个 app 实例）。
// flag 开 = setupTestApp({ figures: {} }) 注入 figures deps；flag 关 = 不注入（路由未装配 → 90005）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest, { type SuperTest, type Test } from 'supertest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { createApp } from '../src/app'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import {
  createFigureWithJobInTx,
  createOrReplayFigure,
  type CreateFigureInput,
  type FigureCreateTx,
  type IdempotencyDeps,
} from '../src/figures/service'

// 重启持久化（AC7）测试自建 app 实例时直读 init.sql（对齐 setup.ts 做法）。
const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')

describe('T01 POST /figures（flag 开，REST 信封接缝）', () => {
  let ctx: TestContext
  let access: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} }) // flag 开 = figures deps 已装配
    await seedUser(ctx.prisma, 'figuser', 'pw-figuser-secure')
    const lg = await login(ctx.request, 'figuser', 'pw-figuser-secure')
    access = lg.access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC3+AC8：合法 prompt → HTTP 200 + #312 信封 code 0，data={figureId, jobId, status:"queued"}', async () => {
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', 't01-ac3-key')
      .send({ prompt: 'A bar chart of monthly revenue' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      code: 0,
      message: expect.any(String),
      data: { figureId: expect.any(String), jobId: expect.any(String), status: 'queued' },
    })
  })

  it('AC4：数据库恰好 1 Figure + 1 Job；status=queued / errorMessage=null / ownerId=认证用户', async () => {
    const before = await ctx.prisma.figure.count()
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', 't01-ac4-key')
      .send({ prompt: 'flowchart of CI pipeline' })
    expect(res.body.code).toBe(0)

    const figureCount = await ctx.prisma.figure.count()
    const jobCount = await ctx.prisma.generationJob.count()
    expect(figureCount).toBe(before + 1)
    expect(jobCount).toBe(figureCount) // 1:1 —— 恰好一个 Job 对应一个 Figure

    const figure = await ctx.prisma.figure.findFirst({
      where: { id: res.body.data.figureId },
    })
    expect(figure).not.toBeNull()
    const me = await ctx.prisma.user.findUnique({ where: { username: 'figuser' } })
    expect(figure!.ownerId).toBe(me!.id) // ownerId 只来自认证身份
    const job = await ctx.prisma.generationJob.findUnique({ where: { figureId: figure!.id } })
    expect(job).not.toBeNull()
    expect(job!.status).toBe('queued')
    expect(job!.errorMessage).toBeNull()
    expect(job!.figureId).toBe(figure!.id)
  })

  it('AC7：客户端随请求提交 userId 被忽略，ownerId 只来自认证身份', async () => {
    const me = await ctx.prisma.user.findUnique({ where: { username: 'figuser' } })
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', 't01-ac7-key')
      .send({ prompt: 'venn diagram of skills', userId: 'someone-elses-id' })
    expect(res.body.code).toBe(0)
    const figure = await ctx.prisma.figure.findUnique({ where: { id: res.body.data.figureId } })
    expect(figure!.ownerId).toBe(me!.id)
    expect(figure!.ownerId).not.toBe('someone-elses-id')
  })

  it('AC5：空 prompt → 90002（body fieldErrors）+ 零行落库', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const beforeJ = await ctx.prisma.generationJob.count()
    // 必带合法 key：key 中间件在 body 校验之前，缺头会让此用例被 key-90002 拦下而空过 body 校验。
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', 't01-ac5-empty-key')
      .send({ prompt: '' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('prompt') // fieldErrors → 证明确实走了 body 校验（区别于 key-90002 data null）
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
    expect(await ctx.prisma.generationJob.count()).toBe(beforeJ)
  })

  it('AC5：纯空白 prompt（trim 后空）→ 90002 + 零行落库', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', 't01-ac5-space-key')
      .send({ prompt: '   ' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('prompt')
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
  })

  it('AC5：超长 prompt（>4000）→ 90002 + 零行落库', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', 't01-ac5-long-key')
      .send({ prompt: 'x'.repeat(4001) })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('prompt')
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
  })

  it('AC5：类型错 prompt（非字符串）→ 90002 + 零行落库', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', 't01-ac5-type-key')
      .send({ prompt: 123 })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toHaveProperty('prompt')
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
  })
})

// AC6 两个互补用例各自隔离到独立 setupTestApp（独立 ctx/prisma）。
// 二次审查 blocking：`vi.spyOn(ctx.prisma, '$transaction').mockRejectedValueOnce(...)` 后
// `mockRestore()` 在此 Prisma client 上无法恢复（$transaction 变 undefined）——若与真回滚用例
// 共享 client，后者会进不了真事务而空洞通过。故：mock 用例独占一个 client（其污染被隔离在
// 本 describe 内），真回滚用例用全新 client（本生命周期内 $transaction 从未被 mock）。

describe('T01 AC6：事务层失败信封（mock $transaction，隔离 client）', () => {
  let ctx: TestContext
  let access: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    await seedUser(ctx.prisma, 'figmocktx', 'pw-mocktx-secure')
    const lg = await login(ctx.request, 'figmocktx', 'pw-mocktx-secure')
    access = lg.access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC6：事务层中断 → 失败信封（90000），零行落库', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const beforeJ = await ctx.prisma.generationJob.count()
    // 本 describe 独占 client：即便 spy 使该 client 的 $transaction 失效（mockRestore 无法
    // 恢复），污染也只停留在此 describe，不影响任何其他测试。
    const spy = vi.spyOn(ctx.prisma, '$transaction').mockRejectedValueOnce(new Error('simulated tx failure'))
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', 't01-mocktx-key')
      .send({ prompt: 'sequence diagram of login' })
    spy.mockRestore()
    expect(res.body.code).not.toBe(0) // 失败信封（90000 兜底）
    expect(res.body.data).toBeNull()
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
    expect(await ctx.prisma.generationJob.count()).toBe(beforeJ)
  })
})

describe('T01 AC6：真事务回滚（隔离 client，$transaction 从未 mock）', () => {
  let ctx: TestContext
  let access: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    await seedUser(ctx.prisma, 'figrollback', 'pw-rollback-secure')
    const lg = await login(ctx.request, 'figrollback', 'pw-rollback-secure')
    access = lg.access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC6：真事务内 Job 写失败（job 表中止触发器）→ 失败信封 + 真实回滚无孤儿', async () => {
    // 前置置信断言：本 describe 的 prisma.$transaction 在其生命周期从未被 mock，须可真实调用。
    //（若未来有人在共享 client 上重加 mock 污染此处，此断言立即失败——防空洞通过回潮。）
    expect(typeof ctx.prisma.$transaction).toBe('function')
    const preflight = await ctx.prisma.$transaction(async (tx) => tx.figure.count())
    expect(preflight).toBeGreaterThanOrEqual(0)

    const beforeF = await ctx.prisma.figure.count()
    const beforeJ = await ctx.prisma.generationJob.count()
    // 在 generation_jobs 上挂 BEFORE INSERT 中止触发器：让「figure 已插入、job 写入失败」
    // 在真实交互式事务内发生——验证 AC6 的「无孤儿 Figure」由 SQLite 事务原子性兑现
    //（figure insert 未提交，job insert abort → 整体 ROLLBACK）。
    const dbPath = ctx.dbUrl.replace(/^file:/, '')
    const sqlite = new Database(dbPath)
    sqlite.exec(
      `CREATE TRIGGER "test_job_insert_abort" BEFORE INSERT ON "generation_jobs"
       BEGIN SELECT RAISE(ABORT, 'simulated job write failure'); END`,
    )
    sqlite.close()
    try {
      // 必须带 Idempotency-Key：缺头会在进事务前被 90002 拦下，触发器不触发 → 空洞通过。
      // 带 key 才真正走到「figure 插入 + job 写入失败」的原子边界。
      const res = await ctx.request
        .post('/api/v1/figures')
        .set(bearer(access))
        .set('Idempotency-Key', 't01-rollback-key')
        .send({ prompt: 'x' })
      expect(res.status).toBe(200)
      expect(res.body.code).not.toBe(0) // 失败信封（90000 兜底）
      expect(res.body.data).toBeNull()
      expect(await ctx.prisma.figure.count()).toBe(beforeF) // 真实回滚：无孤儿 Figure
      expect(await ctx.prisma.generationJob.count()).toBe(beforeJ) // 无游离 Job
    } finally {
      const clean = new Database(dbPath)
      clean.exec('DROP TRIGGER IF EXISTS "test_job_insert_abort"')
      clean.close()
    }
  })
})

describe('T01 POST /figures（flag 关 = figures deps 未装配）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp() // 不注入 figures → 路由未装配
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC1：flag 关 → 既有 notFound 信封 90005（路由未装配）', async () => {
    const res = await ctx.request.post('/api/v1/figures').send({ prompt: 'anything' })
    expect(res.status).toBe(200) // 全局信封：HTTP 恒 200
    expect(res.body.code).toBe(90005)
    expect(res.body.data).toBeNull()
  })
})

describe('T01 认证（flag 开）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC2：未认证（无 bearer）→ 鉴权错误 10001', async () => {
    const res = await ctx.request.post('/api/v1/figures').send({ prompt: 'anything' })
    expect(res.body.code).toBe(10001)
  })

  it('AC2：坏 token → 鉴权错误 10001（同码，不区分坏 token）', async () => {
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer('not-a-real-token'))
      .send({ prompt: 'anything' })
    expect(res.body.code).toBe(10001)
  })
})

describe('T01 事务 seam（createFigureWithJobInTx 原子性）', () => {
  it('成功：Figure 创建后 1:1 创建 queued Job，返回 {figureId, jobId, status:回读值}；幂等键同事务落库', async () => {
    const okTx: FigureCreateTx = {
      figure: { create: async (args: { data: { ownerId: string; prompt: string; idempotencyKey: string } }) => {
        // T02：幂等键必须随 Figure 同一原子边界落库（否则 key 关联可漂移出事务）。
        expect(args.data.ownerId).toBe('u1')
        expect(args.data.idempotencyKey).toBe('k1')
        return { id: 'figure-1' }
      } },
      generationJob: { create: async (args: { data: { figureId: string } }) => {
        expect(args.data.figureId).toBe('figure-1')
        return { id: 'job-1', status: 'queued' } // fake 模拟 DB 行回读（默认 queued）
      } },
    }
    await expect(
      createFigureWithJobInTx(okTx, { ownerId: 'u1', prompt: 'p', idempotencyKey: 'k1' }),
    ).resolves.toEqual({
      figureId: 'figure-1',
      jobId: 'job-1',
      status: 'queued',
    })
  })

  it('AC6：第二次写失败（Job 落库 reject）→ seam 抛错，绝不返回成功 queued', async () => {
    const failingTx: FigureCreateTx = {
      figure: { create: async () => ({ id: 'figure-2' }) },
      generationJob: {
        create: async () => {
          throw new Error('simulated job write failure')
        },
      },
    }
    await expect(
      createFigureWithJobInTx(failingTx, { ownerId: 'u1', prompt: 'p', idempotencyKey: 'k1' }),
    ).rejects.toThrow('simulated job write failure')
  })
})

describe('T02 幂等：缺失 key / 首建 / 同输入重放 / 异输入冲突 / 并发去重（共享 ctx + 独立 key）', () => {
  let ctx: TestContext
  let access: string
  const key23 = 'ac23-key'
  const keyConflict = 'conflict-key'
  const keyRace = 'race-key'
  const prompt23 = 'idempotent first chart'

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    await seedUser(ctx.prisma, 'figidem', 'pw-idem-secure')
    access = (await login(ctx.request, 'figidem', 'pw-idem-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC1：缺失 Idempotency-Key → 90002 + data null（确定性，区别于 body 校验形状），零行', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const res = await ctx.request.post('/api/v1/figures').set(bearer(access)).send({ prompt: 'valid' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toBeNull() // key-90002 恒 data null；body-90002 才有 fieldErrors——两形状不混淆
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
    expect(await ctx.prisma.generationJob.count()).toBe(beforeF)
  })

  it('AC1：空/纯空白 Idempotency-Key → 90002 + data null，零行', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', '   ')
      .send({ prompt: 'valid' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toBeNull()
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
  })

  it('AC1：超长 Idempotency-Key（>256）→ 90002 + data null，零行（F1 code-review：防御上限防整段索引落库）', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', 'x'.repeat(257))
      .send({ prompt: 'valid' })
    expect(res.body.code).toBe(90002)
    expect(res.body.data).toBeNull()
    expect(await ctx.prisma.figure.count()).toBe(beforeF)
  })

  it('AC2：首次有效创建 → code 0 + {figureId, jobId, status:"queued"}，恰好 1 Figure + 1 Job，幂等键落库', async () => {
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', key23)
      .send({ prompt: prompt23 })
    expect(res.body.code).toBe(0)
    expect(res.body.data.status).toBe('queued')
    expect(await ctx.prisma.figure.count()).toBe(1)
    expect(await ctx.prisma.generationJob.count()).toBe(1)
    const figure = await ctx.prisma.figure.findUnique({ where: { id: res.body.data.figureId } })
    expect(figure!.idempotencyKey).toBe(key23) // 幂等关联持久化（DB 行，非内存）
  })

  it('AC3：同 key + 同输入重放 → 同一 figureId/jobId/status，零新增行', async () => {
    const first = await ctx.prisma.figure.findFirstOrThrow({ where: { idempotencyKey: key23 } })
    const firstJob = await ctx.prisma.generationJob.findUniqueOrThrow({ where: { figureId: first.id } })
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', key23)
      .send({ prompt: prompt23 })
    expect(res.body.code).toBe(0)
    expect(res.body.data.figureId).toBe(first.id)
    expect(res.body.data.jobId).toBe(firstJob.id)
    expect(res.body.data.status).toBe('queued')
    expect(await ctx.prisma.figure.count()).toBe(1)
    expect(await ctx.prisma.generationJob.count()).toBe(1) // 重放绝不产生第二个 Job
  })

  it('AC5：同 key + 不同输入 → 稳定幂等冲突 70041，零写入', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const first = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', keyConflict)
      .send({ prompt: 'conflict chart A' })
    expect(first.body.code).toBe(0)
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', keyConflict)
      .send({ prompt: 'conflict chart B' })
    expect(res.body.code).toBe(70041)
    expect(res.body.data).toBeNull()
    expect(await ctx.prisma.figure.count()).toBe(beforeF + 1) // 只有 A 那一行
    expect(await ctx.prisma.generationJob.count()).toBe(beforeF + 1)
  })

  it('AC8：并发同 key + 同输入双 POST → 两响应 code 0 且同 figureId，至多新增 1 Figure + 1 Job', async () => {
    const beforeF = await ctx.prisma.figure.count()
    const beforeJ = await ctx.prisma.generationJob.count()
    const [a, b] = await Promise.all([
      ctx.request
        .post('/api/v1/figures')
        .set(bearer(access))
        .set('Idempotency-Key', keyRace)
        .send({ prompt: 'race chart' }),
      ctx.request
        .post('/api/v1/figures')
        .set(bearer(access))
        .set('Idempotency-Key', keyRace)
        .send({ prompt: 'race chart' }),
    ])
    expect(a.body.code).toBe(0) // 赢家：创建
    expect(b.body.code).toBe(0) // 输家：P2002 复读 → 重放（绝不被吞成 90000，也绝不重复建行）
    expect(a.body.data.figureId).toBe(b.body.data.figureId)
    expect(a.body.data.jobId).toBe(b.body.data.jobId)
    expect(await ctx.prisma.figure.count()).toBe(beforeF + 1)
    expect(await ctx.prisma.generationJob.count()).toBe(beforeJ + 1)
  })
})

describe('T02 幂等 AC4：queued/running/succeeded/failed 重放返回同一 Figure/Job + 当前持久化状态', () => {
  let ctx: TestContext
  let access: string
  const key = 'states-key'
  const prompt = 'states replay chart'
  const statuses = ['queued', 'running', 'succeeded', 'failed'] as const

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    await seedUser(ctx.prisma, 'figstates', 'pw-states-secure')
    access = (await login(ctx.request, 'figstates', 'pw-states-secure')).access!
    // 首次创建（queued 态），之后各状态由持久化 fixture 拨动 job.status
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', key)
      .send({ prompt })
    expect(res.body.code).toBe(0)
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it.each(statuses)('job 状态拨到 %s → 重放返回同 figureId/jobId 且 status=%s，零新增行', async (status) => {
    const figure = await ctx.prisma.figure.findFirstOrThrow({ where: { idempotencyKey: key } })
    await ctx.prisma.generationJob.update({
      where: { figureId: figure.id },
      data: { status },
    })
    const res = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(access))
      .set('Idempotency-Key', key)
      .send({ prompt })
    expect(res.body.code).toBe(0)
    expect(res.body.data.figureId).toBe(figure.id)
    expect(res.body.data.status).toBe(status) // 当前应用级状态，非硬编码 queued
    expect(await ctx.prisma.figure.count()).toBe(1)
    expect(await ctx.prisma.generationJob.count()).toBe(1)
  })
})

describe('T02 幂等 AC6：不同用户 + 同 key 独立作用域', () => {
  let ctx: TestContext
  let userA = ''
  let userB = ''
  let accessA: string
  let accessB: string
  const key = 'shared-key-across-users'
  const prompt = 'same key different owner'

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    const a = await seedUser(ctx.prisma, 'figidemA', 'pw-idema-secure')
    const b = await seedUser(ctx.prisma, 'figidemB', 'pw-idemb-secure')
    userA = a.id
    userB = b.id
    accessA = (await login(ctx.request, 'figidemA', 'pw-idema-secure')).access!
    accessB = (await login(ctx.request, 'figidemB', 'pw-idemb-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('用户 A 创建 + 重放；用户 B 同 key 独立创建，互不影响', async () => {
    const resA = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(accessA))
      .set('Idempotency-Key', key)
      .send({ prompt })
    expect(resA.body.code).toBe(0)
    const figureA = await ctx.prisma.figure.findUniqueOrThrow({ where: { id: resA.body.data.figureId } })
    expect(figureA.ownerId).toBe(userA)

    // A 同 key 同输入 → 重放（不是新行）
    const replayA = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(accessA))
      .set('Idempotency-Key', key)
      .send({ prompt })
    expect(replayA.body.code).toBe(0)
    expect(replayA.body.data.figureId).toBe(figureA.id)
    expect(await ctx.prisma.figure.count()).toBe(1)

    // B 同 key → 独立创建，属 userB
    const resB = await ctx.request
      .post('/api/v1/figures')
      .set(bearer(accessB))
      .set('Idempotency-Key', key)
      .send({ prompt })
    expect(resB.body.code).toBe(0)
    expect(resB.body.data.figureId).not.toBe(figureA.id)
    const figureB = await ctx.prisma.figure.findUniqueOrThrow({ where: { id: resB.body.data.figureId } })
    expect(figureB.ownerId).toBe(userB)
    expect(await ctx.prisma.figure.count()).toBe(2)
    expect(await ctx.prisma.generationJob.count()).toBe(2)
  })
})

describe('T02 幂等 AC7：幂等关联 survive 重启（同 DB 文件两个 app 实例）', () => {
  const key = 'restart-key'
  const prompt = 'restart surviving chart'
  let firstFigureId = ''
  let firstJobId = ''
  let prismaB: PrismaClient | undefined
  let requestB: SuperTest<Test>
  let accessB: string

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `panel-t02-${process.pid}-`))
    const dbPath = path.join(dir, 'restart.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(INIT_SQL)
    sqlite.close()
    const url = `file:${dbPath}`

    // 实例 A（进程 1）：认证 + 建 Figure + 幂等关联，然后「关闭」
    const prismaA = createPrismaClient(url)
    const appA = createApp({ prisma: prismaA, figures: {} })
    await seedUser(prismaA, 'figrestart', 'pw-restart-secure')
    const appAReq = supertest(appA) as unknown as SuperTest<Test> // 对齐 setup.ts 的 TestAgent→SuperTest 宽化
    const accessA = (await login(appAReq, 'figrestart', 'pw-restart-secure')).access!
    const resA = await appAReq
      .post('/api/v1/figures')
      .set(bearer(accessA))
      .set('Idempotency-Key', key)
      .send({ prompt })
    expect(resA.body.code).toBe(0)
    firstFigureId = resA.body.data.figureId
    firstJobId = resA.body.data.jobId
    await prismaA.$disconnect() // 模拟进程结束（连接关闭，幂等关联留在 DB 文件）

    // 实例 B（进程 2，模拟重启）：新 PrismaClient + 新 app 连同一文件
    prismaB = createPrismaClient(url)
    const appB = createApp({ prisma: prismaB, figures: {} })
    requestB = supertest(appB) as unknown as SuperTest<Test> // 对齐 setup.ts 的 TestAgent→SuperTest 宽化
    accessB = (await login(requestB, 'figrestart', 'pw-restart-secure')).access!
  })
  afterAll(async () => {
    await prismaB?.$disconnect()
  })

  it('同 key 同输入重放 → 返回同一 figureId/jobId，DB 仍只有 1 Figure + 1 Job', async () => {
    const res = await requestB
      .post('/api/v1/figures')
      .set(bearer(accessB))
      .set('Idempotency-Key', key)
      .send({ prompt })
    expect(res.body.code).toBe(0)
    expect(res.body.data.figureId).toBe(firstFigureId)
    expect(res.body.data.jobId).toBe(firstJobId)
    expect(res.body.data.status).toBe('queued')
    expect(await prismaB!.figure.count()).toBe(1)
    expect(await prismaB!.generationJob.count()).toBe(1)
  })
})

describe('T02 幂等 seam：createOrReplayFigure（确定性分支，含并发竞态）', () => {
  const base: CreateFigureInput = { ownerId: 'u1', prompt: 'p', idempotencyKey: 'k1' }
  const created = { figureId: 'f-new', jobId: 'j-new', status: 'queued' }

  function deps(overrides: Partial<IdempotencyDeps>): IdempotencyDeps {
    return {
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      createInTransaction: vi.fn().mockResolvedValue(created),
      ...overrides,
    }
  }

  it('无既有行 → 走创建路径并返回（首建）', async () => {
    const d = deps({})
    await expect(createOrReplayFigure(d, base)).resolves.toEqual(created)
    expect(d.findByIdempotencyKey).toHaveBeenCalledWith('u1', 'k1')
    expect(d.createInTransaction).toHaveBeenCalledWith(base)
  })

  it.each(['queued', 'running', 'succeeded', 'failed'] as const)(
    '既有行 + 同输入 → 重放返回当前持久化 job status=%s，不写',
    async (status) => {
      const d = deps({
        findByIdempotencyKey: vi
          .fn()
          .mockResolvedValue({ id: 'f-1', prompt: 'p', job: { id: 'j-1', status } }),
      })
      await expect(createOrReplayFigure(d, base)).resolves.toEqual({ figureId: 'f-1', jobId: 'j-1', status })
      expect(d.createInTransaction).not.toHaveBeenCalled()
    },
  )

  it('既有行 + 不同输入 → 70041 冲突，不写', async () => {
    const d = deps({
      findByIdempotencyKey: vi
        .fn()
        .mockResolvedValue({ id: 'f-1', prompt: 'different', job: { id: 'j-1', status: 'queued' } }),
    })
    await expect(createOrReplayFigure(d, base)).rejects.toMatchObject({ code: 70041 })
    expect(d.createInTransaction).not.toHaveBeenCalled()
  })

  it('创建撞唯一约束（P2002）→ 复读 winner 同输入 → 重放', async () => {
    const winner = { id: 'f-1', prompt: 'p', job: { id: 'j-1', status: 'succeeded' } }
    const d = deps({
      findByIdempotencyKey: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
      createInTransaction: vi.fn().mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' })),
    })
    await expect(createOrReplayFigure(d, base)).resolves.toEqual({ figureId: 'f-1', jobId: 'j-1', status: 'succeeded' })
  })

  it('创建撞唯一约束（P2002）→ 复读 winner 不同输入 → 70041', async () => {
    const winner = { id: 'f-1', prompt: 'different', job: { id: 'j-1', status: 'queued' } }
    const d = deps({
      findByIdempotencyKey: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
      createInTransaction: vi.fn().mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' })),
    })
    await expect(createOrReplayFigure(d, base)).rejects.toMatchObject({ code: 70041 })
  })

  it('创建撞唯一约束（P2002）→ 复读落空 → 原始 P2002 上抛（不吞、不转成功）', async () => {
    const p2002 = Object.assign(new Error('unique'), { code: 'P2002' })
    const d = deps({
      findByIdempotencyKey: vi.fn().mockResolvedValue(null), // 复读也 null（winner 消隐，理论不可达）
      createInTransaction: vi.fn().mockRejectedValueOnce(p2002),
    })
    await expect(createOrReplayFigure(d, base)).rejects.toBe(p2002)
  })

  it('创建撞非 P2002 错误（P2003/通用 Error）→ 原样上抛（不吞、不转重放）', async () => {
    const errors = [
      Object.assign(new Error('fk'), { code: 'P2003' }),
      new Error('random persistence failure'),
    ]
    for (const err of errors) {
      const d = deps({ createInTransaction: vi.fn().mockRejectedValueOnce(err) })
      await expect(createOrReplayFigure(d, base)).rejects.toBe(err)
    }
  })
})
