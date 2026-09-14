// 集成 smoke（接缝 #5 集成侧）：真 docker daemon + 真 DockerRuntime，端到端验证 create→running→delete。
// **必须真跑，无 skip 门控**（codex PR#346 P2）：daemon 不可达或镜像不可获取 → 套件失败，绝不静默跳过。
// 拉取未缓存镜像经 modem.followProgress 消费进度流（helper 见 smokeDocker.ts，与 pairingSmoke 共享）。
// 需 env：OPENCLAW_TEMPLATE_DIR（home 模板源）/ LLM_API_KEY（可注入 dummy，容器未必真调 LLM）。
// #592：本地/CI 编排默认 named volume 拓扑——smoke 走三卷（建容器 → 空卷首挂由镜像内骨架初始化 →
// getArchive 读 wiki/workspace → putArchive 写 → exec rm 删 → 删容器连删三卷）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Docker from 'dockerode'
import { setupTestApp, type TestContext } from './setup'
import { seedUser } from './helpers'
import { FleetDeps } from '../src/containers/deps'
import { Orchestrator } from '../src/containers/orchestrator'
import { DockerRuntime } from '../src/containers/dockerRuntime'
import { DockerFileArchive } from '../src/files/dockerArchive'
import { FileNotFound } from '../src/files/errors'
import { InlineLifecycleQueue } from '../src/containers/lifecycleQueue'
import { defaultReservedPorts, type FleetConfig } from '../src/containers/values'
import { namedVolumesFor, volumeOrder } from '../src/containers/runtime'
import { RunOnceError } from '../src/containers/errors'
import { LABEL_ONESHOT_KEY, LABEL_ONESHOT_VALUE } from '../src/containers/constants'
import { DEV_ENCRYPTION_KEYS } from '../src/crypto'
import { ensureImageAvailable, type PullProgressClient } from './smokeDocker'

// #592 三卷拓扑断言 helper：卷存在（inspect 成功）/ 不存在（daemon 404 → reject statusCode 404）
function inspectVolume(name: string): Promise<Docker.VolumeInspectInfo> {
  return new Docker().getVolume(name).inspect()
}

// #696 独立事实源：直查 daemon 上带 oneshot 标记的容器（不看 runtime 的过滤视图——证「临时容器
// 真起过」以及「全路径回收后无残留」）。
function markedOneShotContainers(): Promise<Docker.ContainerInfo[]> {
  return new Docker().listContainers({
    all: true,
    filters: { label: [`${LABEL_ONESHOT_KEY}=${LABEL_ONESHOT_VALUE}`] },
  })
}

describe('ensureImageAvailable / drainPull（pull progress 消费，codex PR#346 P2）', () => {
  const modemWith = (err: Error | null): PullProgressClient['modem'] => ({
    followProgress: (_s, f) => f(err),
  })

  it('本地已缓存 → 就绪，不触发 pull', async () => {
    let pulled = false
    const client: PullProgressClient = {
      getImage: () => ({ inspect: async () => ({}) }),
      pull: async () => {
        pulled = true
        return new Readable()
      },
      modem: modemWith(null),
    }
    await expect(ensureImageAvailable('img', client)).resolves.toBeUndefined()
    expect(pulled).toBe(false)
  })

  it('pull 失败（followProgress 回调 err，注册表错误以进度记录出现）→ 抛错（不判就绪）', async () => {
    const client: PullProgressClient = {
      getImage: () => ({ inspect: async () => { throw { statusCode: 404 } } }),
      pull: async () => new Readable(),
      modem: modemWith(new Error('pull failed')),
    }
    await expect(ensureImageAvailable('img', client)).rejects.toThrow('pull failed')
  })

  it('pull 成功（followProgress 回调 null）→ 就绪', async () => {
    const client: PullProgressClient = {
      getImage: () => ({ inspect: async () => { throw { statusCode: 404 } } }),
      pull: async () => new Readable(),
      modem: modemWith(null),
    }
    await expect(ensureImageAvailable('img', client)).resolves.toBeUndefined()
  })
})

// 编排逻辑与镜像内容无关：smoke 默认官方基线，避免「私有派生 GHCR tag 未推/需凭证」的
// 本地前置（派生镜像由 config.ts OPENCLAW_IMAGE 注入 + openclawImage.test.ts 静态断言兜底）。
const IMAGE = process.env.OPENCLAW_IMAGE ?? 'ghcr.io/openclaw/openclaw:2026.7.1-browser'

describe('containers 集成 smoke（真 docker daemon）', () => {
  let ctx: TestContext
  let orch: Orchestrator
  let runtime: DockerRuntime
  let fleetRoot: string
  let ownerId: string

  beforeAll(async () => {
    // 必须真跑：镜像不可获取（含退役 tag）→ 这里抛错、套件失败，绝不以 skip 掩盖（codex PR#346 P2）。
    await ensureImageAvailable(IMAGE)
    ctx = await setupTestApp()
    fleetRoot = mkdtempSync(path.join(tmpdir(), `fleet-smoke-${process.pid}-`))
    const templateDir = process.env.OPENCLAW_TEMPLATE_DIR ?? path.join(fleetRoot, 'template')
    if (!process.env.OPENCLAW_TEMPLATE_DIR) {
      mkdirSync(path.join(templateDir, 'workspace'), { recursive: true })
      writeFileSync(path.join(templateDir, 'README.md'), '# smoke home\n')
    }
    const templateJson = path.join(fleetRoot, 'openclaw.template.json')
    writeFileSync(templateJson, JSON.stringify({ gateway: { auth: {} }, models: { providers: {} } }))

    const cfg: FleetConfig = {
      root: fleetRoot,
      templateDir,
      templateJson,
      image: IMAGE,
      portStart: 19700,
      portEnd: 19710,
      llmApiKey: process.env.LLM_API_KEY ?? 'smoke-dummy-key',
      publishHost: '127.0.0.1',
      healthHost: '127.0.0.1',
      panelOrigin: 'http://127.0.0.1:18789',
      namedVolumes: true, // #592 本地/CI 默认 named volume 拓扑（三卷 + putArchive config）
      reservedPorts: defaultReservedPorts(),
      encryptionKeys: DEV_ENCRYPTION_KEYS,
    }
    runtime = new DockerRuntime(undefined, cfg.publishHost)
    const deps = new FleetDeps(runtime, cfg, { queue: new InlineLifecycleQueue() })
    orch = new Orchestrator(deps, ctx.prisma)
    const u = await seedUser(ctx.prisma, 'smoke', 'pw-smoke-secure')
    ownerId = u.id
  }, 240_000)

  afterAll(async () => {
    // best-effort 清理残留容器（beforeAll 中途失败时 runtime/ctx 可能未初始化）。
    // #592：卷名由代系 id 派生、beforeAll 失败时未知，无法连带删卷——残留卷由成功路径
    // delete 连带清理；此兜底只删容器。
    if (runtime) await runtime.remove('smoke-box').catch(() => {})
    if (ctx) await ctx.cleanup()
  })

  it('create → running → delete（真容器端到端，#592 三卷拓扑）', async () => {
    const inst = await orch.createReserve('smoke-box', ownerId)
    expect(inst.status).toBe('creating')
    expect(inst.port).toBeGreaterThanOrEqual(19700)
    const volumes = namedVolumesFor(inst.id)
    await orch.createComplete(inst, true)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'smoke-box' } })
    expect(row?.status).toBe('running')
    expect(row?.containerId).not.toBe('')
    // runtime 实况：容器在跑
    const live = await runtime.get('smoke-box')
    expect(live?.running).toBe(true)
    expect(live?.instanceName).toBe('smoke-box')
    // #592 三卷拓扑：容器创建即建三卷（空卷首挂由镜像内骨架初始化；基线镜像为空目录，
    // 内容读写由下方 files CRUD 用例穿卷验证），宿主无 instances/ bind
    for (const v of volumeOrder(volumes)) {
      await expect(inspectVolume(v)).resolves.toBeDefined()
    }
    // delete 端到端：容器 + 三卷连带删除（ADR 0011：remove({v:true}) 只删匿名卷，须显式 rm）
    await orch.delete('smoke-box')
    expect(await ctx.prisma.container.findUnique({ where: { name: 'smoke-box' } })).toBeNull()
    expect(await runtime.get('smoke-box')).toBeNull()
    for (const v of volumeOrder(volumes)) {
      await expect(inspectVolume(v)).rejects.toMatchObject({ statusCode: 404 })
    }
  }, 120_000)

  it('files 统一 CRUD 端到端（getArchive/putArchive/exec rm 真 daemon，#589；#592 起穿三卷）', async () => {
    const fa = new DockerFileArchive()
    const inst = await orch.createReserve('smoke-files', ownerId)
    await orch.createComplete(inst, true)
    try {
      // #592 AC2 顺序闭环：建容器后、任何写前，wiki/workspace 根目录可读（空卷首挂点即存在；
      // 骨架内容初始化属 #588 派生镜像职责——基线镜像为空读，openclawImage.test.ts 静态兜底）
      const wikiRoot = await fa.read('smoke-files', 'wiki', '', false)
      expect(wikiRoot.kind).toBe('dir')
      const wsRoot = await fa.read('smoke-files', 'workspace', '', false)
      expect(wsRoot.kind).toBe('dir')
      // create → 写进容器 ~/.openclaw/workspace（父目录经 exec mkdir -p 保障）
      await fa.create('smoke-files', 'workspace', 'out/report.md', '# Smoke 报告\n')
      // list：workspace 根含刚建文件；递归 walk 出深层相对路径
      const dir = await fa.read('smoke-files', 'workspace', '', true)
      expect(dir.kind).toBe('dir')
      if (dir.kind !== 'dir') return
      expect(dir.files.map((f) => f.path)).toContain('out/report.md')
      // read：内容原文
      const file = await fa.read('smoke-files', 'workspace', 'out/report.md', false)
      expect(file).toMatchObject({ kind: 'file', content: '# Smoke 报告\n' })
      // write：覆写已存在
      await fa.write('smoke-files', 'workspace', 'out/report.md', '# 覆写\n')
      const after = await fa.read('smoke-files', 'workspace', 'out/report.md', false)
      if (after.kind === 'file') expect(after.content).toBe('# 覆写\n')
      // delete：删文件；不存在 → FileNotFound
      await fa.delete('smoke-files', 'workspace', 'out/report.md')
      await expect(fa.read('smoke-files', 'workspace', 'out/report.md', false)).rejects.toBeInstanceOf(FileNotFound)
      // wiki 树同样可用（基线镜像无 wiki 骨架：create 自动建目录，再列根）
      await fa.create('smoke-files', 'wiki', 'index.md', '# Wiki\n')
      const wikiDir = await fa.read('smoke-files', 'wiki', '', false)
      expect(wikiDir.kind).toBe('dir')
      if (wikiDir.kind === 'dir') {
        expect(wikiDir.files.map((f) => f.path)).toContain('index.md')
      }
    } finally {
      await orch.delete('smoke-files')
    }
  }, 120_000)

  // #696 oneshot 原语端到端（真 daemon + 真 fleet 镜像）：收退出码、全路径回收、fleet 列表不可见。
  it('runOnce：真临时容器收退出码并回收；跑动期间对 fleet 列表不可见（#696）', async () => {
    expect(await markedOneShotContainers()).toHaveLength(0) // 前置：无残留临时容器

    // ① 跑动期间不可见：后台起一个短睡临时容器（不 await），轮询 daemon 上的标记容器作为「真起过」
    //    的事实源；一旦观察到，fleet 列表（app=openclaw-fleet 过滤）此刻不得含它，且它无端口发布。
    const running = runtime.runOnce({ image: IMAGE, cmd: ['sh', '-c', 'sleep 4'] })
    // 起手即挂 rejection 处理：runOnce 若在下方最长 30s 的轮询窗口里早失败（如镜像拉取失败），
    // 不能让 unhandled rejection 冒出来掩盖真实原因——它的结局在本用例末尾统一断言。
    const runOutcome = running.then(
      (r) => ({ ok: true as const, output: r.output }),
      (e: unknown) => ({ ok: false as const, error: e }),
    )
    let observed: Docker.ContainerInfo | null = null
    const deadline = Date.now() + 30_000
    while (observed === null && Date.now() < deadline) {
      const live = await markedOneShotContainers()
      if (live.length > 0) {
        observed = live[0]
        const fleet = await runtime.listFleet()
        expect(fleet.some((c) => c.containerId === observed?.Id)).toBe(false) // 不进 fleet 列表
        // 不参与端口对账：无宿主端口发布。断 PublicPort（而非 Ports 为空）——镜像自带 EXPOSE 时
        // listContainers 仍报 PrivatePort 条目，那不影响对账（对账只认宿主发布端口）。
        expect((observed.Ports ?? []).every((p) => p.PublicPort === undefined)).toBe(true)
      } else {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    const outcome = await runOutcome // runOnce 已在轮询期间跑完：失败就把真实原因抛出来
    if (!outcome.ok) throw outcome.error
    expect(observed).not.toBeNull() // 临时容器真在 daemon 上起过（非「没跑起来所以看不到」）
    expect(outcome.output).toBe('') // `sleep 4` 无输出

    // ② 退出码 0：收 stdout+stderr 合并输出
    const ok = await runtime.runOnce({ image: IMAGE, cmd: ['sh', '-c', 'echo oneshot-ok; echo oneshot-err >&2'] })
    expect(ok.output).toContain('oneshot-ok')
    expect(ok.output).toContain('oneshot-err')

    // ③ 非 0 退出：抛 RunOnceError，携带退出码与输出
    const err = await runtime
      .runOnce({ image: IMAGE, cmd: ['sh', '-c', 'echo oneshot-boom >&2; exit 7'] })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RunOnceError)
    expect((err as RunOnceError).exitCode).toBe(7)
    expect((err as RunOnceError).output).toContain('oneshot-boom')

    // ④ 全路径回收：daemon 上无残留标记容器
    expect(await markedOneShotContainers()).toHaveLength(0)
  }, 120_000)
})
