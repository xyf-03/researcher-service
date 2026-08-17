// T10（docs/autofigure/tickets/T10-dev-sidecar-smoke.md）——dev 真实 AutoFigure 生成 smoke。
//
// 门控（用户批准三条件，smokeGating.ts）：Docker available + AUTOFIGURE_SMOKE==='1' +
// AUTOFIGURE_LLM_KEY 非空 → 真跑；缺任一 → describe.skipIf 整套跳过，常规套件不依赖真实
// key/daemon/sidecar。门控**不含**宿主侧 AUTOFIGURE_SIDECAR_URL（compose 已供 server 容器内默认
// http://autofigure:8080，部署形态见 deploy/docker-compose.dev.yml）。
//
// sidecar 可达（对齐 containers-smoke 模式：宿主 vitest + 真实 daemon + 真实容器编排）：
//   测试经 dockerode 自建一个 sidecar 容器到默认 bridge——**无 -p 端口发布**（AC2「sidecar 无宿主
//   端口暴露」保持），宿主经容器 bridge IP 访问其内部 8080。显式设 AUTOFIGURE_SIDECAR_URL 可跳过
//   编排、复用既有可达 sidecar（灵活路径，非默认）。镜像 autofigure-sidecar:dev 缺失 → 明确报错
//   提示先 build（本地 build 镜像不在 registry，绝不 pull）。
//
// 走真实公开 API 全链（preflight 结论：直接调 /v1/generate 不算 T10 smoke）：
//   bootstrap B1（空表建 admin + 日志临时密码）→ login → password/change（C1 改密）→ 二次 login
//   → POST /api/v1/figures（Idempotency-Key）→ 轮询 GET /:id 应用级状态 → succeeded →
//   GET /:id/png 原生 PNG 字节（签名校验）。runner 为真实装配（assembleAutoFigureRunner + 真实
//   HttpAutoFigureGenerationPort），生成经真实 sidecar 容器。
//
// 超时双层（用户修正 point 3）：应用执行超时 AUTOFIGURE_SMOKE_TIMEOUT_MS 传给真实 runner
//（默认 600000 = nginx /api/ 代理 300s×2 余量，T10 实施选择；非生产默认，生产 compose 默认
// 1800000 不变）；vitest/polling 截止独立（pollDeadline = 应用超时 + 60s），smoke 不等待真实 30min。
// 不引入第二 timeout 契约——生产唯一执行超时仍是 AUTOFIGURE_JOB_TIMEOUT_MS。
//
// 认证来源复用既有 bootstrap dev 凭据（用户修正 point 2）：不预置/硬编码 admin 密码、不加
// bypass-auth 路由、不加 smoke-only 后门、不发明仓库未提供的凭证。下方 C1 目标密码
// 'smoke-c1-2026-pw' 是测试内自设的 throwaway 值（smoke 专属临时 DB），非仓库交付的预置凭据。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Docker from 'dockerode'
import { bootstrap } from '../src/auth/bootstrap'
import { config } from '../src/config'
import { assembleAutoFigureRunner, type AutoFigureRunnerHandle } from '../src/figures/runner'
import { HttpAutoFigureGenerationPort } from '../src/figures/httpPort'
import { autofigureSmokeGate } from './smokeGating'
import { setupTestApp, type TestContext } from './setup'
import { login, bearer } from './helpers'

// 本地 build 镜像（T08 交付，compose build autofigure / docker build deploy/autofigure-sidecar）。
const SIDECAR_IMAGE = 'autofigure-sidecar:dev'
// sidecar 容器内固定端口（gunicorn bind 8080，T08 行动项「T10 接线对齐」）；无宿主端口发布。
const SIDECAR_PORT = 8080

// 应用执行超时（ms）：传给真实 runner；非法/空串回退默认（空串陷阱同 config：Number('')=0）。
function readSmokeTimeoutMs(): number {
  const raw = process.env.AUTOFIGURE_SMOKE_TIMEOUT_MS
  if (raw !== undefined && raw !== '' && Number.isInteger(Number(raw)) && Number(raw) > 0) {
    return Number(raw)
  }
  return 600_000
}
const smokeTimeoutMs = readSmokeTimeoutMs()
// vitest/polling 截止（独立于应用执行超时）：应用超时 + 60s 余量。仅限本 smoke 的轮询截止，
// 不构成生产 timeout 契约。
const pollDeadlineMs = smokeTimeoutMs + 60_000

// 门控在收集期同步求值（probeDockerAvailable 同步 execFileSync + env 读取）。
const smokeGate = autofigureSmokeGate()

// 真实生成 prompt：sidecar 契约 1-4000 字符；简单图表描述（真实 LLM 调用）。
const SMOKE_PROMPT =
  'A simple horizontal bar chart comparing quarterly revenue: Q1 120, Q2 150, Q3 135, Q4 190'

// 轮询步进（真实生成可达分钟级；非假百分比，只消费应用级状态）。
const POLL_STEP_MS = 1000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ---- sidecar 容器编排（宿主 dockerode，无 -p 端口发布）----
let sidecar: Docker.Container | undefined

// 镜像缺失 → 明确报错（dev 镜像非 registry，绝不 pull；构建归 T08/compose）。
// 区分「镜像不存在」（statusCode 404）vs「daemon 连接失败」（网络/socket 错误）——后者误报
// 镜像缺失会误导排查（门控已探测过 daemon，此处兜底连接错误仍给可操作提示）。
async function ensureSidecarImage(docker: Docker): Promise<void> {
  try {
    await docker.getImage(SIDECAR_IMAGE).inspect()
  } catch (e) {
    const err = e as { statusCode?: number; code?: string }
    if (err.statusCode === 404 || /not found/i.test(String(e))) {
      throw new Error(
        `[smoke] sidecar 镜像 ${SIDECAR_IMAGE} 缺失——先构建：docker compose -f deploy/docker-compose.dev.yml build autofigure` +
          `（或 docker build deploy/autofigure-sidecar）`,
      )
    }
    throw new Error(
      `[smoke] 无法连接 docker daemon（编排 sidecar 前置）：${String(e).split('\n')[0] ?? e}`,
    )
  }
}

async function startSidecar(docker: Docker): Promise<string> {
  const name = `autofigure-smoke-${process.pid}-${Date.now()}`
  const container = await docker.createContainer({
    Image: SIDECAR_IMAGE,
    name,
    // 无 PortBindings → 无宿主端口发布（AC2）；宿主经 bridge IP 访问容器内 8080。
    HostConfig: { NetworkMode: 'bridge' },
    ExposedPorts: { [`${SIDECAR_PORT}/tcp`]: {} },
  })
  sidecar = container
  await container.start()
  // bridge IP 在 NetworkSettings.Networks（dockerode 类型已把 IPAddress 收进 Networks，顶层无）。
  const settings = (await container.inspect()).NetworkSettings
  const nets = settings?.Networks
  const ip = nets?.bridge?.IPAddress ?? (nets ? Object.values(nets)[0]?.IPAddress : undefined)
  if (!ip) throw new Error('[smoke] sidecar 容器无 bridge IP')
  const url = `http://${ip}:${SIDECAR_PORT}`
  // 等 /health 就绪（无域信息/凭证的存活性探测）。
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`${url}/health`)).ok
    } catch {
      /* 未就绪，下一轮 */
    }
    if (!up) await new Promise((r) => setTimeout(r, 500))
  }
  if (!up) throw new Error(`[smoke] sidecar /health 未就绪（${url}）`)
  return url
}

describe.skipIf(!smokeGate)(
  'T10 dev 真实 AutoFigure 生成 smoke（门控：docker 可用 + AUTOFIGURE_SMOKE=1 + key 非空）',
  () => {
    let ctx: TestContext
    let handle: AutoFigureRunnerHandle | null
    let access: string
    let sidecarUrl: string

    beforeAll(async () => {
      // sidecar 可达地址：显式 AUTOFIGURE_SIDECAR_URL（复用既有可达 sidecar）→ 直接用；
      // 否则编排容器到 bridge 自供（无 -p 发布）。门控不含 URL，二者均满足 point 1。
      const explicit = process.env.AUTOFIGURE_SIDECAR_URL?.trim()
      if (explicit) {
        sidecarUrl = explicit
      } else {
        const docker = new Docker()
        await ensureSidecarImage(docker)
        sidecarUrl = await startSidecar(docker)
      }

      // 捕获 bootstrap B1 临时密码日志（明文仅此一次；复用既有机制，不发明凭据）。
      const logs: string[] = []
      const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      })
      ctx = await setupTestApp({ figures: {} }) // 空 users 表（bootstrap 前提）
      try {
        await bootstrap(ctx.prisma) // B1：空表建 admin + 打印临时密码
      } finally {
        spy.mockRestore()
      }
      const match = logs.join('\n').match(/临时密码: (\S+)/)
      if (!match) throw new Error('[smoke] bootstrap 未输出临时密码（B1 明文密码日志缺失）')
      const tempPassword = match[1]
      const username = config.bootstrapAdminUsername // 与 bootstrap 同一源，不硬编码 'admin'

      // C1 改密流程：login（mustChangePassword=true）→ password/change → 二次 login。
      const lg1 = await login(ctx.request, username, tempPassword)
      if (!lg1.access || lg1.body?.data?.mustChangePassword !== true) {
        throw new Error('[smoke] bootstrap 账号须处于 mustChangePassword 态（C1 未拦截）')
      }
      const newPassword = 'smoke-c1-2026-pw'
      const change = await ctx.request
        .post('/api/v1/auth/password/change')
        .set(bearer(lg1.access))
        .send({ oldPassword: tempPassword, newPassword })
      if (change.body.code !== 0) {
        throw new Error(`[smoke] password/change 失败: ${change.body.message ?? change.body.code}`)
      }
      const lg2 = await login(ctx.request, username, newPassword)
      if (!lg2.access) throw new Error('[smoke] 改密后二次登录失败（C1 未解除）')
      access = lg2.access

      // 真实 runner 装配（pump 消费 queued → 真实 HttpPort → 真实 sidecar → DB 终态）。
      handle = assembleAutoFigureRunner({
        enabled: true,
        prisma: ctx.prisma,
        port: new HttpAutoFigureGenerationPort({ baseUrl: sidecarUrl }),
        llmKey: process.env.AUTOFIGURE_LLM_KEY ?? '',
        timeoutMs: smokeTimeoutMs,
        pollIntervalMs: 1000,
      })
    })

    afterAll(async () => {
      if (handle) await handle.close() // 停 pump + abort 在飞周期（runner.stop 不写业务终态）
      if (ctx) await ctx.cleanup()
      if (sidecar) {
        try {
          await sidecar.remove({ force: true }) // 幂等清理（beforeAll 半途失败也回收）
        } catch {
          /* 容器已不在：幂等 */
        }
      }
    })

    it(
      'submit → queued → running → succeeded → PNG 字节（真实公开 API 全链）',
      { timeout: pollDeadlineMs + 30_000 },
      async () => {
        // 提交（幂等键 + 认证身份；真实公开 API，非直接调 sidecar）。
        const key = randomUUID()
        const created = await ctx.request
          .post('/api/v1/figures')
          .set(bearer(access))
          .set('Idempotency-Key', key)
          .send({ prompt: SMOKE_PROMPT })
        expect(created.body.code).toBe(0)
        const figureId = created.body.data.figureId as string
        expect(created.body.data.status).toBe('queued')

        // 轮询应用级状态（queued → running → succeeded | failed）；截止独立于应用执行超时。
        const deadline = Date.now() + pollDeadlineMs
        let status = created.body.data.status as string
        while (status === 'queued' || status === 'running') {
          if (Date.now() > deadline) {
            throw new Error(`[smoke] 轮询截止（${pollDeadlineMs}ms）未达终态，最近状态=${status}`)
          }
          await new Promise((r) => setTimeout(r, POLL_STEP_MS))
          const d = await ctx.request.get(`/api/v1/figures/${figureId}`).set(bearer(access))
          expect(d.body.code).toBe(0)
          status = d.body.data.status as string
        }
        expect(status).toBe('succeeded') // 失败面（failed）携带稳定非敏感原因，但不满足本 AC

        // PNG 字节（成功路径豁免 #312 信封：原生 image/png，非 base64-in-JSON）。
        const png = await ctx.request.get(`/api/v1/figures/${figureId}/png`).set(bearer(access))
        expect(png.status).toBe(200)
        expect(png.headers['content-type']).toMatch(/^image\/png/)
        expect(Buffer.isBuffer(png.body)).toBe(true)
        expect(png.body.subarray(0, 8)).toEqual(PNG_SIGNATURE)
      },
    )
  },
)
