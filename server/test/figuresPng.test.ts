// T06 —— PNG 下载端点（docs/autofigure/tickets/T06-artifact-persistence-png.md · spec §3）。
// 接缝：REST 信封接缝（setupTestApp + seedUser/seedAdmin + login + bearer）+ 持久化 fixture
//（直接种子 Figure + 1:1 Job + 产物列任意状态，不依赖 runner——fixture 是测试技术，不是依赖边）。
// 覆盖：owner+succeeded 精确字节回读（Content-Type image/png，成功路径豁免 #312 信封）/
// 他人 70040 / 不存在 70040 逐字节一致（防枚举）/ 未认证 10001 / queued+running 70042 未就绪 /
// failed 70043 不可用 / succeeded 但 png null 70043（升级前遗留成功行，不模糊 500）/
// admin 跨用户可下载（spec §3 归属防探测 + T06 AC「非 owner（含 admin 以外角色）→ 70040」+
// grilling §3「admin 跨用户全部可见」）/ survive restart。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, seedAdmin, login, bearer } from './helpers'
import { createPrismaClient } from '../src/prisma'
import { createApp } from '../src/app'
import type { FigurePngBytes } from '../src/figures/port'
import type { GenerationJobStatus } from '../src/generated/prisma/client'

// 确定性 PNG 字节（magic + 固定差异尾）；用 FigurePngBytes（Prisma BLOB 类型等价）作 fixture
// 参数类型（supertest 二进制响应体是 Buffer，字节级可比）。不用随机数据——确定性可复现。
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]
const THE_PNG: FigurePngBytes = Buffer.from(PNG_BYTES)

// fixture：直接布置 Figure + 其 1:1 Job + 可选产物列（任意状态/时间/id），对齐
// figuresHistory.test.ts seedFigure 先例（产物列由 T06 测试显式传）。
let seq = 0
async function seedFigure(
  ctx: TestContext,
  opts: {
    ownerId: string
    prompt?: string
    status?: GenerationJobStatus
    errorMessage?: string | null
    xml?: string | null
    png?: FigurePngBytes | null
    evaluation?: string | null
  },
) {
  return ctx.prisma.figure.create({
    data: {
      ownerId: opts.ownerId,
      prompt: opts.prompt ?? 'chart',
      idempotencyKey: `png-key-${seq++}`,
      xml: opts.xml ?? null,
      png: opts.png ?? null,
      evaluation: opts.evaluation ?? null,
      job: {
        create: {
          status: opts.status ?? 'queued',
          errorMessage: opts.errorMessage ?? null,
        },
      },
    },
    include: { job: true },
  })
}

describe('T06 GET /figures/:id/png —— owner + succeeded 精确字节', () => {
  let ctx: TestContext
  let user: { id: string }
  let access: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    user = await seedUser(ctx.prisma, 'pngowner', 'pw-pngowner-secure')
    access = (await login(ctx.request, 'pngowner', 'pw-pngowner-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('owner + succeeded → 200 + Content-Type image/png + 精确 PNG 字节（成功路径豁免信封）', async () => {
    const fig = await seedFigure(ctx, { ownerId: user.id, status: 'succeeded', png: THE_PNG })
    const res = await ctx.request.get(`/api/v1/figures/${fig.id}/png`).set(bearer(access))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^image\/png/)
    // 原生字节（非 base64-in-JSON，非 #312 信封 JSON）：supertest 对 image/png 保留 Buffer 体
    expect(Buffer.isBuffer(res.body)).toBe(true)
    expect(res.body.equals(THE_PNG)).toBe(true)
  })
})

describe('T06 GET /figures/:id/png —— 归属门防枚举（同码 70040）', () => {
  let ctx: TestContext
  let userB: { id: string }
  let accessA: string
  let bFigId: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    await seedUser(ctx.prisma, 'pngownA', 'pw-owna-secure') // 归属门只按 JWT 身份判定，变量名不承载逻辑
    userB = await seedUser(ctx.prisma, 'pngownB', 'pw-ownb-secure')
    accessA = (await login(ctx.request, 'pngownA', 'pw-owna-secure')).access!
    const bFig = await seedFigure(ctx, { ownerId: userB.id, status: 'succeeded', png: THE_PNG })
    bFigId = bFig.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('他人 Figure（非 admin）→ 70040，data null（与 /:id 同码防探测）', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${bFigId}/png`).set(bearer(accessA))
    expect(res.status).toBe(200) // 全局信封：错误面 HTTP 恒 200
    expect(res.body.code).toBe(70040)
    expect(res.body.data).toBeNull()
  })

  it('不存在 id → 70040，data null；与越权响应逐字节一致（防枚举）', async () => {
    const missing = await ctx.request.get('/api/v1/figures/does-not-exist/png').set(bearer(accessA))
    const forbidden = await ctx.request.get(`/api/v1/figures/${bFigId}/png`).set(bearer(accessA))
    expect(missing.body.code).toBe(70040)
    expect(forbidden.body).toEqual(missing.body) // 不存在 vs 越权不可区分
  })

  it('未认证 → 10001（requireAuth 前置）', async () => {
    const res = await ctx.request.get(`/api/v1/figures/${bFigId}/png`)
    expect(res.body.code).toBe(10001)
  })
})

describe('T06 GET /figures/:id/png —— 状态门（未完成/失败 → 明确应用级响应）', () => {
  let ctx: TestContext
  let user: { id: string }
  let access: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    user = await seedUser(ctx.prisma, 'pngstate', 'pw-state-secure')
    access = (await login(ctx.request, 'pngstate', 'pw-state-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it.each(['queued', 'running'] as const)('status=%s → 70042 未就绪（明确「未就绪」响应，非模糊 500）', async (status) => {
    const fig = await seedFigure(ctx, { ownerId: user.id, status })
    const res = await ctx.request.get(`/api/v1/figures/${fig.id}/png`).set(bearer(access))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(70042)
    expect(res.body.data).toBeNull()
    expect(typeof res.body.message).toBe('string') // 信封总述（人类可读）
  })

  it('failed → 70043 不可用（明确「不可用」响应）', async () => {
    const fig = await seedFigure(ctx, {
      ownerId: user.id,
      status: 'failed',
      errorMessage: '生成超时（执行超过时限）',
    })
    const res = await ctx.request.get(`/api/v1/figures/${fig.id}/png`).set(bearer(access))
    expect(res.body.code).toBe(70043)
    expect(res.body.data).toBeNull()
  })

  it('succeeded 但 png 为 null（升级前遗留成功行/完整性防御）→ 70043 不可用，不模糊 500', async () => {
    const fig = await seedFigure(ctx, { ownerId: user.id, status: 'succeeded' }) // png null
    const res = await ctx.request.get(`/api/v1/figures/${fig.id}/png`).set(bearer(access))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(70043)
    expect(res.body.data).toBeNull()
  })
})

describe('T06 admin 跨用户 PNG 下载（spec §3 / T06 AC / grilling §3）', () => {
  let ctx: TestContext
  let userB: { id: string }
  let adminAccess: string
  let userBAccess: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    await seedAdmin(ctx.prisma, 'pngadmin', 'pw-admin-secure')
    userB = await seedUser(ctx.prisma, 'pngcrossB', 'pw-crossb-secure')
    adminAccess = (await login(ctx.request, 'pngadmin', 'pw-admin-secure')).access!
    userBAccess = (await login(ctx.request, 'pngcrossB', 'pw-crossb-secure')).access!
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('admin 可下载任意用户 Figure 的 PNG 字节（归属门 admin 全放行）', async () => {
    const fig = await seedFigure(ctx, { ownerId: userB.id, status: 'succeeded', png: THE_PNG })
    // admin 跨用户下载：精确字节
    const adminRes = await ctx.request.get(`/api/v1/figures/${fig.id}/png`).set(bearer(adminAccess))
    expect(adminRes.status).toBe(200)
    expect(adminRes.body.equals(THE_PNG)).toBe(true)
    // owner 自己照常可下载（admin 放行不影响 owner 路径）
    const ownerRes = await ctx.request.get(`/api/v1/figures/${fig.id}/png`).set(bearer(userBAccess))
    expect(ownerRes.body.equals(THE_PNG)).toBe(true)
  })

  it('admin 对他人 failed Figure 的 PNG → 70043（状态门独立于归属门，不因 admin 特免）', async () => {
    const fig = await seedFigure(ctx, { ownerId: userB.id, status: 'failed', errorMessage: '生成执行异常（内部错误）' })
    const res = await ctx.request.get(`/api/v1/figures/${fig.id}/png`).set(bearer(adminAccess))
    expect(res.body.code).toBe(70043)
  })
})

describe('T06 survive restart —— 产物落 SQLite，重启后仍可下载', () => {
  let ctx: TestContext
  let user: { id: string }
  let access: string
  let figId: string

  beforeAll(async () => {
    ctx = await setupTestApp({ figures: {} })
    user = await seedUser(ctx.prisma, 'pngrestart', 'pw-restart-secure')
    access = (await login(ctx.request, 'pngrestart', 'pw-restart-secure')).access!
    const fig = await seedFigure(ctx, { ownerId: user.id, status: 'succeeded', png: THE_PNG })
    figId = fig.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('断开原 app 连接，以同一 dbUrl 新建 prisma + app（模拟重启）→ owner 仍可下载精确 PNG', async () => {
    await ctx.prisma.$disconnect() // 模拟进程重启：丢弃原客户端

    const prisma2 = createPrismaClient(ctx.dbUrl)
    const app2 = createApp({ prisma: prisma2, figures: {} })
    try {
      const request2 = supertest(app2)
      const res = await request2.get(`/api/v1/figures/${figId}/png`).set(bearer(access))
      expect(res.status).toBe(200)
      expect(res.body.equals(THE_PNG)).toBe(true) // 字节精确：产物从 SQLite 回读，非进程内存
    } finally {
      await prisma2.$disconnect()
    }
  })
})
