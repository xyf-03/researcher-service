// T03 runner 测试（docs/autofigure/tickets/T03-single-worker-generation-lifecycle.md）。
//
// 测试面：直接驱动 runner 周期/tick 接缝 + 状态转换纯函数 + 原子领取 seam + 终态写入 seam +
// flag 装配门。逐条对应 AC：
//   AC1 fake 成功 → succeeded（startedAt 领取置位 / finishedAt 终态置位）· AC2 fake 失败 →
//   failed（非敏感 errorMessage）· AC3 原子领取恰一个赢家（至多一次）· AC4 concurrency=1（不同
//   queued Job 不重叠）· AC5 非法终态转换拒绝（纯函数 + 终态写入完整性）· AC6 无自动重试 ·
//   AC7 凭证注入 Port 但绝不落盘/不混同/不泄漏 · AC8 flag 关 → 无 pump。
//
// 无 wall-clock 轮询：时间戳两阶段语义用「直接 await 领取 seam」（running + startedAt，finishedAt
// 仍 null）与「完整 tick 成功/失败路径」（finishedAt 置位）分别确定性断言。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import type { AutoFigureGenerationResult } from '../src/figures/port'
import {
  assertLegalTransition,
  claimQueuedJob,
  persistTerminalState,
  persistSucceededWithArtifacts,
  reconcileRunningJobs,
  timeoutRunningJobs,
  JOB_TIMEOUT_REASON,
  JOB_RECONCILE_REASON,
  GENERATION_EXECUTION_ERROR,
  assembleAutoFigureRunner,
  createGenerationRunner,
  type GenerationRunner,
} from '../src/figures/runner'
import { FakeAutoFigureGenerationPort, okArtifacts } from './figuresFakePort'

// 临时库建表源（与 setup.ts 同源：better-sqlite3 直读 init.sql，不经 prisma CLI）。
const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')

let prisma: PrismaClient
let seedSeq = 0

beforeEach(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), `figures-runner-${process.pid}-`))
  const dbPath = path.join(dir, 'test.db')
  const sqlite = new Database(dbPath)
  sqlite.exec(INIT_SQL)
  sqlite.close()
  prisma = createPrismaClient(`file:${dbPath}`)
})

afterEach(async () => {
  await prisma.$disconnect()
})

async function createUser(): Promise<string> {
  const u = await prisma.user.create({
    data: { username: `runner-u-${seedSeq++}`, passwordHash: 'x' },
  })
  return u.id
}

// seed 一个 Figure + 其 1:1 queued GenerationJob（对齐 T01 原子创建结果，不经 HTTP）。
async function seedQueuedJob(prompt: string, userId: string): Promise<string> {
  const figure = await prisma.figure.create({
    data: { ownerId: userId, prompt, idempotencyKey: `runner-key-${seedSeq++}` },
  })
  const job = await prisma.generationJob.create({ data: { figureId: figure.id } })
  return job.id
}

// T04：seed 任意状态 Job（reconcile / 超时测试布置，状态可直接落库不经 runner）。
async function seedJob(
  prompt: string,
  userId: string,
  opts: {
    status?: 'queued' | 'running' | 'succeeded' | 'failed'
    startedAt?: Date
    finishedAt?: Date
    errorMessage?: string
  } = {},
): Promise<string> {
  const figure = await prisma.figure.create({
    data: { ownerId: userId, prompt, idempotencyKey: `t04-key-${seedSeq++}` },
  })
  const job = await prisma.generationJob.create({
    data: {
      figureId: figure.id,
      status: opts.status ?? 'queued',
      startedAt: opts.startedAt,
      finishedAt: opts.finishedAt,
      errorMessage: opts.errorMessage,
    },
  })
  return job.id
}

function makeRunner(
  fake: FakeAutoFigureGenerationPort,
  opts: { llmKey?: string; timeoutMs?: number; timeoutSweepIntervalMs?: number } = {},
): GenerationRunner {
  return createGenerationRunner({
    prisma,
    port: fake,
    llmKey: opts.llmKey ?? 'sk-test-secret',
    timeoutMs: opts.timeoutMs,
    timeoutSweepIntervalMs: opts.timeoutSweepIntervalMs,
  })
}

describe('T03 runner（AC1/AC2）fake 结果 → 终态持久化 + 时间戳', () => {
  it('fake 成功 → succeeded；startedAt 领取置位 + finishedAt 终态置位；errorMessage 恒 null', async () => {
    const userId = await createUser()
    const prompt = '画一幅星空下的麦田'
    const jobId = await seedQueuedJob(prompt, userId)
    const fake = new FakeAutoFigureGenerationPort() // 脚本空 → 默认成功
    const runner = makeRunner(fake)

    await runner.tick()

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('succeeded')
    expect(job.startedAt).not.toBeNull()
    expect(job.finishedAt).not.toBeNull()
    expect(job.errorMessage).toBeNull()
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].input).toEqual({ prompt })
    // T06：succeeded 终态与产物同一事务原子落 Figure（xml/png/evaluation 齐备）
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: job.figureId } })
    expect(figure.xml).toBe('<mxfile host="fake" type="device"><diagram/></mxfile>')
    expect(figure.evaluation).toBe('{"ok":true,"quality":"good"}')
    expect(Array.from(figure.png!)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
  })

  it('fake 失败 → failed；非敏感 errorMessage 落库；时间戳齐全', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('画一座山', userId)
    const fake = new FakeAutoFigureGenerationPort([{ ok: false, errorMessage: 'provider quota exceeded' }])
    const runner = makeRunner(fake)

    await runner.tick()

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe('provider quota exceeded')
    expect(job.startedAt).not.toBeNull()
    expect(job.finishedAt).not.toBeNull()
    // T06：failed 不落任何成功产物
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: job.figureId } })
    expect(figure.xml).toBeNull()
    expect(figure.png).toBeNull()
    expect(figure.evaluation).toBeNull()
  })

  it('Port 抛异常 → 归一 failed（非敏感消息，不暴露内部栈/凭证）', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()
    fake.throwOnGenerate = true
    const runner = makeRunner(fake)

    await runner.tick()

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe('生成执行异常（内部错误）')
    expect(job.errorMessage).not.toContain('simulated port crash') // 不暴露内部异常细节
    expect(job.errorMessage).not.toContain('sk-test-secret')
  })
})

describe('T03 原子领取（AC3）恰一个赢家、至多一次', () => {
  it('seam：两个并发领取同一 queued Job → 恰一个 count=1；赢家置 running+startedAt，finishedAt 仍 null', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)

    const results = await Promise.all([
      claimQueuedJob(prisma, jobId),
      claimQueuedJob(prisma, jobId),
    ])

    // 至多一个赢家（SQL 单语句 + SQLite 单 writer 保证判定原子）
    expect(results.filter(Boolean)).toHaveLength(1)
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('running')
    expect(job.startedAt).not.toBeNull() // 领取置位（running 入口）
    expect(job.finishedAt).toBeNull() // 未到终态
  })

  it('runner：并发两次 tick 同一 Job → 只执行一次生成', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)

    await Promise.all([runner.tick(), runner.tick()])

    expect(fake.calls).toHaveLength(1) // 只生成一次
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'succeeded',
    )
  })
})

describe('T03 concurrency=1（AC4）不同 queued Job 不重叠执行', () => {
  it('A 挂起期间第二次 tick 为 no-op；B 不被并发执行，下一周期才串行处理', async () => {
    const userId = await createUser()
    const jobA = await seedQueuedJob('a', userId)
    const jobB = await seedQueuedJob('b', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)
    fake.mode = 'pending'

    const entered = fake.generateEntered() // 先注册「A 已进入 generate」等待点
    const t1 = runner.tick() // A：领取 + 挂起于 generate（active 置位）
    const t2 = runner.tick() // active → no-op（不同 Job 不重叠执行）
    await t2 // t2 未启动任何 runOne

    await entered // 确定性：A 的 generate 已进入（resolver 已就位）
    fake.resolveNext(okArtifacts()) // A 成功
    await t1

    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobA } })).status).toBe(
      'succeeded',
    )
    expect(fake.calls).toHaveLength(1) // 至此刻只生成了 A
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobB } })).status).toBe(
      'queued', // B 从未被重叠执行
    )

    fake.mode = 'auto' // A 已完成；B 走正常成功路径（否则 B 也挂起，非本用例意图）
    await runner.tick() // 下一周期才处理 B（串行）
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobB } })).status).toBe(
      'succeeded',
    )
    expect(fake.calls).toHaveLength(2)
  })
})

describe('T03 状态转换完整性（AC5）', () => {
  it('合法转换放行：queued→running、running→succeeded|failed', () => {
    expect(() => assertLegalTransition('queued', 'running')).not.toThrow()
    expect(() => assertLegalTransition('running', 'succeeded')).not.toThrow()
    expect(() => assertLegalTransition('running', 'failed')).not.toThrow()
  })

  it('非法终态转换拒绝：failed→succeeded / failed→running / succeeded→running / succeeded→failed', () => {
    expect(() => assertLegalTransition('failed', 'succeeded')).toThrow(/非法 GenerationJob 状态转换/)
    expect(() => assertLegalTransition('failed', 'running')).toThrow(/非法 GenerationJob 状态转换/)
    expect(() => assertLegalTransition('succeeded', 'running')).toThrow(/非法 GenerationJob 状态转换/)
    expect(() => assertLegalTransition('succeeded', 'failed')).toThrow(/非法 GenerationJob 状态转换/)
  })

  it('终态写入以 status=running 为条件：已终态 Job 再写不生效（不覆盖/不重试）', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)
    await runner.tick() // → succeeded

    // 对已 succeeded 的 Job 再写 failed → 条件不匹配，返回 false，状态不被覆盖
    const overwritten = await persistTerminalState(prisma, jobId, 'failed', 'should-not-stick')
    expect(overwritten).toBe(false)
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('succeeded')
    expect(job.errorMessage).toBeNull()
  })
})

describe('T03 无自动重试（AC6）', () => {
  it('失败 Job 反复 tick 不再执行：generate 调用不增加、状态/消息不变', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort([{ ok: false, errorMessage: 'boom' }])
    const runner = makeRunner(fake)

    await runner.tick()
    await runner.tick()
    await runner.tick()

    expect(fake.calls).toHaveLength(1) // 不自动重试
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe('boom')
  })
})

describe('T03 凭证纪律（AC7）服务端注入、绝不落盘/不混同/不泄漏', () => {
  it('credential 与 input 分离注入；不落盘、不出现在失败消息', async () => {
    const userId = await createUser()
    const prompt = '画一幅星空'
    const key = 'sk-super-secret-xyz'
    const jobId = await seedQueuedJob(prompt, userId)
    const fake = new FakeAutoFigureGenerationPort([{ ok: false, errorMessage: 'quota exceeded' }])
    const runner = makeRunner(fake, { llmKey: key })

    await runner.tick()

    // 分离注入：input 只有 prompt；credential 只有 apiKey（各自独立，不混同）
    expect(fake.calls[0].input).toEqual({ prompt })
    expect(Object.keys(fake.calls[0].input)).toEqual(['prompt'])
    expect(fake.calls[0].credential).toEqual({ apiKey: key })

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe('quota exceeded') // 非敏感
    expect(job.errorMessage).not.toContain(key)

    // 凭证不落盘：Figure/Job 行任一字段都不含 key
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: job.figureId } })
    expect(JSON.stringify(job)).not.toContain(key)
    expect(JSON.stringify(figure)).not.toContain(key)
  })
})

describe('T03 flag 装配门（AC8）', () => {
  it('flag 关 → 不构造 pump（null）；queued 恒不迁移', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()

    const handle = assembleAutoFigureRunner({ prisma, port: fake, llmKey: 'k', enabled: false })
    expect(handle).toBeNull() // 无 pump

    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'queued',
    )
  })

  it('flag 开 → 构造并启动 pump；tick 周期处理 queued Job；close 优雅关闭', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()

    const handle = assembleAutoFigureRunner({ prisma, port: fake, llmKey: 'k', enabled: true })
    expect(handle).not.toBeNull()

    await handle!.runner.tick() // 确定性驱动一个周期
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'succeeded',
    )

    await handle!.close() // 停 pump、等在飞周期（interval unref，不挂进程）
  })
})

describe('T03 start/stop 生命周期', () => {
  it('start 幂等（不重复加 timer）；stop 清理 timer', async () => {
    const siSpy = vi.spyOn(globalThis, 'setInterval')
    const ciSpy = vi.spyOn(globalThis, 'clearInterval')
    try {
      const fake = new FakeAutoFigureGenerationPort()
      const runner = makeRunner(fake)
      runner.start()
      runner.start() // 幂等：第二次不再加 timer
      expect(siSpy).toHaveBeenCalledTimes(1)
      await runner.stop()
      expect(ciSpy).toHaveBeenCalledTimes(1)
    } finally {
      siSpy.mockRestore()
      ciSpy.mockRestore()
    }
  })

  it('stop 中止在飞生成并等待周期 settle（shutdown-driven abort；Job 保持 running 交 reconcile）', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)
    fake.mode = 'pending'

    const entered = fake.generateEntered() // 先注册等待点（避免 resolve 先于 generate 进入）
    const t1 = runner.tick() // claim → 创建 controller → 挂起于 generate
    await entered // generate 已进入（signal 已注册 abort 监听）
    expect(fake.calls[0].signal).toBeDefined()

    const stopP = runner.stop() // shutdown abort：立即 abort 在飞 → pending 即时 reject → 周期 settle
    await stopP // stop 等在飞周期；abort 后即时返回，不等待 T04 timeout
    await t1

    expect(fake.calls[0].signal?.aborted).toBe(true) // 复用同一 AbortController 被 shutdown 触发
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('running') // shutdown abort 不改业务终态（不 running→failed）
    expect(job.finishedAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// T06（docs/autofigure/tickets/T06-artifact-persistence-png.md）：成功产物 + succeeded 终态
// 原子提交 seam（persistSucceededWithArtifacts）。产物提交时机 + 迟到围栏的不变量断言见上：
// 成功测试断言三产物落库、failed 测试断言无产物、T04 迟到成功测试断言产物不写。
// ---------------------------------------------------------------------------

describe('T06 产物原子提交（persistSucceededWithArtifacts seam）', () => {
  it('CAS 命中（running）→ succeeded + 三产物同事务落库，返回 true', async () => {
    const userId = await createUser()
    const jobId = await seedJob('p', userId, { status: 'running' })
    const figureId = (await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).figureId
    const artifacts = okArtifacts()

    const committed = await persistSucceededWithArtifacts(prisma, jobId, figureId, artifacts)
    expect(committed).toBe(true)

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('succeeded')
    expect(job.finishedAt).not.toBeNull()
    expect(job.errorMessage).toBeNull() // 成功态清空 errorMessage（runner 契约）
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: figureId } })
    expect(figure.xml).toBe(artifacts.xml)
    expect(figure.evaluation).toBe(artifacts.evaluation)
    expect(Array.from(figure.png!)).toEqual(Array.from(artifacts.png))
  })

  it('CAS 不命中（Job 已 failed）→ 返回 false，不写任何产物、失败原因不被覆盖', async () => {
    const userId = await createUser()
    const jobId = await seedJob('p', userId, { status: 'failed', errorMessage: '原始失败原因' })
    const figureId = (await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).figureId

    const committed = await persistSucceededWithArtifacts(prisma, jobId, figureId, okArtifacts())
    expect(committed).toBe(false)

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe('原始失败原因') // 迟到成功不覆盖失败原因
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: figureId } })
    expect(figure.xml).toBeNull()
    expect(figure.png).toBeNull()
    expect(figure.evaluation).toBeNull()
  })

  it('产物写入失败 → 事务整体回滚：Job 不转 succeeded（绝不出现「succeeded 但无产物」）', async () => {
    const userId = await createUser()
    const jobId = await seedJob('p', userId, { status: 'running' })

    // figure.update 命中不存在 id → P2025 抛错 → 事务回滚，succeeded 连同回滚
    await expect(persistSucceededWithArtifacts(prisma, jobId, 'no-such-figure', okArtifacts())).rejects.toThrow()
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('running') // 原子性：无「succeeded 但无产物」中间态
  })
})

// ---------------------------------------------------------------------------
// T04（docs/autofigure/tickets/T04-timeout-reconcile-late-result.md）：超时 / 启动 reconcile /
// 迟到结果围栏。全部经 seam 直驱（timeoutRunningJobs/reconcileRunningJobs 注入确定时刻）+ 受控
// pending Port，零真实 wall-clock 等待（AC7：绝不等待真实 30 分钟）。
// ---------------------------------------------------------------------------

describe('T04 超时（AC1/AC2/AC5/AC6）—— 自 running 起算，queued 不计入', () => {
  it('超时自 running（startedAt）起算：超期 running 翻 failed，queued 等待不计入', async () => {
    const userId = await createUser()
    const runningId = await seedJob('r', userId, {
      status: 'running',
      startedAt: new Date(Date.now() - 10_000), // 已 running 10s
    })
    const queuedId = await seedJob('q', userId) // queued，startedAt 恒 null

    // now=实时、timeout=1s → cutoff=now-1s；running 10s 前 start → 超期；queued 永不命中
    const timed = await timeoutRunningJobs(prisma, new Date(), 1_000)
    expect(timed).toBe(1)

    const running = await prisma.generationJob.findUniqueOrThrow({ where: { id: runningId } })
    expect(running.status).toBe('failed')
    expect(running.errorMessage).toBe(JOB_TIMEOUT_REASON)
    expect(running.finishedAt).not.toBeNull()

    const queued = await prisma.generationJob.findUniqueOrThrow({ where: { id: queuedId } })
    expect(queued.status).toBe('queued') // 排队等待不消耗超时
  })

  it('未超期的 running 不被触碰（超时以 startedAt 计，与 createdAt 无关）', async () => {
    const userId = await createUser()
    // 很早创建（createdAt 老）但刚 claim（startedAt 新）→ 不应超时——证明不是从创建时刻起算
    const jobId = await seedJob('p', userId, { status: 'running', startedAt: new Date(Date.now() - 100) })

    const timed = await timeoutRunningJobs(prisma, new Date(), 60_000) // cutoff=now-60s；startedAt 100ms 前 → 未超期
    expect(timed).toBe(0)
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('running')
  })

  it('注入短超时：running 推进过截止 → 确定性 failed（finishedAt 置位 + 稳定原因）', async () => {
    const userId = await createUser()
    const jobId = await seedJob('p', userId, { status: 'running', startedAt: new Date(Date.now() - 2_000) })

    const timed = await timeoutRunningJobs(prisma, new Date(), 1_000) // cutoff=now-1s；startedAt 2s 前 → 超期
    expect(timed).toBe(1)

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.finishedAt).not.toBeNull()
    expect(job.errorMessage).toBe(JOB_TIMEOUT_REASON) // 稳定非敏感超时原因
  })

  it('超时不删除 Figure：超时后 Figure 仍存在且可查询（AC5）', async () => {
    const userId = await createUser()
    const jobId = await seedJob('p', userId, { status: 'running', startedAt: new Date(Date.now() - 2_000) })
    const figureId = (await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).figureId

    await timeoutRunningJobs(prisma, new Date(), 1_000)

    const figure = await prisma.figure.findUnique({ where: { id: figureId } })
    expect(figure).not.toBeNull() // Figure 独立于 Job 终态持续存在
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('failed')
  })

  it('超时 failed 的 Job 不自动重试（AC6）：反复 tick 不重新执行', async () => {
    const userId = await createUser()
    const jobId = await seedJob('p', userId, { status: 'running', startedAt: new Date(Date.now() - 2_000) })
    await timeoutRunningJobs(prisma, new Date(), 1_000)
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('failed')

    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)
    await runner.tick()
    await runner.tick()

    expect(fake.calls).toHaveLength(0) // 已 failed 不再被领取执行
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe(JOB_TIMEOUT_REASON)
  })
})

describe('T04 迟到结果围栏（AC4 关键不变量）—— 终态即终态', () => {
  // 共同布置：queued → tick claim → pending 挂起 → 手动推进超时/reconcile → Port 迟到返回
  async function arrangeRunningPending(jobId: string, fake: FakeAutoFigureGenerationPort): Promise<{
    startedAt: Date
    settle: (result: AutoFigureGenerationResult) => Promise<void>
  }> {
    const runner = makeRunner(fake)
    fake.mode = 'pending'
    const entered = fake.generateEntered()
    const t1 = runner.tick()
    await entered
    const running = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(running.status).toBe('running')
    return {
      startedAt: running.startedAt!,
      settle: async (result) => {
        fake.resolveNext(result)
        await t1
      },
    }
  }

  it('迟到成功被丢弃：超时 failed 后 Port 返回成功 → 不转 succeeded、原因不变', async () => {
    const userId = await createUser()
    const jobId = await seedJob('p', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const { startedAt, settle } = await arrangeRunningPending(jobId, fake)

    // 推进超时：以 startedAt + 超时 的确定时刻驱动 sweeper seam → failed
    await timeoutRunningJobs(prisma, new Date(startedAt.getTime() + 60_000 + 1), 60_000)
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('failed')

    await settle(okArtifacts()) // Port 迟到返回成功（围栏必须丢弃）

    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(after.status).toBe('failed') // failed 不回滚
    expect(after.errorMessage).toBe(JOB_TIMEOUT_REASON) // 迟到成功不覆盖失败原因
    expect(after.finishedAt).not.toBeNull()
    // T06：迟到成功产物被丢弃——Figure 无 xml/png/evaluation，未转 succeeded
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: after.figureId } })
    expect(figure.xml).toBeNull()
    expect(figure.png).toBeNull()
    expect(figure.evaluation).toBeNull()
  })

  it('迟到失败不覆盖终态：超时 failed 后 Port 返回失败 → 原因保持超时原因', async () => {
    const userId = await createUser()
    const jobId = await seedJob('p', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const { startedAt, settle } = await arrangeRunningPending(jobId, fake)

    await timeoutRunningJobs(prisma, new Date(startedAt.getTime() + 60_000 + 1), 60_000)
    await settle({ ok: false, errorMessage: 'provider boom' }) // 迟到失败

    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(after.status).toBe('failed')
    expect(after.errorMessage).toBe(JOB_TIMEOUT_REASON) // 迟到失败不覆盖终态原因
  })

  it('reconcile 竞态同样被围栏：running 被 reconcile 翻 failed 后迟到成功被丢弃', async () => {
    const userId = await createUser()
    const jobId = await seedJob('p', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const { settle } = await arrangeRunningPending(jobId, fake)

    const reconciled = await reconcileRunningJobs(prisma) // 并发/启动对账翻转
    expect(reconciled).toBe(1)
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('failed')

    await settle(okArtifacts()) // 迟到成功被丢弃

    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(after.status).toBe('failed')
    expect(after.errorMessage).toBe(JOB_RECONCILE_REASON)
    // T06：reconcile 竞态下迟到成功同样不落产物
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: after.figureId } })
    expect(figure.xml).toBeNull()
    expect(figure.png).toBeNull()
    expect(figure.evaluation).toBeNull()
  })
})

describe('T04 启动 reconcile（AC3）—— 只对账遗留 running，幂等', () => {
  it('启动对账：遗留 running → failed（稳定 reconcile 原因 + finishedAt），孤儿不被重新执行', async () => {
    const userId = await createUser()
    const jobId = await seedJob('orphan', userId, { status: 'running', startedAt: new Date(Date.now() - 5_000) })
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)

    await runner.tick() // 首周期先 reconcile 再找 queued

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe(JOB_RECONCILE_REASON)
    expect(job.finishedAt).not.toBeNull()
    expect(fake.calls).toHaveLength(0) // 孤儿 running 从不被本进程执行（只对账）
  })

  it('reconcile 保留 queued 不变', async () => {
    const userId = await createUser()
    const jobId = await seedJob('q', userId)
    const count = await reconcileRunningJobs(prisma)
    expect(count).toBe(0)
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('queued')
  })

  it('reconcile 保留 succeeded/failed 终态不变', async () => {
    const userId = await createUser()
    const now = new Date()
    const okId = await seedJob('ok', userId, { status: 'succeeded', startedAt: now, finishedAt: now })
    const badId = await seedJob('bad', userId, { status: 'failed', errorMessage: '原始失败原因' })

    const count = await reconcileRunningJobs(prisma)
    expect(count).toBe(0)

    const ok = await prisma.generationJob.findUniqueOrThrow({ where: { id: okId } })
    expect(ok.status).toBe('succeeded')
    expect(ok.finishedAt).not.toBeNull() // 终态时间不被触碰
    const bad = await prisma.generationJob.findUniqueOrThrow({ where: { id: badId } })
    expect(bad.status).toBe('failed')
    expect(bad.errorMessage).toBe('原始失败原因') // 不被 reconcile 原因覆盖
  })

  it('reconcile 幂等：重复执行 count=0、状态不变', async () => {
    const userId = await createUser()
    const jobId = await seedJob('p', userId, { status: 'running' })

    const first = await reconcileRunningJobs(prisma)
    expect(first).toBe(1)
    const second = await reconcileRunningJobs(prisma)
    expect(second).toBe(0) // 幂等：无再可对账的 running

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toBe(JOB_RECONCILE_REASON)
  })

  it('重启/reconcile 不产生重复执行：孤儿对账 + queued 恰一次生成', async () => {
    const userId = await createUser()
    const orphanId = await seedJob('orphan', userId, { status: 'running', startedAt: new Date(Date.now() - 5_000) })
    const queuedId = await seedJob('queued', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)

    await runner.tick() // reconcile 孤儿 → failed；处理 queued → succeeded（generate 恰一次）
    await runner.tick() // 再 tick：孤儿已 failed / queued 已 succeeded，均不重跑

    expect(fake.calls).toHaveLength(1) // 只生成 queued 一次
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: orphanId } })).status).toBe('failed')
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: queuedId } })).status).toBe('succeeded')
  })
})

describe('T04 sweeper 装配 + 无 running→queued 回迁', () => {
  it('timeoutMs>0 时 start() 装配 sweeper interval；=0 时不装配（pump 仅一个）', async () => {
    const siSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      const withTimeout = makeRunner(new FakeAutoFigureGenerationPort(), {
        timeoutMs: 50,
        timeoutSweepIntervalMs: 10,
      })
      withTimeout.start()
      expect(siSpy).toHaveBeenCalledTimes(2) // pump + sweeper
      await withTimeout.stop()

      const without = makeRunner(new FakeAutoFigureGenerationPort(), { timeoutMs: 0 })
      without.start()
      expect(siSpy).toHaveBeenCalledTimes(3) // 仅 +1 pump
      await without.stop()
    } finally {
      siSpy.mockRestore()
    }
  })

  it('不存在 running→queued 回迁：状态机守卫拒绝', () => {
    expect(() => assertLegalTransition('running', 'queued')).toThrow(/非法 GenerationJob 状态转换/)
    expect(() => assertLegalTransition('failed', 'queued')).toThrow(/非法 GenerationJob 状态转换/)
  })
})

// ---------------------------------------------------------------------------
// T07 已批准扩 Scope（docs/autofigure/tickets/T07-autofigure-http-adapter.md · 风险 A）：
// T04 应用超时驱动 abort 在飞外部执行——解 pump 卡死（半开网络 fetch 永 不 settle）+ 防 shutdown
// 挂起。runner 不新增超时契约/错误态/重试（V1 唯一 execution timeout 仍是 timeoutMs）；只把
// AbortController signal 透传 Port，超时中止后归一 JOB_TIMEOUT_REASON（T05 白名单单源）。
// 零 wall-clock：vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) 只接管 abort timer，
// Date/interval 保持真实（不干扰 Prisma/better-sqlite3 时间戳）。
// ---------------------------------------------------------------------------

describe('T07 扩 Scope：T04 应用超时 abort 在飞生成（解 pump 卡死 / 防 shutdown 挂起）', () => {
  it('挂起生成在 timeoutMs 触发后被 abort → failed + JOB_TIMEOUT_REASON；后续 queued 下一周期串行处理', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const userId = await createUser()
      const jobA = await seedQueuedJob('a', userId)
      const jobB = await seedQueuedJob('b', userId)
      const fake = new FakeAutoFigureGenerationPort()
      const runner = makeRunner(fake, { timeoutMs: 5000 })
      fake.mode = 'pending'

      const entered = fake.generateEntered()
      const t1 = runner.tick() // A：claim → 创建 abort timer(5000ms) → 挂起于 generate
      await entered
      expect(fake.calls[0].signal).toBeDefined() // runner 把 T04 超时 signal 透传给 Port

      await vi.advanceTimersByTimeAsync(5000) // 触发 abort → fake reject(AbortError) → runOne 归一
      await t1

      // A：failed + 稳定超时原因（非「传输层异常」；T05 白名单单源，Public API 可展示）
      const a = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobA } })
      expect(a.status).toBe('failed')
      expect(a.errorMessage).toBe(JOB_TIMEOUT_REASON)
      expect(a.finishedAt).not.toBeNull()

      // B 未被重叠执行（concurrency=1）；abort 解卡后下一周期串行处理
      expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobB } })).status).toBe(
        'queued',
      )
      fake.mode = 'auto'
      await runner.tick()
      expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobB } })).status).toBe(
        'succeeded',
      )
      expect(fake.calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('timeoutMs=0（关闭超时）时 signal 仍透传（shutdown 取消能力不依赖 timeout policy）→ 正常成功', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('p', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake, { timeoutMs: 0 })
    await runner.tick()
    expect(fake.calls[0].signal).toBeDefined() // runner 恒持有 controller（shutdown 可取消在飞）
    expect(fake.calls[0].signal?.aborted).toBe(false) // timeoutMs=0 → 无 timer，正常路径不中止
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'succeeded',
    )
  })
})

// ---------------------------------------------------------------------------
// T07 shutdown-driven abort（已批准扩 Scope · 风险 A 受控补全）：
// runner.stop() 不得因无响应 sidecar 等待到 AUTOFIGURE_JOB_TIMEOUT_MS（默认 30min）。
// 复用同一 AbortController：T04 超时 与 shutdown 是同一个 controller 的两个触发源，不建第二套
// 取消抽象；stop() 不改 Job 业务终态（running 交由下次 startup 的 T04 reconcile）。对应实现约束
// 3/4/5/6 的确定性测试 A–G（F 由上方「timeoutMs 触发 abort」用例承担，此处补聚焦复核）。
// ---------------------------------------------------------------------------

describe('T07 shutdown-driven abort（stop() 不等待 application timeout；不改业务终态）', () => {
  it('A. 挂起 fetch → stop() 立即 abort → signal.aborted=true → 周期即时 settle，不等待 30min timeout', async () => {
    // 30min timer 在 fake timers 下永不自燃：若 stop() 依赖 timeout 到点，await 将永不 resolve → 测试
    // 超时失败。resolve 即证明 shutdown 走 abort、不等待 application timeout。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const userId = await createUser()
      const jobId = await seedQueuedJob('p', userId)
      const fake = new FakeAutoFigureGenerationPort()
      const runner = makeRunner(fake, { timeoutMs: 30 * 60 * 1000 }) // 30min = 生产默认
      fake.mode = 'pending'

      const entered = fake.generateEntered()
      const t1 = runner.tick()
      await entered
      expect(fake.calls[0].signal).toBeDefined()

      const stopP = runner.stop() // shutdown abort
      await stopP
      await t1

      expect(fake.calls[0].signal?.aborted).toBe(true)
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
      expect(job.status).toBe('running') // shutdown 不改业务终态
      expect(job.finishedAt).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('B. idle 状态 stop() → 即时 resolve（无在飞周期、无 abort）', async () => {
    const runner = makeRunner(new FakeAutoFigureGenerationPort())
    await expect(runner.stop()).resolves.toBeUndefined()
  })

  it('C. stop() 连续两次 → 幂等、无错', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('p', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)
    fake.mode = 'pending'

    const entered = fake.generateEntered()
    const t1 = runner.tick()
    await entered

    const stop1 = runner.stop()
    const stop2 = runner.stop() // 并发二次 stop：共享同一 currentTick/controller，幂等
    await Promise.all([stop1, stop2])
    await t1
    await runner.stop() // 第三次（前两次已完成）：timer/controller/tick 均已清理，即时返回

    expect(fake.calls[0].signal?.aborted).toBe(true)
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('running') // 并发 stop 不改业务终态
  })

  it('D. stop() 后 tick() 不再领取新的 queued Job', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('p', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)

    await runner.stop()
    await runner.tick() // stopping 闩：no-op

    expect(fake.calls).toHaveLength(0) // 未领取未生成
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('queued') // 恒不迁移
  })

  it('E. shutdown abort 不自行 running→failed；模拟新进程 startup reconcile 后才终态化', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('p', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)
    fake.mode = 'pending'

    const entered = fake.generateEntered()
    const t1 = runner.tick()
    await entered
    await runner.stop()
    await t1

    const during = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(during.status).toBe('running') // shutdown 期间 Job 保持 running（无 stop() 内 running→failed）

    // 模拟新进程 startup：T04 reconcile 是 crash/restart interruption 的唯一事实语义
    const reconciled = await reconcileRunningJobs(prisma)
    expect(reconciled).toBe(1)
    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(after.status).toBe('failed')
    expect(after.errorMessage).toBe(JOB_RECONCILE_REASON)
    expect(after.finishedAt).not.toBeNull()
  })

  it('F. 普通 T04 timeout 路径仍：running→failed + abort，reason 恒为 TIMEOUT（不被 AbortError 覆盖）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const userId = await createUser()
      const jobId = await seedQueuedJob('p', userId)
      const fake = new FakeAutoFigureGenerationPort()
      const runner = makeRunner(fake, { timeoutMs: 5000 })
      fake.mode = 'pending'

      const entered = fake.generateEntered()
      const t1 = runner.tick()
      await entered
      await vi.advanceTimersByTimeAsync(5000) // timeout 触发 abort → fake reject(AbortError)
      await t1

      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
      expect(job.status).toBe('failed')
      expect(job.errorMessage).toBe(JOB_TIMEOUT_REASON) // 不被 AbortError/传输异常覆盖
      expect(job.errorMessage).not.toBe(GENERATION_EXECUTION_ERROR)
      expect(job.finishedAt).not.toBeNull()
      expect(fake.calls[0].signal?.aborted).toBe(true) // timeout 同样走 abort（同一 controller）
    } finally {
      vi.useRealTimers()
    }
  })

  it('G. late-result fencing 仍通过：超时先翻 failed 后，shutdown abort 不覆盖终态、迟到产物丢弃', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('p', userId)
    const fake = new FakeAutoFigureGenerationPort()
    const runner = makeRunner(fake)
    fake.mode = 'pending'

    const entered = fake.generateEntered()
    const t1 = runner.tick()
    await entered
    const running = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    const startedAt = running.startedAt!

    // 超时 sweeper 先翻转（确定时刻驱动 seam）→ failed + TIMEOUT（终态固化）
    await timeoutRunningJobs(prisma, new Date(startedAt.getTime() + 60_000 + 1), 60_000)
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'failed',
    )

    // 此刻 shutdown 到达：stop() 中止仍在 pending 的 generate → runOne 见 stopping 返回（不写终态）
    await runner.stop()
    await t1

    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(after.status).toBe('failed') // 终态不被 shutdown 触碰
    expect(after.errorMessage).toBe(JOB_TIMEOUT_REASON) // 原因不被 AbortError/停止覆盖
    expect(after.finishedAt).not.toBeNull()

    // fake port honor abort：stop() 中止时 promise 已 settle（无悬挂 pending → 无 unhandled
    // rejection），不存在「shutdown 后再 resolve 的成功」可落——终态与产物保持冻结。「迟到结果
    // 围栏」由既有 T04 迟到测试覆盖；此处仅确认 shutdown 路径不引入任何新状态转换、不发布产物。
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: after.figureId } })
    expect(figure.png).toBeNull()
    expect(figure.xml).toBeNull()
  })
})
