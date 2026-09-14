// #699 容器升级编排（server 线：检测 / 触发 / 六步序 / 干净中止 / 守卫 / 崩溃收敛）。
// 经假运行时（接缝 #5）+ 信封 REST（接缝 #2）断言 spec §2 全部语义：
//   - needsUpgrade 判定（镜像不匹配为真、已对齐为假）
//   - upgrading/upgrade_failed 状态透传 + upgradeAttempts 计数
//   - 六步序与失败语义（拉镜像/备份失败=干净中止不计失败；doctor/recreate 失败=attempt+1、3 次终态）
//   - 守卫（upgrading 幂等/拒删、busy、bind 模式拒绝、upgrade_failed 仅可删重建）
//   - reconcileUpgrading 崩溃收敛（running 补记实况 / stopped+1 次 attempt / daemon 不可达保持）

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { makeFleetTest, type FleetTestContext } from './fleetTestUtils'
import { backupVolumeFor, namedVolumesFor } from '../src/containers/runtime'
import { ContainerDomainError, InstanceBusy, RunOnceError } from '../src/containers/errors'
import { CODE } from '../src/codes'
import { HOME_BIND, MOUNT_WIKI, MOUNT_WORKSPACE, ONESHOT_BACKUP_TARGET } from '../src/containers/constants'

// 存量旧镜像（≠ makeFleetTest 的 config.image 'ghcr.io/openclaw/openclaw:test'）→ needsUpgrade 判定为真。
const OLD_IMAGE = 'ghcr.io/openclaw/openclaw:2026.7.1-browser'

// 造一个「存量旧镜像容器」：orch.create（真容器 running + 行 image=target）后把行 image 改成旧镜像——
// 模拟升级编排入口的真实输入（行镜像 ≠ 当前目标、runtime 有 owned 容器）。
async function seedLegacyContainer(fl: FleetTestContext, ctx: TestContext, name: string, ownerId: string) {
  await fl.orch.create(name, ownerId)
  await ctx.prisma.container.update({ where: { name }, data: { image: OLD_IMAGE } })
  const row = await ctx.prisma.container.findUnique({ where: { name } })
  if (!row) throw new Error('seed failed')
  return row
}

// 触发升级并 await 后台完成（inline 队列同步跑完）。
async function runUpgrade(fl: FleetTestContext, name: string) {
  const res = await fl.orch.upgradeReserve(name)
  if (res.triggered) await fl.orch.submitUpgrade(name)
  return res
}

describe('#699 容器升级编排（接缝 #5 假运行时）', () => {
  let ctx: TestContext
  let fl: FleetTestContext
  let ownerId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    fl = makeFleetTest(ctx.prisma)
    const u = await seedUser(ctx.prisma, 'up-owner', 'pw-up-secure')
    ownerId = u.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })
  beforeEach(() => {
    fl.runtime.oneshotExitCode = 0
    fl.runtime.oneshotOutput = ''
    fl.runtime.oneshotWaitError = null
    fl.runtime.oneshotRuns.length = 0
    fl.runtime.ensureImageCalls.length = 0
    fl.runtime.failEnsureImageFor.clear()
    fl.runtime.failOneshotCmdSubstring = null
    fl.runtime.removedVolumes.length = 0
    fl.runtime.failRunFor.clear()
  })
  afterEach(async () => {
    // 端口池（19000–19010 仅 11 候选）跨用例共享 DB/runtime：清空本 describe 创建的全部容器行与
    // runtime 容器，释放端口、隔离用例（对齐「每用例独立 tmp」的隔离哲学）。
    await ctx.prisma.container.deleteMany({}).catch(() => {})
    fl.runtime.containers.clear()
  })

  // ---- 检测（spec §2.1）----

  it('needsUpgrade 判定：镜像不匹配为真、已对齐为假（list + createdItem 两路）', async () => {
    // 已对齐：create 后 image=config.image → needs_upgrade=false
    await fl.orch.create('up-aligned', ownerId)
    let items = await fl.orch.list({ ownerId })
    expect(items.find((i) => i.name === 'up-aligned')?.needs_upgrade).toBe(false)
    // 不匹配：行 image 改成旧镜像 → needs_upgrade=true（读侧按行记账判定，方向无关）
    await ctx.prisma.container.update({ where: { name: 'up-aligned' }, data: { image: OLD_IMAGE } })
    items = await fl.orch.list({ ownerId })
    expect(items.find((i) => i.name === 'up-aligned')?.needs_upgrade).toBe(true)
  })

  // ---- 状态透传（spec §2.2 读侧）----

  it('upgrading / upgrade_failed 瞬态透传（不探健康）；upgrade_failed health 显示 stopped', async () => {
    const row = await seedLegacyContainer(fl, ctx, 'up-status', ownerId)
    // upgrading 透传的真实可见窗口 = 在飞升级（本进程持 name lease，reconcile 跳过收敛）。
    const lease = fl.deps.lock.tryAcquire('up-status')
    await ctx.prisma.container.update({ where: { id: row.id }, data: { status: 'upgrading' } })
    let items = await fl.orch.list({ ownerId })
    expect(items.find((i) => i.name === 'up-status')).toMatchObject({ status: 'upgrading', health: 'pending' })
    lease?.release()
    // 终态 upgrade_failed：reconcileUpgrading 只处理 upgrading 行，直接透传
    await ctx.prisma.container.update({ where: { id: row.id }, data: { status: 'upgrade_failed' } })
    items = await fl.orch.list({ ownerId })
    expect(items.find((i) => i.name === 'up-status')).toMatchObject({ status: 'upgrade_failed', health: 'stopped' })
  })

  // ---- 六步序 + 成功路径（spec §2.4）----

  it('happy path：ensureImage → stop → 备份 oneshot → doctor oneshot → remove(不带卷) → create(target+原三卷) → startById → 行收敛', async () => {
    const row = await seedLegacyContainer(fl, ctx, 'up-happy', ownerId)
    const { inst, triggered } = await runUpgrade(fl, 'up-happy')
    expect(triggered).toBe(true)
    expect(inst.status).toBe('upgrading') // 同步段返回升级中快照

    // 步骤 1：拉目标镜像（先做不停机）
    expect(fl.runtime.ensureImageCalls).toContain(fl.config.image)

    // 步骤 3+4：两个 oneshot——备份（tar home → 备份卷）先行、doctor 随后（三卷同布局 + token env）
    expect(fl.runtime.oneshotRuns).toHaveLength(2)
    const backup = fl.runtime.oneshotRuns[0].spec
    expect(backup.image).toBe(fl.config.image)
    expect(backup.cmd.join(' ')).toContain('tar czf')
    expect(backup.mounts?.[0]).toEqual({ source: namedVolumesFor(row.id).home, target: HOME_BIND, readOnly: true })
    expect(backup.mounts?.[1]).toEqual({ source: backupVolumeFor(row.id), target: ONESHOT_BACKUP_TARGET })
    const doctor = fl.runtime.oneshotRuns[1].spec
    expect(doctor.image).toBe(fl.config.image)
    expect(doctor.cmd.join(' ')).toContain('openclaw doctor --fix')
    expect(doctor.mounts?.map((m) => m.target)).toEqual([MOUNT_WIKI, MOUNT_WORKSPACE, HOME_BIND])
    expect(doctor.env?.GATEWAY_TOKEN).toBeTruthy() // 卷内 ${GATEWAY_TOKEN} 占位需同 env 才可读配置
    expect(doctor.env?.OPENCLAW_GATEWAY_TOKEN).toBe(doctor.env?.GATEWAY_TOKEN)

    // 步骤 5：remove 不带 volumes（三卷保留——removedVolumes 为空即证明未连卷删）
    expect(fl.runtime.removedVolumes).toEqual([])
    const rec = fl.runtime.containers.get('up-happy')
    expect(rec).toBeDefined()
    expect(rec?.info.image).toBe(fl.config.image) // 新容器 target 镜像
    expect(rec?.info.running).toBe(true) // startById 已启动
    expect(rec?.spec.volumes).toEqual(namedVolumesFor(row.id)) // 复用原三卷

    // 步骤 6：行记回 target + running + attempts 清零 + containerId 换新（needsUpgrade 自然转 false）
    const after = await ctx.prisma.container.findUnique({ where: { name: 'up-happy' } })
    expect(after?.image).toBe(fl.config.image)
    expect(after?.status).toBe('running')
    expect(after?.upgradeAttempts).toBe(0)
    expect(after?.containerId).toBe(rec?.info.containerId)
    expect(after?.containerId).not.toBe(row.containerId)
    const items = await fl.orch.list({ ownerId })
    expect(items.find((i) => i.name === 'up-happy')?.needs_upgrade).toBe(false)
  })

  // ---- 干净中止（步骤 1/3 失败，spec §2.4：不计失败、复启旧容器回可用态）----

  it('拉镜像失败 → 干净中止：不计失败、容器未动（不停机）、标 stopped（读侧按实况显示 running）', async () => {
    const row = await seedLegacyContainer(fl, ctx, 'up-pull', ownerId)
    fl.runtime.failEnsureImageFor.add(fl.config.image)
    await runUpgrade(fl, 'up-pull')
    // 备份/doctor 未跑（拉失败即止）
    expect(fl.runtime.oneshotRuns).toHaveLength(0)
    // 容器从未被停机，仍在跑
    expect(fl.runtime.containers.get('up-pull')?.info.running).toBe(true)
    const after = await ctx.prisma.container.findUnique({ where: { name: 'up-pull' } })
    expect(after?.status).toBe('stopped') // 干净中止标 stopped（重试入口）
    expect(after?.upgradeAttempts).toBe(0) // 不计失败
    expect(after?.image).toBe(OLD_IMAGE) // 镜像不变
    expect(after?.containerId).toBe(row.containerId)
  })

  it('备份失败 → 干净中止：不计失败、复启旧容器、doctor 未跑', async () => {
    const row = await seedLegacyContainer(fl, ctx, 'up-backup', ownerId)
    fl.runtime.failOneshotCmdSubstring = 'tar'
    await runUpgrade(fl, 'up-backup')
    // 只跑了备份 oneshot（doctor 未到）
    expect(fl.runtime.oneshotRuns).toHaveLength(1)
    expect(fl.runtime.oneshotRuns[0].spec.cmd.join(' ')).toContain('tar')
    // 干净中止复启旧容器 → 回到 running
    expect(fl.runtime.containers.get('up-backup')?.info.running).toBe(true)
    const after = await ctx.prisma.container.findUnique({ where: { name: 'up-backup' } })
    expect(after?.status).toBe('stopped')
    expect(after?.upgradeAttempts).toBe(0) // 备份失败不计失败
    expect(after?.image).toBe(OLD_IMAGE)
    expect(after?.containerId).toBe(row.containerId)
  })

  // ---- 失败 attempt（步骤 4/5，spec §2.4：attempts+1、复启旧容器、≥3 终态）----

  it('doctor 失败 → attempt+1、状态 stopped 可重试、旧容器复启、镜像不变', async () => {
    const row = await seedLegacyContainer(fl, ctx, 'up-doctor', ownerId)
    fl.runtime.failOneshotCmdSubstring = 'doctor'
    await runUpgrade(fl, 'up-doctor')
    expect(fl.runtime.oneshotRuns).toHaveLength(2) // 备份过、doctor 非 0
    expect(fl.runtime.oneshotRuns[1].spec.cmd.join(' ')).toContain('doctor')
    // doctor 失败后尝试复启旧容器（store 可能已迁移、旧镜像可能起不来——尽力而为）
    expect(fl.runtime.containers.get('up-doctor')?.info.running).toBe(true)
    const after = await ctx.prisma.container.findUnique({ where: { name: 'up-doctor' } })
    expect(after?.status).toBe('stopped') // 可重试
    expect(after?.upgradeAttempts).toBe(1) // 计一次失败
    expect(after?.image).toBe(OLD_IMAGE) // 镜像未变（需升级判定仍为真）
    expect(after?.containerId).toBe(row.containerId)
  })

  it('recreate 失败 → attempt+1、三卷保留、行可重试（镜像不变）', async () => {
    await seedLegacyContainer(fl, ctx, 'up-recreate', ownerId)
    fl.runtime.failRunFor.add('up-recreate') // recreate 的 create(spec) 抛非 bind 错
    await runUpgrade(fl, 'up-recreate')
    expect(fl.runtime.oneshotRuns).toHaveLength(2) // 备份 + doctor 都过
    expect(fl.runtime.removedVolumes).toEqual([]) // remove 不带卷 → 三卷保留
    // remove 已删旧容器、create 失败 → 无容器驻留
    expect(fl.runtime.containers.has('up-recreate')).toBe(false)
    const after = await ctx.prisma.container.findUnique({ where: { name: 'up-recreate' } })
    expect(after?.status).toBe('stopped')
    expect(after?.upgradeAttempts).toBe(1)
    expect(after?.image).toBe(OLD_IMAGE)
  })

  it('连续失败达 3 次 → upgrade_failed 终态（仅可删除重建）', async () => {
    await seedLegacyContainer(fl, ctx, 'up-term', ownerId)
    // 预置前两次失败（attempts=2），本次 doctor 失败 → 第 3 次 → 终态
    await ctx.prisma.container.update({ where: { name: 'up-term' }, data: { upgradeAttempts: 2 } })
    fl.runtime.failOneshotCmdSubstring = 'doctor'
    await runUpgrade(fl, 'up-term')
    const after = await ctx.prisma.container.findUnique({ where: { name: 'up-term' } })
    expect(after?.status).toBe('upgrade_failed')
    expect(after?.upgradeAttempts).toBe(3)
    // 终态读侧透传（health stopped）
    const items = await fl.orch.list({ ownerId })
    expect(items.find((i) => i.name === 'up-term')).toMatchObject({ status: 'upgrade_failed', health: 'stopped' })
  })

  // ---- 守卫与幂等（spec §2.3）----

  it('重复触发幂等：已 upgrading → 200 同快照、不重复入队', async () => {
    const row = await seedLegacyContainer(fl, ctx, 'up-idem', ownerId)
    const first = await fl.orch.upgradeReserve('up-idem')
    expect(first.triggered).toBe(true)
    // 模拟在飞（后台未跑完）：再触发 → triggered=false（不重复 submit）
    const second = await fl.orch.upgradeReserve('up-idem')
    expect(second.triggered).toBe(false)
    expect(second.inst.status).toBe('upgrading')
    expect(second.inst.id).toBe(row.id)
    // 收尾：让后台跑完，避免后续共用 ctx 的 lock 残留（upgradeReserve 拿到 lease 未释放）
    await fl.orch.submitUpgrade('up-idem')
  })

  it('镜像已对齐 → 幂等 no-op（triggered=false、状态不被置 upgrading）', async () => {
    await fl.orch.create('up-noop', ownerId) // image = config.image（已对齐）
    const { inst, triggered } = await fl.orch.upgradeReserve('up-noop')
    expect(triggered).toBe(false)
    expect(inst.status).toBe('running')
  })

  it('busy：status ∉ {running, stopped}（creating/removing/error）→ 20043', async () => {
    const row = await seedLegacyContainer(fl, ctx, 'up-busy', ownerId)
    await ctx.prisma.container.update({ where: { id: row.id }, data: { status: 'creating' } })
    const err = await fl.orch.upgradeReserve('up-busy').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InstanceBusy)
    expect((err as ContainerDomainError).code).toBe(CODE.CONTAINER_BUSY)
  })

  it('upgrade_failed 再触发 → 20043 变体文案「仅可删除重建」', async () => {
    const row = await seedLegacyContainer(fl, ctx, 'up-fault', ownerId)
    await ctx.prisma.container.update({ where: { id: row.id }, data: { status: 'upgrade_failed', upgradeAttempts: 3 } })
    const err = await fl.orch.upgradeReserve('up-fault').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContainerDomainError)
    expect((err as ContainerDomainError).code).toBe(CODE.CONTAINER_BUSY)
    expect((err as Error).message).toContain('仅可删除重建')
  })

  it('bind 模式（named volumes 关闭）→ 20043「请删重建」', async () => {
    const flBind = makeFleetTest(ctx.prisma, { config: { namedVolumes: false } })
    // 直接种行（bind 模式守卫只看行 + config.namedVolumes，不经 allocator/不须 runtime 容器）
    await ctx.prisma.container.create({
      data: { name: 'up-bind', port: 19901, token: 'enc', tokenEncrypted: true, homeDir: '/h/up-bind', image: OLD_IMAGE, status: 'running', ownerId },
    })
    const err = await flBind.orch.upgradeReserve('up-bind').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContainerDomainError)
    expect((err as ContainerDomainError).code).toBe(CODE.CONTAINER_BUSY)
    expect((err as Error).message).toContain('请删重建')
  })

  it('升级中拒删：deleteReserve 对 upgrading → 20043；upgrade_failed 放行删除', async () => {
    const row = await seedLegacyContainer(fl, ctx, 'up-guard', ownerId)
    await ctx.prisma.container.update({ where: { id: row.id }, data: { status: 'upgrading' } })
    const err = await fl.orch.deleteReserve('up-guard').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContainerDomainError)
    expect((err as ContainerDomainError).code).toBe(CODE.CONTAINER_BUSY)
    expect((err as Error).message).toContain('升级中')
    // upgrade_failed 终态放行删除（既有清理路径）
    await ctx.prisma.container.update({ where: { id: row.id }, data: { status: 'upgrade_failed' } })
    const del = await fl.orch.deleteReserve('up-guard')
    expect(del.status).toBe('removing')
  })

  it('RunOnceError 携带退出码与输出（doctor 失败日志依据）', async () => {
    fl.runtime.oneshotExitCode = 7
    fl.runtime.oneshotOutput = 'legacy session store found\n'
    const err = await fl.runtime
      .runOnce({ image: 'img', cmd: ['openclaw', 'doctor', '--fix'] })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RunOnceError)
    expect((err as RunOnceError).exitCode).toBe(7)
    expect((err as RunOnceError).output).toContain('legacy session store')
  })

  // ---- 崩溃收敛（spec §2.5 reconcileUpgrading）----

  it('reconcile：upgrading + owned 容器 running → running，image 按 runtime 实况补记', async () => {
    // 场景 A：升级实际已完成（容器跑新镜像），进程崩在「记回行」前 → image 补记 target
    await fl.orch.create('rc-done', ownerId)
    await ctx.prisma.container.update({ where: { name: 'rc-done' }, data: { image: OLD_IMAGE, status: 'upgrading' } })
    await fl.orch.list({ ownerId })
    let row = await ctx.prisma.container.findUnique({ where: { name: 'rc-done' } })
    expect(row?.status).toBe('running')
    expect(row?.image).toBe(fl.config.image) // 实况容器跑 target → 补记 target
    // 场景 B：崩在拉镜像前（容器跑旧镜像）→ image 保持旧，needsUpgrade 仍为真（一致性按实况）
    await ctx.prisma.container.update({ where: { name: 'rc-done' }, data: { status: 'upgrading' } })
    const rec = fl.runtime.containers.get('rc-done')
    if (rec) rec.info = { ...rec.info, image: OLD_IMAGE } // 模拟旧镜像仍在跑
    await fl.orch.list({ ownerId })
    row = await ctx.prisma.container.findUnique({ where: { name: 'rc-done' } })
    expect(row?.status).toBe('running')
    expect(row?.image).toBe(OLD_IMAGE)
    const items = await fl.orch.list({ ownerId })
    expect(items.find((i) => i.name === 'rc-done')?.needs_upgrade).toBe(true)
  })

  it('reconcile：upgrading + 无容器/已停 → stopped + 计 1 次失败 attempt', async () => {
    await seedLegacyContainer(fl, ctx, 'rc-gone', ownerId)
    // 模拟升级中断后容器已消失：remove 容器 + 行置 upgrading
    await fl.runtime.remove('rc-gone')
    await ctx.prisma.container.update({ where: { name: 'rc-gone' }, data: { status: 'upgrading' } })
    await fl.orch.list({ ownerId })
    const row = await ctx.prisma.container.findUnique({ where: { name: 'rc-gone' } })
    expect(row?.status).toBe('stopped')
    expect(row?.upgradeAttempts).toBe(1)
    // 连续中断达 3 次 → 终态
    await ctx.prisma.container.update({ where: { name: 'rc-gone' }, data: { status: 'upgrading', upgradeAttempts: 2 } })
    await fl.orch.list({ ownerId })
    const after = await ctx.prisma.container.findUnique({ where: { name: 'rc-gone' } })
    expect(after?.status).toBe('upgrade_failed')
    expect(after?.upgradeAttempts).toBe(3)
  })

  it('reconcile：在飞升级（lock 持有）或 daemon 不可达 → 保持 upgrading 下次再对账', async () => {
    // 在飞升级：拿 name lease → list 跳过收敛
    const lease = fl.deps.lock.tryAcquire('rc-flight')
    expect(lease).not.toBeNull()
    await ctx.prisma.container.create({
      data: { name: 'rc-flight', port: 19101, token: 'enc', tokenEncrypted: true, homeDir: '/h/rc-flight', containerId: '', status: 'upgrading', image: OLD_IMAGE, ownerId },
    })
    await fl.orch.list({ ownerId })
    let row = await ctx.prisma.container.findUnique({ where: { name: 'rc-flight' } })
    expect(row?.status).toBe('upgrading') // lock 持有 → 不收敛
    lease?.release()

    // daemon 不可达 → 保持 upgrading
    await ctx.prisma.container.create({
      data: { name: 'rc-daemon', port: 19102, token: 'enc', tokenEncrypted: true, homeDir: '/h/rc-daemon', containerId: '', status: 'upgrading', image: OLD_IMAGE, ownerId },
    })
    fl.runtime.failGetFor.add('rc-daemon')
    await fl.orch.list({ ownerId })
    row = await ctx.prisma.container.findUnique({ where: { name: 'rc-daemon' } })
    expect(row?.status).toBe('upgrading')
    expect(row?.upgradeAttempts).toBe(0)
  })
})

// ---- REST 契约（接缝 #2 信封）：POST /containers/<name>/upgrade ----
describe('#699 POST /containers/:name/upgrade（信封 REST）', () => {
  let ctx: TestContext
  let fl: FleetTestContext

  beforeAll(async () => {
    ctx = await setupTestApp()
    fl = makeFleetTest(ctx.prisma)
    const { createApp } = await import('../src/app')
    const supertest = (await import('supertest')).default
    const app = createApp({ prisma: ctx.prisma, orchestrator: fl.orch, runtime: fl.runtime })
    ctx.request = supertest(app) as unknown as TestContext['request']
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // 轮询 list 直到 name 满足 predicate（detach 后台升级的异步收敛）。
  async function waitFor(
    access: string | undefined,
    name: string,
    predicate: (item: { status: string; needs_upgrade?: boolean } | undefined) => boolean,
    timeoutMs = 2000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const list = await ctx.request.get('/api/v1/containers').set(bearer(access))
      const item = list.body.data.find((i: { name: string }) => i.name === name)
      if (predicate(item)) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`waitFor timeout: ${name} 未在 ${timeoutMs}ms 内满足条件`)
  }

  it('owner 触发 → 同步返「升级中」快照；后台六步收敛 running + needs_upgrade=false', async () => {
    const u = await seedUser(ctx.prisma, 'up-rest', 'pw-uprest-secure')
    const lu = await login(ctx.request, 'up-rest', 'pw-uprest-secure')
    await fl.orch.create('up-rest-c', u.id)
    await ctx.prisma.container.update({ where: { name: 'up-rest-c' }, data: { image: OLD_IMAGE } })

    const res = await ctx.request.post('/api/v1/containers/up-rest-c/upgrade').set(bearer(lu.access))
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.status).toBe('upgrading') // 同步段返回升级中快照
    expect(res.body.data.needs_upgrade).toBe(true)

    // 后台收敛（inline 队列 detach 异步跑完）——轮询 list 直到 running + needs_upgrade=false
    await waitFor(lu.access, 'up-rest-c', (i) => i?.status === 'running' && i.needs_upgrade === false)
    // 升级期间容器被 recreate：container_id 换新
    const row = await ctx.prisma.container.findUnique({ where: { name: 'up-rest-c' } })
    expect(row?.image).toBe(fl.config.image)
    expect(row?.upgradeAttempts).toBe(0)
  })

  it('普通用户可升级自己的容器（无需 admin）；admin 也可升级他人容器', async () => {
    const owner = await seedUser(ctx.prisma, 'up-owner2', 'pw-upowner2-secure')
    await seedAdmin(ctx.prisma, 'up-adm', 'pw-upadm-secure')
    await fl.orch.create('up-mine', owner.id)
    await ctx.prisma.container.update({ where: { name: 'up-mine' }, data: { image: OLD_IMAGE } })
    // 普通 owner 触发
    const lo = await login(ctx.request, 'up-owner2', 'pw-upowner2-secure')
    let res = await ctx.request.post('/api/v1/containers/up-mine/upgrade').set(bearer(lo.access))
    expect(res.body.code).toBe(0)
    await waitFor(lo.access, 'up-mine', (i) => i?.status === 'running')
    // 重置为旧镜像，admin 触发
    await ctx.prisma.container.update({ where: { name: 'up-mine' }, data: { image: OLD_IMAGE } })
    const la = await login(ctx.request, 'up-adm', 'pw-upadm-secure')
    res = await ctx.request.post('/api/v1/containers/up-mine/upgrade').set(bearer(la.access))
    expect(res.body.code).toBe(0)
    await waitFor(la.access, 'up-mine', (i) => i?.status === 'running' && i.needs_upgrade === false)
  })

  it('越权他人容器 → 20040 与「不存在」逐字节同码', async () => {
    const victim = await seedUser(ctx.prisma, 'up-victim', 'pw-upvictim-secure')
    await seedUser(ctx.prisma, 'up-attacker', 'pw-upattacker-secure')
    await ctx.prisma.container.create({
      data: { name: 'up-victim-c', port: 19110, ownerId: victim.id, token: 't', tokenEncrypted: true, homeDir: '/h/v', image: OLD_IMAGE, status: 'running' },
    })
    const la = await login(ctx.request, 'up-attacker', 'pw-upattacker-secure')
    const cross = await ctx.request.post('/api/v1/containers/up-victim-c/upgrade').set(bearer(la.access))
    const missing = await ctx.request.post('/api/v1/containers/never-existed/upgrade').set(bearer(la.access))
    expect(cross.body).toEqual(missing.body)
    expect(cross.body.code).toBe(20040)
    expect(cross.body.data).toBeNull()
  })

  it('镜像已对齐 → 幂等 no-op（status 保持 running、不置 upgrading）', async () => {
    const u = await seedUser(ctx.prisma, 'up-noop2', 'pw-upnoop2-secure')
    const lu = await login(ctx.request, 'up-noop2', 'pw-upnoop2-secure')
    await fl.orch.create('up-noop-c', u.id) // image=target 已对齐
    const res = await ctx.request.post('/api/v1/containers/up-noop-c/upgrade').set(bearer(lu.access))
    expect(res.body.code).toBe(0)
    expect(res.body.data.status).toBe('running') // 不置 upgrading
    expect(res.body.data.needs_upgrade).toBe(false)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'up-noop-c' } })
    expect(row?.status).toBe('running')
  })

  it('升级中拒删 → DELETE 20043；upgrade_failed 可删', async () => {
    const u = await seedUser(ctx.prisma, 'up-guard2', 'pw-upguard2-secure')
    const lu = await login(ctx.request, 'up-guard2', 'pw-upguard2-secure')
    const row = await ctx.prisma.container.create({
      data: { name: 'up-guard-c', port: 19111, ownerId: u.id, token: 't', tokenEncrypted: true, homeDir: '/h/g', image: OLD_IMAGE, status: 'running' },
    })
    // 升级中（模拟在飞）→ DELETE 拒 20043
    await ctx.prisma.container.update({ where: { id: row.id }, data: { status: 'upgrading' } })
    let del = await ctx.request.delete('/api/v1/containers/up-guard-c').set(bearer(lu.access))
    expect(del.body.code).toBe(20043)
    // upgrade_failed 终态 → DELETE 放行（异步信封 removing）
    await ctx.prisma.container.update({ where: { id: row.id }, data: { status: 'upgrade_failed' } })
    del = await ctx.request.delete('/api/v1/containers/up-guard-c').set(bearer(lu.access))
    expect(del.body.code).toBe(0)
    expect(del.body.data).toEqual({ status: 'removing' })
  })

  it('name 非法 → 90002（区别于 20040）', async () => {
    await seedUser(ctx.prisma, 'up-inv', 'pw-upinv-secure')
    const lu = await login(ctx.request, 'up-inv', 'pw-upinv-secure')
    const res = await ctx.request.post('/api/v1/containers/INVALID/upgrade').set(bearer(lu.access))
    expect(res.body.code).toBe(90002)
  })

  it('未认证 → 10001', async () => {
    const res = await ctx.request.post('/api/v1/containers/x/upgrade')
    expect(res.body.code).toBe(10001)
  })
})
