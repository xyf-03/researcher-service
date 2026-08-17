// T05 —— Figure history / ownership（docs/autofigure/tickets/T05-figure-history-ownership.md）
// 接缝：REST 信封接缝（setupTestApp + seedUser/seedAdmin + login + bearer）+ 持久化 fixture
//（直接种子 Figure + 1:1 Job 任意状态，不依赖 runner——fixture 是测试技术，不是依赖边）。
// 覆盖：仅自己列表 / 他人不出现 / createdAt DESC + id tiebreaker / 四态投影（list+detail）/
// 本人详情 / 不存在与越权同码 70040 / admin 跨用户（spec US15）/ failed 非敏感投影 +
// 白名单护栏（未知/敏感内容归通用非敏感原因）/ 无凭证泄露 / 无删除端点 / 未认证 10001 /
// flag 关 90005。PNG 下载端点（T06）不再越界——见 figuresPng.test.ts。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, seedAdmin, login, bearer } from './helpers'
import type { GenerationJobStatus } from '../src/generated/prisma/client'

// fixture：直接布置 Figure + 其 1:1 Job（任意状态/时间/id），对齐 figuresRunner.test.ts seedJob 先例。
let seq = 0
async function seedFigure(
  ctx: TestContext,
  opts: {
    ownerId: string
    prompt?: string
    id?: string
    createdAt?: Date
    status?: GenerationJobStatus
    errorMessage?: string | null
  },
) {
  return ctx.prisma.figure.create({
    data: {
      id: opts.id,
      ownerId: opts.ownerId,
      prompt: opts.prompt ?? 'chart',
      idempotencyKey: `hist-key-${seq++}`,
      createdAt: opts.createdAt,
      job: {
        create: {
          status: opts.status ?? 'queued',
          errorMessage: opts.errorMessage,
        },
      },
    },
    include: { job: true },
  })
}

describe('T05 GET /figures —— 普通用户列表（仅自己 · 排序 · 空列表）', () => {
  let ctx: TestContext
  let userA: { id: string }
  let userB: { id: string }
  let accessA: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    userA = await seedUser(ctx.prisma, 'histA', 'pw-hista-secure')
    userB = await seedUser(ctx.prisma, 'histB', 'pw-histb-secure')
    accessA = (await login(ctx.request, 'histA', 'pw-hista-secure')).access!
    // 用户 A：老 / 中 / 新三条；用户 B：一条（绝不应出现在 A 列表）
    await seedFigure(ctx, { ownerId: userA.id, prompt: 'oldest', createdAt: new Date('2026-01-01T00:00:00Z') })
    await seedFigure(ctx, { ownerId: userB.id, prompt: 'other-user', createdAt: new Date('2026-01-02T00:00:00Z') })
    await seedFigure(ctx, { ownerId: userA.id, prompt: 'middle', createdAt: new Date('2026-01-03T00:00:00Z') })
    await seedFigure(ctx, { ownerId: userA.id, prompt: 'newest', createdAt: new Date('2026-01-04T00:00:00Z') })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC1：只返回自己的 Figure，他人 Figure 不出现；createdAt DESC（最新在前）', async () => {
    const res = await ctx.request.get('/api/v1/figures').set(bearer(accessA))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    const data = res.body.data
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(3) // B 的一条不出现
    expect(data.map((x: { prompt: string }) => x.prompt)).toEqual(['newest', 'middle', 'oldest'])
    // 列表项精确形状：仅 figureId/jobId/prompt/status/createdAt，无多余字段
    for (const item of data) {
      expect(item).toEqual({
        figureId: expect.any(String),
        jobId: expect.any(String),
        prompt: expect.any(String),
        status: 'queued',
        createdAt: expect.any(String),
      })
    }
  })

  it('createdAt 撞车 → id DESC 稳定 tiebreaker（确定性二级序，不暴露排序选项）', async () => {
    await seedFigure(ctx, { ownerId: userA.id, id: 'zzz-tie-a', prompt: 'tie-a', createdAt: new Date('2026-01-05T00:00:00Z') })
    await seedFigure(ctx, { ownerId: userA.id, id: 'aaa-tie-b', prompt: 'tie-b', createdAt: new Date('2026-01-05T00:00:00Z') })
    const res = await ctx.request.get('/api/v1/figures').set(bearer(accessA))
    const data = res.body.data
    // 同日两条内部按 id DESC：zzz-tie-a 在 aaa-tie-b 之前
    expect(data.filter((x: { prompt: string }) => x.prompt.startsWith('tie-')).map((x: { prompt: string }) => x.prompt)).toEqual([
      'tie-a',
      'tie-b',
    ])
  })

  it('无数据用户 → code 0 + 空数组 []', async () => {
    await seedUser(ctx.prisma, 'histC', 'pw-histc-secure')
    const accessC = (await login(ctx.request, 'histC', 'pw-histc-secure')).access!
    const res = await ctx.request.get('/api/v1/figures').set(bearer(accessC))
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual([])
  })
})

describe('T05 GET /figures/:id —— 四态投影 + 非敏感失败原因', () => {
  let ctx: TestContext
  let user: { id: string }
  let access: string
  const statuses: Array<GenerationJobStatus> = ['queued', 'running', 'succeeded', 'failed']

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    user = await seedUser(ctx.prisma, 'histstates', 'pw-states-secure')
    access = (await login(ctx.request, 'histstates', 'pw-states-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it.each(statuses)('AC3：status=%s → 详情投影正确（errorMessage 仅 failed 非空）', async (status) => {
    const figure = await seedFigure(ctx, {
      ownerId: user.id,
      prompt: `state-${status}`,
      status,
      errorMessage: status === 'failed' ? '生成超时（执行超过时限）' : null,
    })
    const res = await ctx.request.get(`/api/v1/figures/${figure.id}`).set(bearer(access))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({
      figureId: figure.id,
      jobId: figure.job!.id,
      prompt: `state-${status}`,
      status,
      errorMessage: status === 'failed' ? '生成超时（执行超过时限）' : null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })
  })

  it('列表同样投影应用级状态：queued/running/succeeded/failed 各态正确', async () => {
    for (const s of statuses) {
      await seedFigure(ctx, {
        ownerId: user.id,
        prompt: `list-${s}`,
        status: s,
        errorMessage: s === 'failed' ? '生成执行异常（内部错误）' : null,
      })
    }
    const res = await ctx.request.get('/api/v1/figures').set(bearer(access))
    expect(res.body.code).toBe(0)
    const byPrompt = Object.fromEntries(res.body.data.map((x: { prompt: string; status: string }) => [x.prompt, x.status]))
    for (const s of statuses) {
      expect(byPrompt[`list-${s}`]).toBe(s)
    }
  })

  it('AC4：failed 仅暴露稳定非敏感原因——响应体无凭证/栈/内部实现特征', async () => {
    const figure = await seedFigure(ctx, {
      ownerId: user.id,
      prompt: 'leak-check',
      status: 'failed',
      errorMessage: '生成任务因服务重启/中断被终止',
    })
    const res = await ctx.request.get(`/api/v1/figures/${figure.id}`).set(bearer(access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.errorMessage).toBe('生成任务因服务重启/中断被终止')
    // 精确字段集（7 字段）：无任何额外字段能承载凭证/堆栈/内部细节
    expect(Object.keys(res.body.data).sort()).toEqual([
      'createdAt',
      'errorMessage',
      'figureId',
      'jobId',
      'prompt',
      'status',
      'updatedAt',
    ])
    const raw = JSON.stringify(res.body)
    expect(raw).not.toMatch(/api[_-]?key/i)
    expect(raw).not.toMatch(/secret|credential|password/i)
    expect(raw).not.toMatch(/traceback|stack\b|at\s+\w+\.\w+\s*\(/i)
    expect(raw).not.toMatch(/python|sidecar|bullmq|\bworker\b|\bprisma\b/i)
  })

  it('非 failed 态即使行上带 errorMessage 也不外泄（投影只在 failed 透出）', async () => {
    const figure = await seedFigure(ctx, {
      ownerId: user.id,
      prompt: 'running-stray',
      status: 'running',
      errorMessage: '内部细节不应外泄',
    })
    const res = await ctx.request.get(`/api/v1/figures/${figure.id}`).set(bearer(access))
    expect(res.body.data.status).toBe('running')
    expect(res.body.data.errorMessage).toBeNull()
  })

  it('AC4+（安全护栏）：failed 态行上带未知/疑似敏感 errorMessage → 归为通用非敏感原因，不外泄', async () => {
    const figure = await seedFigure(ctx, {
      ownerId: user.id,
      prompt: 'guard-unknown',
      status: 'failed',
      errorMessage: 'OpenAI key sk-abc123\nTraceback (most recent call last):\n  File "/app/x.py", line 1',
    })
    const res = await ctx.request.get(`/api/v1/figures/${figure.id}`).set(bearer(access))
    expect(res.body.code).toBe(0)
    // 白名单外的内容 → 通用非敏感原因（GENERATION_EXECUTION_ERROR），原始值不对外
    expect(res.body.data.errorMessage).toBe('生成执行异常（内部错误）')
    const raw = JSON.stringify(res.body)
    expect(raw).not.toMatch(/sk-abc123/i)
    expect(raw).not.toMatch(/traceback|stack\b/i)
  })
})

describe('T05 GET /figures/:id —— 归属门防枚举（不存在 vs 越权同码 70040）', () => {
  let ctx: TestContext
  let userA: { id: string }
  let userB: { id: string }
  let accessA: string
  let accessB: string
  let otherFigureId: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    userA = await seedUser(ctx.prisma, 'histownA', 'pw-owna-secure')
    userB = await seedUser(ctx.prisma, 'histownB', 'pw-ownb-secure')
    accessA = (await login(ctx.request, 'histownA', 'pw-owna-secure')).access!
    accessB = (await login(ctx.request, 'histownB', 'pw-ownb-secure')).access!
    const bFig = await seedFigure(ctx, { ownerId: userB.id, prompt: 'b-secret-figure' })
    otherFigureId = bFig.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC5：他人 Figure（非 admin）→ 70040，data null', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${otherFigureId}`).set(bearer(accessA))
    expect(res.status).toBe(200) // 全局信封：HTTP 恒 200
    expect(res.body.code).toBe(70040)
    expect(res.body.data).toBeNull()
  })

  it('AC6：不存在 id → 70040，data null（与越权同码，防枚举）', async () => {
    const res = await ctx.request.get('/api/v1/figures/does-not-exist-id').set(bearer(accessA))
    expect(res.body.code).toBe(70040)
    expect(res.body.data).toBeNull()
  })

  it('不存在与越权公开响应逐字节一致（同码同消息同 data）', async () => {
    const missing = await ctx.request.get('/api/v1/figures/does-not-exist-id-2').set(bearer(accessA))
    const forbidden = await ctx.request.get(`/api/v1/figures/${otherFigureId}`).set(bearer(accessA))
    expect(forbidden.body.code).toBe(70040)
    expect(forbidden.body).toEqual(missing.body)
  })

  it('本人 Figure → code 0（归属门放行自己；他人读它仍是 70040）', async () => {
    const aFig = await seedFigure(ctx, { ownerId: userA.id, prompt: 'a-own-figure' })
    const own = await ctx.request.get(`/api/v1/figures/${aFig.id}`).set(bearer(accessA))
    expect(own.body.code).toBe(0)
    expect(own.body.data.figureId).toBe(aFig.id)
    const cross = await ctx.request.get(`/api/v1/figures/${aFig.id}`).set(bearer(accessB))
    expect(cross.body.code).toBe(70040)
  })

  it('AC7：未认证 → 10001（GET 也经 requireAuth）', async () => {
    const list = await ctx.request.get('/api/v1/figures')
    expect(list.body.code).toBe(10001)
    const detail = await ctx.request.get(`/api/v1/figures/${otherFigureId}`)
    expect(detail.body.code).toBe(10001)
  })
})

describe('T05 admin 跨用户可见（spec US15 / grilling §3 显式批准）', () => {
  let ctx: TestContext
  let userA: { id: string }
  let userB: { id: string }
  let adminAccess: string
  let userAAccess: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    await seedAdmin(ctx.prisma, 'histadmin', 'pw-admin-secure')
    userA = await seedUser(ctx.prisma, 'histcrossA', 'pw-crossa-secure')
    userB = await seedUser(ctx.prisma, 'histcrossB', 'pw-crossb-secure')
    adminAccess = (await login(ctx.request, 'histadmin', 'pw-admin-secure')).access!
    userAAccess = (await login(ctx.request, 'histcrossA', 'pw-crossa-secure')).access!
    // A 2 条 + B 1 条（交错 createdAt）
    await seedFigure(ctx, { ownerId: userA.id, prompt: 'a-fig-1', createdAt: new Date('2026-02-01T00:00:00Z') })
    await seedFigure(ctx, { ownerId: userA.id, prompt: 'a-fig-2', createdAt: new Date('2026-02-02T00:00:00Z') })
    await seedFigure(ctx, { ownerId: userB.id, prompt: 'b-fig-1', createdAt: new Date('2026-02-03T00:00:00Z') })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('AC2：admin 列表返回所有用户的 Figure（全见）；普通 user 仅见自己', async () => {
    const adminRes = await ctx.request.get('/api/v1/figures').set(bearer(adminAccess))
    expect(adminRes.body.code).toBe(0)
    expect(adminRes.body.data).toHaveLength(3) // A 2 + B 1
    expect(adminRes.body.data.map((x: { prompt: string }) => x.prompt).sort()).toEqual(['a-fig-1', 'a-fig-2', 'b-fig-1'])
    const userRes = await ctx.request.get('/api/v1/figures').set(bearer(userAAccess))
    expect(userRes.body.data).toHaveLength(2) // A 只见自己的 2 条
  })

  it('admin 可读任意用户的 Figure 详情（跨用户）；响应不暴露 ownerId', async () => {
    const bFig = await ctx.prisma.figure.findFirstOrThrow({ where: { ownerId: userB.id } })
    const res = await ctx.request.get(`/api/v1/figures/${bFig.id}`).set(bearer(adminAccess))
    expect(res.body.code).toBe(0)
    expect(res.body.data.prompt).toBe('b-fig-1')
    expect(res.body.data).not.toHaveProperty('ownerId') // 归属是内部实现，公开投影不含
  })

  it('admin 无删除能力：DELETE /figures/:id → 90005，行仍在', async () => {
    const bFig = await ctx.prisma.figure.findFirstOrThrow({ where: { ownerId: userB.id } })
    const before = await ctx.prisma.figure.count()
    const res = await ctx.request.delete(`/api/v1/figures/${bFig.id}`).set(bearer(adminAccess))
    expect(res.body.code).toBe(90005) // 无删除路由（V1 无 Figure 删除，含 admin）
    expect(await ctx.prisma.figure.count()).toBe(before) // 行未被删
  })
})

describe('T05 越界端点与 flag 关', () => {
  // PNG 下载端点（T06）已非越界 → 见 figuresPng.test.ts；本 describe 只保留 flag 关验证。
  it('flag 关（figures deps 未装配）→ GET 列表与详情均 90005', async () => {
    const off = await setupTestApp() // 不注入 figures
    try {
      const list = await off.request.get('/api/v1/figures')
      expect(list.body.code).toBe(90005)
      const detail = await off.request.get('/api/v1/figures/any-id')
      expect(detail.body.code).toBe(90005)
    } finally {
      await off.cleanup()
    }
  })
})
