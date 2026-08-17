// #371-5 门控集成 smoke（真网关配对闭环实测，issue #378）。
// 在真容器网关（默认官方基线，见下方 IMAGE；派生镜像内容与配对协议无关）上验证 ADR 0006 遗留实测项①：
// 浏览器无 token + bootstrap 首连 → 网关 PAIRING_REQUIRED{requestId} → 后端 approve（容器内
// docker exec `openclaw devices approve`）→ 重连 → hello-ok 下发 deviceToken → 后续连接用
// deviceToken 直接通（无再次配对）。
//
// 不再只靠 fake 网关（tunnelProtocol.test.ts 只验证 bootstrap 首连 → hello-ok）：此处用真容器，
// 断言真网关对未配对设备的 PAIRING_REQUIRED 行为（requestId 嵌套位置、错误形态）与前端
// readPairingConnectErrorDetails 断言一致。
//
// **必须真跑，无 skip 门控**（对齐 containers-smoke codex PR#346）：daemon 不可达或镜像不可获取
// → 套件失败，绝不静默跳过。需 env：OPENCLAW_TEMPLATE_DIR（home 模板源）/ LLM_API_KEY（可 dummy）。
//
// 浏览器侧用官方 `GatewayBrowserDeviceAuthLifecycle`（#371 实现决策：配对生命周期归官方包，
// 面板只供身份/tokenStore 回调），与前端 gatewayChat 同源——smoke 实测官方 lifecycle 对真网关
// 的 buildPlan（token/deviceToken 选择）与 acceptHello（deviceToken 持久化）行为。
//
// **真网关实测发现（本文件 buildConnectPlan 的适配依据）**：
//   1. WS connect 须带 Origin header 且在 gateway.controlUi.allowedOrigins 内（默认 seed
//      http://127.0.0.1:18789），否则 CONTROL_UI_ORIGIN_NOT_ALLOWED 拒连。面板 origin 来自配置
//      （config.fleet.panelOrigin，#386 本文件与生产装配同源），#385 起 ConfigRenderer 已把该值
//      自动强制进容器 openclaw.json（本文件 beforeAll 断言 allowedOrigins 含该值）。
//   2. 首连 auth 必须用 `token` 字段（值 = GATEWAY_TOKEN，即 bootstrap-token 端点发放的凭证）；
//      `bootstrapToken` 字段在 2026.7.1 网关被当「setup code」→ AUTH_BOOTSTRAP_TOKEN_INVALID。
//      官方 gateway-client 2026.7.2-beta.6 的 lifecycle 首连输出 bootstrapToken 字段（面向
//      2026.7.2 网关），与 2026.7.1 不兼容——故 buildConnectPlan 首连传 `token` 参数适配。
//      **本 changeset 已同步适配前端**：gatewayChat buildConnectPlan 改传 token 参数（首连）
//      + hasStoredDeviceTokenFor 判断（重连 deviceToken），见 frontend/src/chat/{gatewayChat,deviceAuth}.ts。
//   3. 容器 openclaw.json 须含 gateway.mode=local（缺省进 setup 向导 exit 78「Missing config」；
//      生产模板 deploy/openclaw.json 已含，containers-smoke 简模板未覆盖此检查）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { generateKeyPairSync, createHash, sign as ed25519Sign } from 'node:crypto'
import supertest from 'supertest'
import { WebSocket } from 'ws'
// 官方 gateway-client / gateway-protocol 为 ESM-only 包：server node10 moduleResolution 拿不到
// .mts 类型（TS2307）。@ts-expect-error 须紧邻 import 单行才生效（TS2307 定位在 from 行；
// tunnelProtocol.test.ts 同款）。vitest 运行时经 exports import 条件正常加载。
// @ts-expect-error
import { GatewayProtocolClient, GatewayProtocolRequestError, GatewayBrowserDeviceAuthLifecycle, shouldPauseGatewayReconnect } from '@openclaw/gateway-client/browser'
// @ts-expect-error
import { readPairingConnectErrorDetails } from '@openclaw/gateway-protocol/connect-error-details'
import { setupTestApp, type TestContext } from './setup'
import { seedUser, login, bearer } from './helpers'
import { FleetDeps } from '../src/containers/deps'
import { Orchestrator } from '../src/containers/orchestrator'
import { DockerRuntime } from '../src/containers/dockerRuntime'
import { DockerFileArchive } from '../src/files/dockerArchive'
import { containerName } from '../src/containers/runtime'
import { InlineLifecycleQueue } from '../src/containers/lifecycleQueue'
import { defaultReservedPorts, type FleetConfig } from '../src/containers/values'
import { createApp } from '../src/app'
import { assembleTunnelServer } from '../src/chat/tunnelAssembly'
import { makeWsGatewayConnector } from '../src/chat/gatewayConnector'
import { DEV_ENCRYPTION_KEYS } from '../src/crypto'
import { ensureImageAvailable } from './smokeDocker'

// ---- 镜像 / 容器参数（对齐 containers-smoke：默认官方基线——编排与镜像内容无关，
// 避免私有派生 GHCR tag 的本地前置；派生镜像由 config OPENCLAW_IMAGE 注入 + 静态断言兜底）----
const IMAGE = process.env.OPENCLAW_IMAGE ?? 'ghcr.io/openclaw/openclaw:2026.7.1-browser'
const BOX = 'pairing-smoke'

// 临时 fleetRoot 放 worktree 下（.gitignore 忽略 .smoke-tmp/）。旧 bind 时代容器经宿主路径挂载
// home/config、Docker Desktop（macOS）只对 /Users 下路径 bind mount 生效（实测校准）；#592 起
// 默认 named volume 拓扑、config 经 putArchive 落容器内，宿主路径不再挂进容器——布局保留仅作
// 模板目录/openclaw.json 渲染源的宿主位置（控制面自己读，无 Docker 挂载约束）。
const SMOKE_ROOT = path.join(path.resolve(process.cwd(), '..'), '.smoke-tmp')

// ---- 浏览器侧协议机 transport（Node 版，与 frontend/src/chat/tunnelSocket.ts 同构）----
// 真网关实测：WS connect 须带 Origin header 且在 gateway.controlUi.allowedOrigins 内，否则网关回
// CONTROL_UI_ORIGIN_NOT_ALLOWED 拒连。origin 不再硬编码测试值（#386）：取 cfg.panelOrigin——
// 即生产装配同源值（config.fleet.panelOrigin），容器 allowedOrigins 也由 ConfigRenderer 强制进
// 该值（#385 同源强制点）——真容器上验证的是「生产配置下面板后端隧道连网关」的完整闭环。
interface SocketHandlers {
  open: () => void
  message: (data: string) => void
  close: (code: number, reason: string) => void
  error: (err: Error) => void
}

class NodeTunnelSocket {
  private readonly ws: WebSocket
  constructor(url: string, jwt: string, origin: string, handlers: SocketHandlers) {
    // 真网关要求 Origin header（allowedOrigins 校验），浏览器自动带、Node ws 客户端不带 → 显式加。
    // origin 取自配置（#386）：与生产装配同源——生产浏览器带面板自身 origin，Node 客户端须代填。
    this.ws = new WebSocket(url, ['access_token', jwt], { headers: { Origin: origin } })
    this.ws.on('open', () => handlers.open())
    this.ws.on('message', (data) => handlers.message(data.toString()))
    this.ws.on('close', (code, reason) => handlers.close(code, reason.toString()))
    this.ws.on('error', (err) => handlers.error(err))
  }
  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }
  send(data: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason)
  }
}

// ---- 设备 Ed25519 身份（Node crypto 标准 Ed25519，与前端 @noble 签名输出兼容）----
// deviceId = sha256(raw publicKey 32B).hex（对齐前端 deviceIdentity.ts 的网关设备指纹）；
// publicKey/privateKey = base64url raw（网关 buildDeviceAuthPayloadV3 校验签名 + 指纹）。
interface DeviceIdentity {
  deviceId: string
  publicKey: string
  sign(payload: string): Promise<string>
}

function generateIdentity(): { identity: DeviceIdentity; privateKeyRaw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // SPKI/PKCS8 DER 末尾即 raw 32B/64B（标准编码布局）。
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-64)
  const deviceId = createHash('sha256').update(pubRaw).digest('hex')
  const identity: DeviceIdentity = {
    deviceId,
    publicKey: pubRaw.toString('base64url'),
    sign: async (payload: string) => {
      // 须用 crypto.sign(null, ...)：Node 的 ed25519 createSign('ed25519')+update 抛
      // 「Invalid digest」（createSign 对非 hash 算法仍走 digest 路径，实测校准）。
      return ed25519Sign(null, Buffer.from(payload), privateKey).toString('base64url')
    },
  }
  return { identity, privateKeyRaw: privRaw }
}

// ---- 等待 helper ----
async function waitFor<T>(check: () => Promise<T | null>, timeoutMs: number, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await check()
    if (r !== null) return r
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`)
}

// ---- 连接常量（对齐 frontend/src/chat/gatewayChat.ts）----
// 配对闭环验证用 webchat-ui 身份（真网关对 webchat 客户端强制配对流程——control-ui 身份在
// 本地 loopback 下被 isControlUiBrowserContainerLocalEquivalent 判为「浏览器本地等价」跳过配对）。
const CLIENT_INFO = { id: 'webchat-ui', mode: 'webchat', platform: 'browser', version: '2026.7.2-beta.6' } as const
// #461 真网关实测（ADR 0006 实测项③）：sessions.delete/patch/compact/restore 对 webchat 客户端
// 硬拒（rejectWebchatSessionMutation：「webchat clients cannot delete sessions; use chat.send
// for session-scoped updates」），豁免仅 client.id === 'openclaw-control-ui'（官方 control-ui 页面
// 身份）。面板前端改 control-ui 身份（见 frontend/src/chat/gatewayChat.ts CLIENT_INFO）后删除可用，
// 配对不受影响（BROWSER_DEVICE_CLIENT_IDS 含 control-ui；生产远程非 loopback 仍要求配对）。
const CONTROL_UI_CLIENT_INFO = { id: 'openclaw-control-ui', mode: 'webchat', platform: 'browser', version: '2026.7.2-beta.6' } as const
const OPERATOR_ROLE = 'operator'
const OPERATOR_SCOPES = ['operator.read', 'operator.write', 'operator.approvals', 'operator.admin']
const CONNECT_CAPS = ['tool-events']

// buildConnectPlan 产出（官方 lifecycle plan + 面板 caps）——本地最小类型（server node10 拿不到
// 官方 .mts，用字段集约束测试逻辑；运行时 GatewayProtocolClient 类型为 any，不强制精确形状）。
interface AuthPlan {
  clientId: string
  role: string
  scopes: string[]
  auth?: { token?: string; bootstrapToken?: string; deviceToken?: string }
  device?: { id: string; publicKey: string; signature: string; signedAt: number; nonce: string }
  identity?: { deviceId: string } | null
  caps: string[]
}

interface ClientHandlers {
  // 真网关 PAIRING_REQUIRED 详情（readPairingConnectErrorDetails 输出；验收②断言错误形态用）
  onPairing?: (pairing: PairingDetails) => void
  onCloseCode?: (code: number) => void
  onHello?: (hello: { auth?: { deviceToken?: string; role?: string; scopes?: string[] } }) => void
}

// 官方 readPairingConnectErrorDetails 输出（本地最小类型；真网关实测含 code/reason/requestId/
// remediationHint/deviceId/requestedRole/requestedScopes）。
interface PairingDetails {
  code?: string
  reason?: string
  requestId?: string
  remediationHint?: string
  deviceId?: string
  requestedRole?: string
  requestedScopes?: string[]
}

// 协议机 onClose/resolveClose 的 close context 最小类型（本地标注：官方 import 为 any，参数无
// 上下文类型，显式标注避免 implicit any）。connectFailure.error 标 any——官方 GatewayProtocolRequestError
// 是 any，instanceof 右侧 any 不产生类型收窄，details 访问须 any。
interface ProtocolCloseContext {
  code: number
  reason: string
  connectFailure?: { error?: any; reconnectDelayMs?: number }
}

describe('真网关配对闭环 smoke（#371-5 / #378）', () => {
  let ctx: TestContext
  let orch: Orchestrator
  let runtime: DockerRuntime
  // #386：cfg 提升为共享（隧道/网关探测/浏览器 transport 的 origin 同源取值，并在 beforeAll 内
  // 断言容器 openclaw.json 的 allowedOrigins 含该值——生产形态证明）。
  let cfg: FleetConfig
  let bootstrapToken: string
  let access: string
  let containerPort: number
  let tunnelUrl: string
  let server: Server
  let tunnel: ReturnType<typeof assembleTunnelServer>
  // 共享设备身份 + 内存 tokenStore（模拟浏览器 localStorage；官方 lifecycle 回调）。
  let identity: DeviceIdentity
  let storedToken: { token: string; scopes: string[] } | null

  beforeAll(async () => {
    // 必须真跑：镜像不可获取（含退役 tag）→ 抛错、套件失败（对齐 containers-smoke codex PR#346）。
    await ensureImageAvailable(IMAGE)

    ctx = await setupTestApp()
    // fleetRoot 放 worktree 下（SMOKE_ROOT）：Docker bind mount 须 /Users 路径才生效（见文件头）。
    mkdirSync(SMOKE_ROOT, { recursive: true })
    const fleetRoot = mkdtempSync(path.join(SMOKE_ROOT, `pairing-smoke-${process.pid}-`))
    const templateDir = process.env.OPENCLAW_TEMPLATE_DIR ?? path.join(fleetRoot, 'template')
    if (!process.env.OPENCLAW_TEMPLATE_DIR) {
      mkdirSync(path.join(templateDir, 'workspace'), { recursive: true })
      writeFileSync(path.join(templateDir, 'README.md'), '# pairing smoke home\n')
    }
    const templateJson = path.join(fleetRoot, 'openclaw.template.json')
    // gateway.mode=local：容器网关启动必需（缺省镜像内 setup 向导，实测 exit 78「Missing config」——
    // 生产模板 deploy/openclaw.json 含 mode:local；containers-smoke 简模板只验容器 running 未验网关）。
    writeFileSync(templateJson, JSON.stringify({ gateway: { mode: 'local', auth: {} }, models: { providers: {} } }))

    cfg = {
      root: fleetRoot,
      templateDir,
      templateJson,
      image: IMAGE,
      portStart: 19800,
      portEnd: 19810,
      llmApiKey: process.env.LLM_API_KEY ?? 'smoke-dummy-key',
      publishHost: '127.0.0.1',
      healthHost: '127.0.0.1',
      panelOrigin: 'http://127.0.0.1:18789', // 与容器 allowedOrigins 默认 seed 一致（配对 smoke 直连真网关）
      namedVolumes: true, // #592 本地/CI 默认 named volume 拓扑（config 经 putArchive 落容器内、穿卷读）
      reservedPorts: defaultReservedPorts(),
      encryptionKeys: DEV_ENCRYPTION_KEYS,
    }
    runtime = new DockerRuntime(undefined, cfg.publishHost)
    // 残留容器兜底（上次失败 may 残留 unless-stopped 容器 → docker run name 冲突）：先清再建。
    await runtime.remove(BOX).catch(() => {})
    // #591：config 写读经 FileArchive（createComplete 落容器内 openclaw.json；此处读容器内验证）
    const archive = new DockerFileArchive()
    const deps = new FleetDeps(runtime, cfg, { queue: new InlineLifecycleQueue(), archive })
    orch = new Orchestrator(deps, ctx.prisma)
    // 挂载 containers 路由（bootstrap-token / approve 走真实 HTTP + 真 docker exec）。
    const app = createApp({ prisma: ctx.prisma, orchestrator: orch, runtime })
    ctx.request = supertest(app) as unknown as TestContext['request']

    const u = await seedUser(ctx.prisma, 'pair-smoke', 'pw-pairsmoke-secure')
    const l = await login(ctx.request, 'pair-smoke', 'pw-pairsmoke-secure')
    access = l.access!

    // 启动真容器（createReserve → createComplete = runCreateComplete 跑 docker run）。
    // createComplete 返回更新后的 running 行（传入的 inst 仍是 creating 快照）。
    const inst = await orch.createReserve(BOX, u.id)
    const created = await orch.createComplete(inst, true)
    containerPort = created.port
    expect(created.status).toBe('running')

    // #386 生产形态证明：容器内 openclaw.json（#591 起经 putArchive 落 ~/.openclaw/openclaw.json，
    // 不再落宿主 instances/<id>/config）的 gateway.controlUi.allowedOrigins 须含配置 panelOrigin——
    // ConfigRenderer 强制点（#385），隧道连网关的 Origin header 与容器允许列表同源闭环。
    const containerConfig = JSON.parse(await archive.readConfig(BOX)) as {
      gateway?: { controlUi?: { allowedOrigins?: string[] } }
    }
    expect(containerConfig.gateway?.controlUi?.allowedOrigins).toContain(cfg.panelOrigin)

    // 端口映射实况检查（CI 定位 #378）：daemon 侧 NetworkSettings.Ports 若为空（{}），docker-proxy
    // 未注册映射 → 宿主 127.0.0.1:<port> 必然 ECONNREFUSED，盲等网关就绪无意义。空映射立即抛错附
    // HostConfig.PortBindings（daemon 收到的配置）定位根因（dockerode 创建参数 vs daemon 实际映射）。
    const mapCheck = execFileSync(
      'docker',
      ['inspect', containerName(BOX), '--format', '{{json .NetworkSettings.Ports}}|{{json .HostConfig.PortBindings}}'],
      { encoding: 'utf8' },
    ).trim()
    const [portsJson, portBindingsJson] = mapCheck.split('|')
    if (portsJson === '{}' || portsJson === 'null') {
      throw new Error(
        `容器 ${BOX} 端口映射为空（docker-proxy 未注册）：NetworkSettings.Ports=${portsJson} HostConfig.PortBindings=${portBindingsJson} 容器端口=${containerPort}`,
      )
    }

    // 等容器网关 WS 就绪（docker-proxy 起 + 网关监听）：makeWsGatewayConnector 直连根路径。
    // CI（共享 runner 与 containers-smoke 并行）容器首启 + 网关初始化慢 → 轮询预算 360s
    //（beforeAll 480s，给诊断留余量）。等待期间容器退出（openclaw 启动崩溃，status 原值含
    // restarting/exited）→ 立即失败；每 30s 打印中间状态（容器状态 + 容器日志 tail）供 CI 观测；
    // 预算耗尽 → 附完整诊断（容器日志 + 最近探测错误）定位根因，不盲等成无信息超时。
    const probeErrors: string[] = []
    const deadline = Date.now() + 360_000
    let lastLive: string | null = null
    let lastProgressLog = Date.now()
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const live = await runtime.get(BOX).catch(() => null)
      if (live) lastLive = `running=${live.running} status=${live.status}`
      // Restarting 循环中 State.Running 可能仍 true（重启间隙才 false）——须查 status 原值
      //（"Restarting (78) 10 seconds ago" / "Exited (78)"）识别 openclaw 启动崩溃。
      if (live && (live.status.includes('restarting') || live.status.includes('exited') || !live.running)) {
        let logs = ''
        try {
          logs = execFileSync('docker', ['logs', '--tail', '40', containerName(BOX)], { encoding: 'utf8' })
        } catch {
          // 容器日志不可得 → 仅报状态
        }
        throw new Error(`容器 ${BOX} 已退出（网关未就绪），status=${live.status}，docker logs:\n${logs}`)
      }
      if (Date.now() - lastProgressLog >= 30_000) {
        lastProgressLog = Date.now()
        let logs = ''
        try {
          logs = execFileSync('docker', ['logs', '--tail', '5', containerName(BOX)], { encoding: 'utf8' })
        } catch {
          // 容器日志不可得 → 仅报状态
        }
        // eslint-disable-next-line no-console
        console.log(
          `[pairingSmoke] 等待网关 WS 就绪 ${Math.round((Date.now() - (deadline - 360_000)) / 1000)}s: ${lastLive} 最近探测错误=${JSON.stringify(probeErrors)} 容器日志 tail:\n${logs.trim()}`,
        )
      }
      try {
        // 网关就绪探测：直连根路径连网关须带 Origin（真网关 allowedOrigins 校验）——#386 取
        // cfg.panelOrigin（与隧道同源；网关启动时容器 openclaw.json 已由 ConfigRenderer 写入该值）。
        const gw = await makeWsGatewayConnector(undefined, undefined, cfg.panelOrigin).connect(
          `ws://127.0.0.1:${containerPort}/`,
        )
        gw.close()
        break // 网关 WS 就绪
      } catch (e) {
        probeErrors.push((e as Error).message.slice(0, 120))
        if (probeErrors.length > 10) probeErrors.shift()
      }
      if (Date.now() >= deadline) {
        let logs = ''
        let portInfo = ''
        try {
          logs = execFileSync('docker', ['logs', '--tail', '40', containerName(BOX)], { encoding: 'utf8' })
          // 容器端口映射实况（CI 定位：宿主 127.0.0.1:<port> ECONNREFUSED 时看 docker-proxy 是否注册映射）
          portInfo = execFileSync('docker', ['port', containerName(BOX)], { encoding: 'utf8' })
          portInfo += execFileSync(
            'docker',
            ['inspect', containerName(BOX), '--format', '{{json .NetworkSettings.Ports}}'],
            { encoding: 'utf8' },
          )
        } catch {
          // 容器日志/映射信息不可得 → 仅报状态
        }
        throw new Error(
          `网关 WS 360s 未就绪: ${BOX} lastLive=${lastLive} 最近探测错误=${JSON.stringify(probeErrors)} docker port/inspect:\n${portInfo}\ndocker logs:\n${logs}`,
        )
      }
      await new Promise((r) => setTimeout(r, 1000))
    }

    // bootstrap token（真解密，bootstrap-token 端点）。
    const bt = await ctx.request
      .post(`/api/v1/containers/${BOX}/bootstrap-token`)
      .set(bearer(access))
    expect(bt.body.code).toBe(0)
    bootstrapToken = bt.body.data.bootstrapToken

    // 真实隧道：浏览器 ↔ 面板 WS → 容器网关。装配走生产接缝 assembleTunnelServer（#385/#386）——
    // 与 server.ts 同源：panelOrigin 传入隧道 → makeWsGatewayConnector 携带 WS Origin；不再注入
    // 测试硬编码 origin。真网关 2026.7.1 校验 Origin 须在容器 allowedOrigins 内（见下断言：
    // ConfigRenderer 已把 panelOrigin 强制进容器 openclaw.json）。
    tunnel = assembleTunnelServer({
      prisma: ctx.prisma,
      panelOrigin: cfg.panelOrigin,
      gatewayHost: cfg.healthHost,
      gatewayScheme: 'ws',
    })
    server = http.createServer()
    server.on('upgrade', (req, socket, head) => {
      if (!tunnel.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port: tunnelPort } = server.address() as AddressInfo
    tunnelUrl = `ws://127.0.0.1:${tunnelPort}/ws/chat/?container=${BOX}`

    // 共享设备身份 + tokenStore（模拟浏览器 localStorage 持久化）。
    const gen = generateIdentity()
    identity = gen.identity
    storedToken = null
    // beforeAll 480s：CI 慢 runner 上容器创建 + 网关就绪可超 4 分钟，须给 360s 轮询预算 + 诊断留余量
    //（vitest hook timeout 无诊断会吞掉超时原因）
  }, 480_000)

  afterAll(async () => {
    // 关隧道/HTTP（terminate 全部活动 WS 防 close 挂起）。server 可能未创建（beforeAll 中途失败）：
    // 必须先判存在再等 close，否则 `server?.close(cb)` 是 undefined、resolve 永不调用 → hook 超时。
    tunnel?.close()
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    // best-effort 停/删真容器（残留 unless-stopped 容器须清，否则重跑 name 冲突）。
    if (runtime) await runtime.remove(BOX).catch(() => {})
    if (ctx) await ctx.cleanup()
  })

  // 构造协议机 client（官方 GatewayProtocolClient + NodeTunnelSocket + 官方 lifecycle）。
  // resolveClose 对齐前端 gatewayChat：PAIRING_REQUIRED/认证类 = 非传输问题 retry:false；
  // 其余（含网关未就绪 4402）retry:true 交协议机退避重连（首连窗口容器网关未完全就绪时自愈）。
  // onConnectHello 对齐 #377：hello-ok 下发 deviceToken → acceptHello 持久化（tokenStore）。
  // clientInfo 缺省 CLIENT_INFO（webchat-ui 身份，配对闭环用）；control-ui 身份（删除验证）显式传入。
  const makeClient = (handlers: ClientHandlers, clientInfo: { id: string; mode: string; platform: string; version: string } = CLIENT_INFO) => {
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => identity,
      tokenStore: {
        load: async () => (storedToken ? { token: storedToken.token, scopes: storedToken.scopes } : null),
        store: async ({ token, scopes }: { token: string; scopes: string[] }) => {
          storedToken = { token, scopes }
        },
        clear: async () => {
          storedToken = null
        },
      },
    })
    let requestSeq = 0
    const client = new GatewayProtocolClient<AuthPlan>({
      createSocket: (sh: SocketHandlers) => new NodeTunnelSocket(tunnelUrl, access, cfg.panelOrigin, sh),
      createRequestId: () => `smoke-req-${requestSeq++}`,
      buildConnectPlan: async ({ nonce }: { nonce: string }) => {
        // 真网关实测（2026.7.1-browser）：首连 auth 必须用 `token` 字段（值 = GATEWAY_TOKEN/bootstrap
        // token），网关才校验通过并进入配对。官方 lifecycle 的 bootstrapToken 参数输出 `bootstrapToken`
        // 字段 → 2026.7.1 网关把它当「setup code」拒（AUTH_BOOTSTRAP_TOKEN_INVALID「scan a fresh setup
        // code」）——官方包 2026.7.2-beta.6 面向 2026.7.2 网关，与 2026.7.1 不兼容（无 2026.7.2 镜像，
        // 无法升镜像匹配）。适配：首连传 `token` 参数（lifecycle 输出 auth:{token}，签名 token 一致）。
        // 重连（tokenStore 已有 deviceToken）不传凭证——lifecycle 的 selectGatewayConnectAuth 在无
        // token/bootstrapToken 时从 tokenStore 取 deviceToken（auth:{deviceToken}），满足验收③
        // 「deviceToken 后续连接直接通」。
        const plan = await lifecycle.buildPlan({
          client: clientInfo,
          role: OPERATOR_ROLE,
          defaultScopes: OPERATOR_SCOPES,
          ...(storedToken ? {} : { token: bootstrapToken }),
          nonce,
        })
        return { ...plan, caps: CONNECT_CAPS } as AuthPlan
      },
      buildConnectParams: (plan: AuthPlan) => ({
        minProtocol: 4,
        maxProtocol: 4,
        client: clientInfo,
        role: plan.role,
        scopes: plan.scopes,
        caps: plan.caps,
        ...(plan.auth ? { auth: plan.auth } : {}),
        ...(plan.device ? { device: plan.device } : {}),
      }),
      handshake: { mode: 'require-challenge', timeoutMs: 10_000 },
      reconnect: { initialMs: 500, multiplier: 2, maxMs: 5000 },
      resolveClose: (context: ProtocolCloseContext) => {
        const connErr = context.connectFailure?.error
        if (
          connErr instanceof GatewayProtocolRequestError &&
          connErr.details !== undefined &&
          shouldPauseGatewayReconnect({
            details: connErr.details,
            deviceTokenRetryPending: false,
            tokenMismatchIsTerminal: true,
            clientVersionMismatchIsTerminal: true,
          })
        ) {
          return { retry: false, notify: true }
        }
        return { retry: true, notify: true }
      },
      onClose: (context: ProtocolCloseContext) => {
        // PAIRING_REQUIRED → 提取 requestId（readPairingConnectErrorDetails = 前端 gatewayChat 同源）。
        const connErr = context.connectFailure?.error
        const pairing =
          connErr instanceof GatewayProtocolRequestError ? readPairingConnectErrorDetails(connErr.details) : null
        if (pairing?.requestId) handlers.onPairing?.(pairing)
        else handlers.onCloseCode?.(context.code)
      },
      onConnectHello: (hello: { auth?: { deviceToken?: string } }, context: { plan: AuthPlan }) => {
        // #377 同款：仅当 hello 携带 deviceToken 且本连接有设备身份才算配对完成（持久化）。
        if (hello.auth?.deviceToken && context.plan.identity) {
          void lifecycle.acceptHello(hello, context.plan).catch(() => {})
        }
        handlers.onHello?.(hello)
      },
      onHello: () => {},
    })
    return { client, lifecycle }
  }

  it('bootstrap 首连 → PAIRING_REQUIRED → approve → hello-ok 下发 deviceToken → 复用直连', async () => {
    const pairings: PairingDetails[] = []
    const helloAuths: { deviceToken?: string }[] = []
    let onCloseCodes: number[] = []

    // ---- 1. 首连：无 deviceToken → bootstrap 首连 → 真网关 PAIRING_REQUIRED{requestId} ----
    const first = makeClient({
      onPairing: (pairing) => pairings.push(pairing),
      onCloseCode: (code) => onCloseCodes.push(code),
      onHello: (hello) => {
        if (hello.auth) helloAuths.push(hello.auth)
      },
    })
    first.client.start()
    await waitFor(async () => (pairings.length > 0 ? pairings[0] : null), 120_000)
    const pairing = pairings[0]
    const requestId = pairing.requestId!
    // 真网关 PAIRING_REQUIRED 行为断言（验收②：requestId 嵌套位置 + 错误形态与 fake 网关断言一致）：
    // 官方 readPairingConnectErrorDetails（前端 gatewayChat 同源解析器）能从真网关 connectFailure 的
    // details 提取到结构化的 PAIRING_REQUIRED——details.code + reason('not-paired') + requestId
    //（嵌套位置）；requestId 匹配官方 PAIRING_CONNECT_REQUEST_ID_PATTERN（含连字符 UUID）。
    expect(pairing).toMatchObject({ code: 'PAIRING_REQUIRED', reason: 'not-paired' })
    expect(pairing.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    // 首连窗口不应直接 hello-ok（未配对设备必被拒）。
    expect(helloAuths.length).toBe(0)
    first.client.stop()

    // ---- 2. 后端 approve（真实 HTTP → 容器内 docker exec `openclaw devices approve`）----
    const approveRes = await ctx.request
      .post(`/api/v1/containers/${BOX}/pairing/approve/${encodeURIComponent(requestId)}`)
      .set(bearer(access))
    expect(approveRes.body.code).toBe(0)
    expect(approveRes.body.data.status).toBe('paired')
    // 响应体无 token 明文（#371 User Story 8）。
    expect(JSON.stringify(approveRes.body)).not.toMatch(/device_token|private_key_pem/)
    // Pairing 行落库 paired + requestId 记账（真 exec 路径）。
    const row = await ctx.prisma.container.findUnique({ where: { name: BOX } })
    const pairingRow = await ctx.prisma.pairing.findUnique({ where: { containerId: row!.id } })
    expect(pairingRow?.status).toBe('paired')
    expect(pairingRow?.pairingRequestId).toBe(requestId)

    // ---- 3. 重连：approve 后 tokenStore 尚无 deviceToken → 仍 bootstrap → 网关接受 → hello-ok 下发 ----
    const second = makeClient({
      onCloseCode: (code) => onCloseCodes.push(code),
      onHello: (hello) => {
        if (hello.auth) helloAuths.push(hello.auth)
      },
    })
    second.client.start()
    await waitFor(async () => (helloAuths.length > 0 ? helloAuths[0] : null), 120_000)
    const deviceToken = helloAuths[0].deviceToken
    expect(deviceToken).toBeTruthy() // 网关下发 deviceToken（hello-ok）
    // acceptHello 已把 deviceToken 持久化进 tokenStore（浏览器「localStorage」）。
    await waitFor(async () => (storedToken ? storedToken.token : null), 10_000)
    expect(storedToken?.token).toBe(deviceToken)
    second.client.stop()

    // ---- 4. 复用 deviceToken 直连：不再 PAIRING_REQUIRED、直接 hello-ok（用户故事 2）----
    const third = makeClient({
      onPairing: (pairing) => pairings.push(pairing),
      onCloseCode: (code) => onCloseCodes.push(code),
      onHello: (hello) => {
        if (hello.auth) helloAuths.push(hello.auth)
      },
    })
    const helloCountBefore = helloAuths.length
    third.client.start()
    await waitFor(async () => (helloAuths.length > helloCountBefore ? helloAuths[helloCountBefore] : null), 60_000)
    third.client.stop()
    // 全程仅一次 PAIRING_REQUIRED（首连）；deviceToken 复用后不再配对。
    expect(pairings).toHaveLength(1)
  }, 240_000)

  it('ADR 0006 实测项③：sessions.create + delete（不带 archivedOnly）在真网关硬删除成功', async () => {
    // #461 验收：不带 archivedOnly 的 sessions.delete 在真实网关上删除成功。真网关实测（2026.7.1）：
    // webchat 客户端（webchat-ui/普通 mode=webchat）删除被 rejectWebchatSessionMutation 硬拒
    // （"webchat clients cannot delete sessions"），豁免仅 openclaw-control-ui 身份。故本用例用
    // control-ui 身份连接（本地 loopback 下被网关判为「浏览器本地等价」跳过配对直接 hello-ok；
    // 生产远程非 loopback 配对照常）。验证「已配对设备 + admin scope + control-ui 身份」可删除。
    const helloAuths: { deviceToken?: string }[] = []
    const c = makeClient(
      {
        onHello: (hello) => {
          if (hello.auth) helloAuths.push(hello.auth)
        },
      },
      CONTROL_UI_CLIENT_INFO,
    )
    c.client.start()
    await waitFor(async () => (helloAuths.length > 0 ? helloAuths[0] : null), 60_000)
    // 创建会话（idempotency key 32-hex，对齐前端 gatewayChat createSession）
    const createRes = await c.client.request<{ key?: string; sessionKey?: string }>('sessions.create', {
      key: `smoke-del-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.replace(/[^a-z0-9]/g, ''),
    })
    const key = createRes?.key ?? createRes?.sessionKey
    expect(key).toBeTruthy()
    // 删除（不带 archivedOnly——面板语义：硬删除，无「归档」中间态）
    await c.client.request('sessions.delete', { key })
    // 删除后列表不再含该会话（硬删除闭环验证）
    const listRes = await c.client.request<{ sessions?: Array<{ key?: string; sessionKey?: string }> }>(
      'sessions.list',
      { includeDerivedTitles: true },
    )
    const items = Array.isArray(listRes?.sessions) ? listRes.sessions : []
    const keys: string[] = []
    for (const s of items) {
      const k = typeof s?.key === 'string' ? s.key : typeof s?.sessionKey === 'string' ? s.sessionKey : ''
      if (k) keys.push(k)
    }
    expect(keys).not.toContain(key)
    c.client.stop()
  }, 120_000)

  it('容器停止（网关不可达）→ 隧道对浏览器 close(4402)（#376 前端预算的信号源）', async () => {
    // 停容器 → 宿主端口不可连 → 隧道 connectGateway 失败 → close(4402)。
    await runtime.stop(BOX)
    const codes: number[] = []
    const c = makeClient({ onCloseCode: (code) => codes.push(code) })
    c.client.start()
    await waitFor(async () => (codes.length > 0 ? codes[0] : null), 30_000)
    expect(codes[0]).toBe(4402) // WS_GATEWAY_UNAVAILABLE（网关不可达，非认证问题）
    c.client.stop()
  }, 60_000)
})
