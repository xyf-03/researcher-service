// T07 装配测试（docs/autofigure/tickets/T07-autofigure-http-adapter.md）——
// assembleAutoFigureRuntime（server.ts 生产接线的最小测试面，对齐 fleetAssembly 先例）。
//
// 验收（T07 测试清单 #11-#14）：
//   - flag 关 → null：不构造 adapter、不启动 runner（createRunner 不被调用）、queued 恒不迁移。
//   - flag 开 → 构造 HttpAutoFigureGenerationPort + 调 assembleAutoFigureRunner；timeoutMs 显式
//     透传（T04 应用超时是 T07 唯一 execution timeout）。
//   - flag 开 + 空 sidecarUrl → 装配期 fail-fast（adapter 构造抛错，不拖到首请求）。
//   - 端到端 enabled：注入 fetchImpl 替身 → sidecar 成功/失败分别归一为 succeeded+产物 / failed+
//     GENERATION_EXECUTION_ERROR（白名单原因）。
//   - 返回 handle 原样透传（供 server.ts 优雅关闭 await close）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { assembleAutoFigureRuntime } from '../src/figures/assembly'
import { HttpAutoFigureGenerationPort, type FetchImpl } from '../src/figures/httpPort'
import {
  GENERATION_EXECUTION_ERROR,
  type AutoFigureRunnerAssembleDeps,
  type AutoFigureRunnerHandle,
} from '../src/figures/runner'

// 临时库建表源（与 figuresRunner.test.ts 同源：better-sqlite3 直读 init.sql，不经 prisma CLI）。
const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')

const SIDECAR_URL = 'http://autofigure:8796'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])

let prisma: PrismaClient
let seedSeq = 0

beforeEach(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), `figures-assembly-${process.pid}-`))
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
    data: { username: `assembly-u-${seedSeq++}`, passwordHash: 'x' },
  })
  return u.id
}

async function seedQueuedJob(prompt: string, userId: string): Promise<string> {
  const figure = await prisma.figure.create({
    data: { ownerId: userId, prompt, idempotencyKey: `assembly-key-${seedSeq++}` },
  })
  const job = await prisma.generationJob.create({ data: { figureId: figure.id } })
  return job.id
}

// fetchImpl 替身：捕获传输并返回 handler 决定的 fake 响应/抛错。
function makeFetch(
  handler: (url: string, init: RequestInit | undefined) => Promise<unknown>,
): { fetchImpl: FetchImpl; calls: () => Array<{ url: string; init: RequestInit | undefined }> } {
  const recorded: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    const u = url as string
    const i = init as RequestInit | undefined
    recorded.push({ url: u, init: i })
    return handler(u, i)
  }) as unknown as FetchImpl
  return { fetchImpl, calls: () => recorded }
}

function fakeResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  }
}

function baseDeps(overrides: Partial<Parameters<typeof assembleAutoFigureRuntime>[0]> = {}) {
  return {
    enabled: true,
    prisma,
    sidecarUrl: SIDECAR_URL,
    llmKey: 'sk-assembly-secret',
    jobTimeoutMs: 5000,
    ...overrides,
  }
}

describe('assembleAutoFigureRuntime（T07 生产接线）', () => {
  it('flag 关 → null：不构造 adapter、不启动 runner、queued 恒不迁移', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const createRunner = vi.fn()
    const handle = assembleAutoFigureRuntime(
      baseDeps({ enabled: false, createRunner: createRunner as never }),
    )
    expect(handle).toBeNull()
    expect(createRunner).not.toHaveBeenCalled() // 不构造 adapter、不启动 runner
    expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(
      'queued',
    )
  })

  it('flag 开 → 调 assembleAutoFigureRunner：timeoutMs 显式透传 + adapter 是生产实现', async () => {
    const createRunner = vi.fn(
      (_deps: AutoFigureRunnerAssembleDeps) =>
        ({ runner: {}, close: async () => {} }) as AutoFigureRunnerHandle,
    )
    const handle = assembleAutoFigureRuntime(baseDeps({ createRunner: createRunner as never }))
    expect(handle).not.toBeNull()
    expect(createRunner).toHaveBeenCalledTimes(1)
    const args = createRunner.mock.calls[0][0]
    expect(args.enabled).toBe(true)
    expect(args.prisma).toBe(prisma)
    expect(args.llmKey).toBe('sk-assembly-secret')
    expect(args.timeoutMs).toBe(5000) // T04 jobTimeoutMs 显式透传（runner 默认 0=关）
    expect(args.port).toBeInstanceOf(HttpAutoFigureGenerationPort)
  })

  it('flag 开 + 空 sidecarUrl → 装配期 fail-fast（adapter 构造抛错，不拖到首请求）', () => {
    expect(() =>
      assembleAutoFigureRuntime(baseDeps({ sidecarUrl: '', createRunner: vi.fn() as never })),
    ).toThrow(/AUTOFIGURE_SIDECAR_URL/)
  })

  it('返回 handle 原样透传（server.ts 优雅关闭 await close 的对接面）', async () => {
    const stub = { runner: {}, close: async () => {} } as AutoFigureRunnerHandle
    const createRunner = vi.fn(() => stub)
    const handle = assembleAutoFigureRuntime(baseDeps({ createRunner: createRunner as never }))
    expect(handle).toBe(stub)
  })

  it('端到端 enabled + sidecar 成功：tick → succeeded，产物（含 png 解码字节）原子落库', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('画一幅星空麦田', userId)
    const { fetchImpl, calls } = makeFetch(async () =>
      fakeResponse({
        ok: true,
        xml: '<mxfile><diagram/></mxfile>',
        png_base64: Buffer.from(PNG_BYTES).toString('base64'),
        evaluation: '{"ok":true}',
      }),
    )
    const handle = assembleAutoFigureRuntime(baseDeps({ fetchImpl }))!
    expect(handle).not.toBeNull()
    await handle.runner.tick()

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('succeeded')
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: job.figureId } })
    expect(figure.xml).toBe('<mxfile><diagram/></mxfile>')
    expect(figure.evaluation).toBe('{"ok":true}')
    expect(Array.from(figure.png!)).toEqual(Array.from(PNG_BYTES)) // png_base64 边界 decode 回字节
    // 传输恰好一次、打到 sidecar 端点（无重试）
    expect(calls()).toHaveLength(1)
    expect(calls()[0].url).toBe(`${SIDECAR_URL}/v1/generate`)

    await handle.close() // 优雅关闭（停 pump；T03 close 语义）
  })

  it('端到端 enabled + sidecar 失败（非 2xx）→ tick → failed + 白名单稳定原因', async () => {
    const userId = await createUser()
    const jobId = await seedQueuedJob('prompt', userId)
    const { fetchImpl } = makeFetch(async () =>
      fakeResponse({ ok: false, error: 'boom' }, { ok: false, status: 500 }),
    )
    const handle = assembleAutoFigureRuntime(baseDeps({ fetchImpl }))!
    await handle.runner.tick()

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.status).toBe('failed')
    // adapter 归一稳定非敏感原因（T05 白名单）：raw provider 文本绝不到达 errorMessage
    expect(job.errorMessage).toBe(GENERATION_EXECUTION_ERROR)
    const figure = await prisma.figure.findUniqueOrThrow({ where: { id: job.figureId } })
    expect(figure.png).toBeNull() // 失败无产物

    await handle.close()
  })
})
