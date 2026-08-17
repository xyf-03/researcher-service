// 编排器 Port 测试（接缝 #5）：注入假 docker + 内存假队列，断言
// 5 态机 + 取消标志 + 端口入队前分配 + 补偿（bind 换端口重试 / REMOVING 可重试 / 端口耗尽 / 残留目录）。
// 覆盖 issue #334 验收标准的编排层（非 HTTP 壳）。

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupTestApp, type TestContext } from './setup'
import { makeFleetTest, type FleetTestContext } from './fleetTestUtils'
import { seedUser } from './helpers'
import {
  InstanceExists,
  InstanceCleanupError,
  PortAllocationError,
  ConfigurationError,
  QuotaExceeded,
} from '../src/containers/errors'
import { HOME_BIND } from '../src/containers/constants'

describe('orchestrator (接缝 #5 编排器 Port)', () => {
  let ctx: TestContext
  let fl: FleetTestContext
  let ownerId: string

  beforeAll(async () => {
    ctx = await setupTestApp()
    fl = makeFleetTest(ctx.prisma)
    const u = await seedUser(ctx.prisma, 'owner1', 'pw-owner1-secure')
    ownerId = u.id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  // ---- 端口入队前分配 + 5 态机 creating→running ----
  it('create 同步预占返 creating 快照（端口已分配），complete 后 running', async () => {
    const inst = await fl.orch.createReserve('web-one', ownerId)
    // 端口入队前分配：reserve 即带 port（池最小空闲 19000），status=creating
    expect(inst.status).toBe('creating')
    expect(inst.port).toBe(19000)
    expect(inst.containerId).toBe('')
    // home 路径固化 instances/<id>/home（代系绑定，#360）；token 已生成不落盘
    expect(inst.homeDir).toBe(path.join(fl.fleetRoot, 'instances', inst.id, 'home'))
    expect(inst.token.length).toBeGreaterThan(0)

    await fl.orch.createComplete(inst, true)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'web-one' } })
    expect(row?.status).toBe('running')
    expect(row?.containerId).not.toBe('')
    // runtime 已起容器，bind-mount home + 端口映射 + label 所有权
    const rec = fl.runtime.containers.get('web-one')
    expect(rec?.spec.hostPort).toBe(19000)
    expect(rec?.info.instanceName).toBe('web-one')
    // config 已经 FileArchive.putArchive 落容器内（#591 静态 config）+ 安全不变量（port 18789 /
    // bind lan / token 占位）；createComplete 顺序：create（不启动）→ 写 config → start
    const cfg = JSON.parse(await fl.archive.readConfig('web-one'))
    expect(cfg.gateway.port).toBe(18789)
    expect(cfg.gateway.bind).toBe('lan')
    expect(cfg.gateway.auth.token).toBe('${GATEWAY_TOKEN}')
    expect(rec?.info.running).toBe(true) // start 后 running（config 已先落容器内）
  })

  it('LLM key 缺失 → ConfigurationError（90003），不占端口不建行', async () => {
    const fl2 = makeFleetTest(ctx.prisma, { config: { llmApiKey: '' } })
    await expect(fl2.orch.createReserve('nokey', ownerId)).rejects.toBeInstanceOf(ConfigurationError)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'nokey' } })).toBeNull()
  })

  it('同名并发 create：租约互斥快速失败 20041，无双创建', async () => {
    const first = await fl.orch.createReserve('dup', ownerId)
    // 同名第二次 reserve（租约在飞）→ InstanceExists
    await expect(fl.orch.createReserve('dup', ownerId)).rejects.toBeInstanceOf(InstanceExists)
    await fl.orch.createComplete(first, true)
    // DB 仍只有一行 dup
    expect(await ctx.prisma.container.count({ where: { name: 'dup' } })).toBe(1)
    // 完成后租约释放，再次同名撞 DB 唯一约束 → InstanceExists（20041）
    await expect(fl.orch.createReserve('dup', ownerId)).rejects.toBeInstanceOf(InstanceExists)
  })

  it('撞名 20041 不分占用者：他人占用 name，我也撞', async () => {
    const other = await seedUser(ctx.prisma, 'other1', 'pw-other1-secure')
    await fl.orch.create('taken', other.id)
    await expect(fl.orch.createReserve('taken', ownerId)).rejects.toBeInstanceOf(InstanceExists)
  })

  it('delete + 同名 recreate 使用不同物理目录（代系隔离，#360）', async () => {
    // id 模式下每代用唯一 id 派生 instances/<id>/home；delete+同名 recreate 不重用上代目录。
    // 修前 homeDir 基于 name（instances/<name>/home），recreate 重用同路径——在飞 wiki/长扫描操作
    // 期间容器被删+同名 recreate 给他人会读写新 owner 数据（#360 根因）。
    const flg = makeFleetTest(ctx.prisma, { config: { portStart: 19720, portEnd: 19730 } })
    const inst1 = await flg.orch.create('gen-box', ownerId)
    const dir1 = path.join(flg.fleetRoot, 'instances', inst1.id)
    expect(inst1.homeDir).toBe(path.join(dir1, 'home'))
    expect(existsSync(dir1)).toBe(true)
    await flg.orch.delete('gen-box')
    expect(existsSync(dir1)).toBe(false)
    // 同名 recreate → 新代系 id → 新物理目录（修前重用 instances/<name>）
    const inst2 = await flg.orch.create('gen-box', ownerId)
    const dir2 = path.join(flg.fleetRoot, 'instances', inst2.id)
    expect(inst2.id).not.toBe(inst1.id)
    expect(dir2).not.toBe(dir1)
    expect(inst2.homeDir).toBe(path.join(dir2, 'home'))
    expect(existsSync(dir2)).toBe(true)
    expect(existsSync(dir1)).toBe(false) // 旧代系目录未随同名 recreate 复活
  })

  it('bind 端口冲突就地换端口重试：最终 running，端口前移', async () => {
    // 19000 已被前面容器占用；注入 19001 也 bind 冲突 → 应跳到 19002
    fl.runtime.bindConflictPorts.add(19001)
    const inst = await fl.orch.createReserve('bindy', ownerId)
    const reservedPort = inst.port // 入队前分配的端口（19001，因 19000 已占）
    fl.runtime.bindConflictPorts.add(reservedPort)
    await fl.orch.createComplete(inst, true)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'bindy' } })
    expect(row?.status).toBe('running')
    expect(row?.port).not.toBe(reservedPort) // 已就地换端口
    expect(fl.runtime.containers.get('bindy')?.spec.hostPort).toBe(row?.port)
  })

  it('非 bind 失败：后台保留 ERROR 行（preserveErrorRow），可 list+delete 感知', async () => {
    fl.runtime.failRunFor.add('broken')
    const inst = await fl.orch.createReserve('broken', ownerId)
    await expect(fl.orch.createComplete(inst, true)).rejects.toThrow()
    const row = await ctx.prisma.container.findUnique({ where: { name: 'broken' } })
    expect(row?.status).toBe('error') // ERROR 行保留，不静默消失
    // 目录已回滚清理
    expect(existsSync(path.join(fl.fleetRoot, 'instances', inst.id))).toBe(false)
  })

  it('端口池耗尽 → PortAllocationError（90004）', async () => {
    // 极小池（2 候选），全部 bind 冲突 → 重试预算（=池大小）耗尽
    const flSmall = makeFleetTest(ctx.prisma, {
      config: { portStart: 19500, portEnd: 19501 },
    })
    flSmall.runtime.bindConflictPorts.add(19500).add(19501)
    const inst = await flSmall.orch.createReserve('exhaust', ownerId)
    await expect(flSmall.orch.createComplete(inst, true)).rejects.toBeInstanceOf(PortAllocationError)
  })

  it('取消标志：delete 在飞 create，检查点检出即统一回滚后终止', async () => {
    // create 入队但未 complete；delete 置取消标志 → complete 检出即回滚（不跑 docker run）
    const inst = await fl.orch.createReserve('cancelme', ownerId)
    await fl.orch.deleteReserve('cancelme') // 置取消标志 + 标 removing
    // complete 在首个检查点检出取消 → finalizeFailedCreate（preserveErrorRow=true 标 error）
    await expect(fl.orch.createComplete(inst, true)).rejects.toThrow()
    // 未跑 docker run（取消于 run 前检查点）
    expect(fl.runtime.containers.has('cancelme')).toBe(false)
  })

  it('delete 完整生命周期：stop+remove 容器、清目录、删行、触发 evict', async () => {
    const evicted: { name: string; port: number }[] = []
    // 显式旧 bind：本用例断言 chown 前置（宿主目录清理语义；named volume 模式跳过 chown，#590）
    const fl3 = makeFleetTest(ctx.prisma, {
      config: { namedVolumes: false },
      onEvict: async (i) => {
        evicted.push(i)
      },
    })
    await fl3.orch.create('delme', ownerId)
    const created = await ctx.prisma.container.findUnique({ where: { name: 'delme' } })
    expect(created).not.toBeNull()
    await fl3.orch.delete('delme')
    expect(await ctx.prisma.container.findUnique({ where: { name: 'delme' } })).toBeNull()
    expect(fl3.runtime.containers.has('delme')).toBe(false)
    expect(existsSync(path.join(fl3.fleetRoot, 'instances', created!.id))).toBe(false)
    // chown 已被调用（root 容器 home 清理前置）
    expect(fl3.runtime.execCalls.some((c) => c.cmd[0] === 'chown' && c.cmd.includes(HOME_BIND))).toBe(true)
    // evict 钩子已触发（携带删除前的 name/port 供逐出）
    expect(evicted).toEqual([{ name: 'delme', port: created!.port }])
  })

  it('delete 清理失败：行标 REMOVING 可重试（20045）', async () => {
    const fl4 = makeFleetTest(ctx.prisma, {
      dirRemover: async () => {
        throw new Error('permission denied')
      },
    })
    await fl4.orch.create('stuck', ownerId)
    await expect(fl4.orch.delete('stuck')).rejects.toBeInstanceOf(InstanceCleanupError)
    const row = await ctx.prisma.container.findUnique({ where: { name: 'stuck' } })
    expect(row?.status).toBe('removing') // 行保留标 REMOVING
    // 容器已停删（重试只清目录 + 删行）
    expect(fl4.runtime.containers.has('stuck')).toBe(false)
  })

  it('同名 delete 排在在飞 create 后（按 name 串行）；recreate 清取消标志不误中止', async () => {
    // 覆盖 #334「同名并发 create/delete 串行化」：delete 经 submitDelete 入队，排在同 name
    // 在飞 create 之后执行——create 先完整 provisioning 成 running，delete 再接手清理。
    const inst = await fl.orch.createReserve('serialize-me', ownerId)
    await fl.orch.deleteReserve('serialize-me') // 置取消标志 + 标 removing
    const createPromise = fl.orch.submitCreate(inst) // 入队 create（inline 队列）
    const deletePromise = fl.orch.submitDelete('serialize-me') // 同 name → 排在 create 后
    const [, outcome] = await Promise.all([createPromise, deletePromise])
    // create 先跑完（cancel 标志已 flag 时 createComplete 检查点检出回滚、不跑 docker run），
    // delete 随后删行——最终无行、无容器、无目录。
    expect(outcome).toBe('removed')
    expect(await ctx.prisma.container.findUnique({ where: { name: 'serialize-me' } })).toBeNull()
    expect(fl.runtime.containers.has('serialize-me')).toBe(false)
    expect(existsSync(path.join(fl.fleetRoot, 'instances', inst.id))).toBe(false)
    // recreate（P2-5）：createReserve 入口清残留取消标志，同名重建不被误中止。
    await fl.orch.create('serialize-me', ownerId)
    expect((await ctx.prisma.container.findUnique({ where: { name: 'serialize-me' } }))?.status).toBe(
      'running',
    )
    expect(fl.runtime.containers.has('serialize-me')).toBe(true)
  })

  it('list 隔离：user 仅自己、admin 全部；running/stopped 由 runtime 实况推导', async () => {
    const a = await seedUser(ctx.prisma, 'lista', 'pw-lista-secure')
    const b = await seedUser(ctx.prisma, 'listb', 'pw-listb-secure')
    await fl.orch.create('a-box', a.id)
    await fl.orch.create('b-box', b.id)
    const ownList = await fl.orch.list({ ownerId: a.id })
    expect(ownList.map((i) => i.name)).toEqual(['a-box'])
    const all = await fl.orch.list({})
    expect(all.map((i) => i.name)).toEqual(expect.arrayContaining(['a-box', 'b-box']))
    // running（runtime 实况）+ health（health probe true → healthy）
    const aItem = all.find((i) => i.name === 'a-box')!
    expect(aItem.status).toBe('running')
    expect(aItem.health).toBe('healthy')
    // stop 后 list 推导 stopped
    await fl.runtime.stop('a-box')
    const stopped = (await fl.orch.list({})).find((i) => i.name === 'a-box')!
    expect(stopped.status).toBe('stopped')
    expect(stopped.health).toBe('stopped')
  })

  it('gateway token 加密落盘：DB 存密文、createComplete 解密供 spec 明文（Codex C1）', async () => {
    const inst = await fl.orch.createReserve('crypto-box', ownerId)
    // reserve 即落盘密文：tokenEncrypted=true，token 以 v1: 前缀（非明文）
    const reserved = await ctx.prisma.container.findUnique({ where: { name: 'crypto-box' } })
    expect(reserved?.tokenEncrypted).toBe(true)
    expect(reserved?.token.startsWith('v1:')).toBe(true)
    await fl.orch.createComplete(inst, true)
    // runtime 收到的 spec.gatewayToken 是解密后的明文（docker env 注入真 token，非 DB 密文）
    const rec = fl.runtime.containers.get('crypto-box')
    expect(rec?.spec.gatewayToken).toBeTruthy()
    expect(rec?.spec.gatewayToken.startsWith('v1:')).toBe(false)
    // 落盘密文 ≠ 注入明文（真值不落盘，AGENTS.md §5.2）
    const row = await ctx.prisma.container.findUnique({ where: { name: 'crypto-box' } })
    expect(row?.token).not.toBe(rec?.spec.gatewayToken)
  })

  it('配额 check-then-act 收紧：并发不同名 create 同 owner 不绕过配额（Codex C4）', async () => {
    // 独立 fl + 独立端口区间：隔离前面累积的 DB 行占端口，让配额逻辑成为唯一变量。
    const qfl = makeFleetTest(ctx.prisma, { config: { portStart: 19400, portEnd: 19410 } })
    const qOwner = await seedUser(ctx.prisma, 'qowner', 'pw-qowner-secure')
    // maxContainers=1 + 并发两个不同名 create：按 owner 串行化后恰一个成功、一个 QuotaExceeded，
    // 不双双绕过 count 双创建超配额（修复前 routes 层 count→create 的 check-then-act 让两者都过 count）。
    const results = await Promise.allSettled([
      qfl.orch.createReserve('q-a', qOwner.id, 1),
      qfl.orch.createReserve('q-b', qOwner.id, 1),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(QuotaExceeded)
    // DB 仅 1 行属该 owner（不超配额）
    expect(await ctx.prisma.container.count({ where: { ownerId: qOwner.id } })).toBe(1)
  })

  // ---- chown 停止容器处理（Codex 第四轮②[P2]）----
  // stopAndRemove 按 live.running 分叉（本组为旧 bind 清理语义，显式 namedVolumes: false——卷模式
  // 跳过 chown 前置，#590）：
  // - running 容器：chown best-effort（ro 挂载的 openclaw.json 让 chown -R 报错属预期，目录仍可删）。
  // - stopped 容器：docker 无法在 stopped 容器内 exec chown，但 root 进程可能已在 home 留 root 属主
  //   文件；直接 remove 让非 root 控制面永久删不掉目录、行卡 REMOVING 无解。修法：start 恢复 → chown
  //   修复 → 再 stop；修复失败 → 抛 InstanceCleanupError 保留容器 + REMOVING 行（不 remove 保留机会）。
  const chownFleet = () =>
    makeFleetTest(ctx.prisma, { config: { portStart: 19600, portEnd: 19610, namedVolumes: false } })

  it('chown: running 容器 chown 失败（ro 文件报错属预期）→ best-effort 吞掉、正常清理', async () => {
    const fl2 = chownFleet()
    // execSync 一律抛错（模拟 running 容器内 chown -R 撞 ro openclaw.json）。
    fl2.runtime.execSync = async () => {
      throw new Error('changing ownership: Read-only file system')
    }
    await fl2.orch.create('r4-ro', ownerId)
    await fl2.orch.delete('r4-ro')
    // running 分叉 best-effort：chown 失败不阻断，stop/remove/清目录/删行照常完成。
    expect(fl2.runtime.containers.has('r4-ro')).toBe(false)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'r4-ro' } })).toBeNull()
  })

  it('chown: 容器被外部停止 → start 恢复 → chown 修复 → 正常清理（root 属主文件可删）', async () => {
    const fl2 = chownFleet()
    await fl2.orch.create('r4-extstop', ownerId)
    // stopped 分支：start 恢复容器后执行一次 chown（修复 root 属主文件）→ 成功。
    const chowns: string[] = []
    fl2.runtime.execSync = async (name: string, cmd: string[]) => {
      if (cmd[0] === 'chown') chowns.push(name)
      fl2.runtime.execCalls.push({ name, cmd })
    }
    await fl2.runtime.stop('r4-extstop') // 容器已停（外部）
    await fl2.orch.delete('r4-extstop')
    // stopped 分叉：start 恢复 → chown 修复 → stop+remove+清目录+删行。
    expect(chowns).toEqual(['r4-extstop']) // chown 在 start 后执行一次（修前：stopped 容器不修复属主）
    expect(fl2.runtime.containers.has('r4-extstop')).toBe(false)
    expect(await ctx.prisma.container.findUnique({ where: { name: 'r4-extstop' } })).toBeNull()
  })

  it('chown: 容器已停且 start 也无法修复 → 抛错保留容器（不 remove 不留 root 目录孤儿）', async () => {
    const fl2 = chownFleet()
    // execSync 对任意 name 都抛（start 恢复后重试仍失败）→ stopAndRemove 整体抛 InstanceCleanupError。
    fl2.runtime.execSync = async () => {
      throw new Error('daemon unreachable')
    }
    await fl2.orch.create('r4-nofix', ownerId)
    await fl2.runtime.stop('r4-nofix')
    // 真实流程：deleteReserve 标 removing → submitDelete 执行 delete → start+chown 修复失败显式抛错。
    await fl2.orch.deleteReserve('r4-nofix')
    await expect(fl2.orch.submitDelete('r4-nofix')).rejects.toBeInstanceOf(InstanceCleanupError)
    // 容器保留（下次可重试修复）；行留 removing。
    expect(fl2.runtime.containers.has('r4-nofix')).toBe(true)
    expect((await ctx.prisma.container.findUnique({ where: { name: 'r4-nofix' } }))?.status).toBe('removing')
  })

  // ---- inspect 失败降级保留记账状态（Codex 第四轮⑤[P2]）----
  // buildItem 对 runtime.get 抛错（daemon 瞬时故障）的降级返回硬编码 status:'running'，把「已对账/
  // 存储为 stopped」的行在故障期间返回成 running+health:stopped 矛盾组合，客户端误判活动。修法：保留
  // DB 记账状态 inst.status，health 保持 stopped。

  it('list: daemon 故障时降级保留记账状态（stopped 行不硬编码 running）', async () => {
    const fl5 = makeFleetTest(ctx.prisma, { config: { portStart: 19620, portEnd: 19630 } })
    await fl5.orch.create('r4-insp', ownerId)
    // 模拟「已对账/存储为 stopped」的行（create 后行记账 running，此处改为 stopped 表示已识别为停止）。
    await ctx.prisma.container.update({ where: { name: 'r4-insp' }, data: { status: 'stopped' } })
    await fl5.runtime.stop('r4-insp')
    fl5.runtime.failGetFor.add('r4-insp') // daemon 瞬时故障 → runtime.get 抛错 → 走降级分支
    const items = await fl5.orch.list({ ownerId })
    const item = items.find((i) => i.name === 'r4-insp')
    expect(item).toBeDefined()
    expect(item!.status).toBe('stopped') // 修前：硬编码 'running'（矛盾 running+stopped）
    expect(item!.health).toBe('stopped')
  })

  // ---- 端口预留重试预算 = 池候选数（Codex 第四轮⑥[P2]）----
  // reserveRow 固定 MAX_PORT_RETRIES=8 次重试：并发不同 owner 都选中同一最小空闲端口时，SQLite 唯一
  // 约束只放行一个，其余须重试下一候选——固定 8 次在并发 ≥9 时耗尽（第 9 个请求 8 次全撞已分配端口
  // → 误报 90004 池耗尽），而池实际大量空闲。修法：预算 = 端口池候选数（每候选至多尝试一次）。

  it('端口预留：并发 10 不同名（池 16 候选）全部成功，不误报池耗尽', async () => {
    const pfl = makeFleetTest(ctx.prisma, { config: { portStart: 19500, portEnd: 19515 } })
    const pOwner = await seedUser(ctx.prisma, 'r4ports', 'pw-r4ports-secure')
    // 并发 10 个不同名 reserve：全部撞同一最小空闲端口（19500）→ SQLite 仲裁 + 重试下一候选。
    // 修前固定 8 次重试：至少 2 个在撞满 8 个已占端口后抛 PortAllocationError（90004）；
    // 修后预算 16 → 10 个全部拿到不同端口成功。
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => pfl.orch.createReserve(`r4p-${i}`, pOwner.id)),
    )
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(0)
    const rows = await ctx.prisma.container.findMany({ where: { ownerId: pOwner.id } })
    expect(rows).toHaveLength(10)
    // 端口互不重复（各得一个候选）
    expect(new Set(rows.map((r) => r.port)).size).toBe(10)
  })
})

// ---- #2 createComplete 在 runtime.create() 后未重查取消（Codex 第七轮 P2）----
// command.ts createComplete 的取消检查点在循环开头（render 前）与 render 后 create 前、start 后
// （#591：create → writeConfig → start）。DELETE 在 runtime.create()（拉镜像/创建容器）期间到达时：
// deleteReserve 已 flag + 标 removing，但 create 返回后 createComplete 仍会 start + update
// (status:'running') 覆盖 removing——错过取消回滚路径，list 轮询全程显示 running。
describe('#2 createComplete create 后重查取消 (Codex 第七轮 P2)', () => {
  let ctx: TestContext
  let ownerId: string
  beforeAll(async () => {
    ctx = await setupTestApp()
    ownerId = (await seedUser(ctx.prisma, 'r7owner2', 'pw-r7-2-secure')).id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('DELETE 在 create 期间到达 → create 后重查取消、走回滚（修前 update running 覆盖 removing）', async () => {
    const fl = makeFleetTest(ctx.prisma)
    const name = 'cancel-run'
    const inst = await fl.orch.createReserve(name, ownerId)
    // 注入：create 执行期间 DELETE 到达（flag + 标 removing），然后正常创建容器。
    const realCreate = fl.runtime.create.bind(fl.runtime)
    vi.spyOn(fl.runtime, 'create').mockImplementation(async (spec) => {
      await fl.orch.deleteReserve(spec.name) // 模拟 DELETE 在 create（拉镜像/创建）中到达
      return realCreate(spec)
    })
    // createComplete(preserveErrorRow=true 后台路径)：start 后应重查取消 → finalizeFailedCreate。
    await expect(fl.orch.createComplete(inst, true)).rejects.toThrow()
    const row = await ctx.prisma.container.findUnique({ where: { name } })
    // 修前：update running 覆盖 removing → status='running'；修后：finalizeFailedCreate 标 error。
    expect(row?.status).toBe('error')
    // 修前：容器驻留（run 起的）；修后：finalizeFailedCreate 清理容器。
    expect(fl.runtime.containers.has(name)).toBe(false)
  })
})

// #590/#592 named volume 拓扑编排（ADR 0011，OPENCLAW_NAMED_VOLUMES）
// 默认（本地/CI，#592）：createComplete 的 spec 携带代系 id（#360）派生三卷名；delete / bind
// 冲突清残留连带 docker volume rm 三卷（fake runtime 记录断言）。显式 false（旧 bind）：spec 不
// 携带 volumes、delete 不删卷。每用例独立 makeFleetTest（removedVolumes 记录无跨用例耦合）。
describe('named volume 编排（#590/#592）', () => {
  let ctx: TestContext
  let ownerId: string
  beforeAll(async () => {
    ctx = await setupTestApp()
    ownerId = (await seedUser(ctx.prisma, 'owner-nv', 'pw-nv-secure')).id
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  const nvFleet = () => makeFleetTest(ctx.prisma, { config: { namedVolumes: true } })
  const oldBindFleet = () => makeFleetTest(ctx.prisma, { config: { namedVolumes: false } })
  const volNames = (id: string) => ({
    wiki: `openclaw-wiki-${id}`,
    workspace: `openclaw-workspace-${id}`,
    home: `openclaw-home-${id}`,
  })

  it('默认（#592 新默认）：createComplete 的 spec 携带代系 id 派生三卷名', async () => {
    const fl = makeFleetTest(ctx.prisma)
    const inst = await fl.orch.createReserve('nv-default', ownerId)
    await fl.orch.createComplete(inst, true)
    expect(fl.runtime.containers.get('nv-default')?.spec.volumes).toEqual(volNames(inst.id))
  })

  it('显式 false（旧 bind）：spec 不携带 volumes（旧行为保留）', async () => {
    const fl = oldBindFleet()
    const inst = await fl.orch.createReserve('old-bind', ownerId)
    await fl.orch.createComplete(inst, true)
    expect(fl.runtime.containers.get('old-bind')?.spec.volumes).toBeUndefined()
  })

  it('flag 开启：delete 连带 docker volume rm 三卷（代系 id 派生），容器也删', async () => {
    const fl = nvFleet()
    const inst = await fl.orch.createReserve('nv-del', ownerId)
    await fl.orch.createComplete(inst, true)
    await fl.orch.delete('nv-del')
    expect(fl.runtime.removedVolumes).toEqual([
      volNames(inst.id).wiki,
      volNames(inst.id).workspace,
      volNames(inst.id).home,
    ])
    expect(fl.runtime.containers.has('nv-del')).toBe(false)
  })

  it('flag 开启：run bind 冲突换端口重试，清残留容器连带删卷', async () => {
    const fl = nvFleet()
    const inst = await fl.orch.createReserve('nv-bind', ownerId)
    fl.runtime.bindConflictPorts.add(inst.port)
    await fl.orch.createComplete(inst, true)
    const rec = fl.runtime.containers.get('nv-bind')
    expect(rec?.spec.hostPort).not.toBe(inst.port) // 换端口成功
    // 第一次 run 的残留容器被 remove 时连带删卷
    expect(fl.runtime.removedVolumes).toEqual([
      volNames(inst.id).wiki,
      volNames(inst.id).workspace,
      volNames(inst.id).home,
    ])
  })

  it('flag 开启：容器已被外部删除（live null）→ delete 仍连带删卷（防卷泄漏，对齐 flag 关 dirRemover 语义）', async () => {
    const fl = nvFleet()
    const inst = await fl.orch.createReserve('nv-ext-del', ownerId)
    await fl.orch.createComplete(inst, true)
    fl.runtime.containers.delete('nv-ext-del') // 外部 actor 删容器（不入库标记）
    await fl.orch.delete('nv-ext-del')
    expect(fl.runtime.removedVolumes).toEqual([
      volNames(inst.id).wiki,
      volNames(inst.id).workspace,
      volNames(inst.id).home,
    ])
    // 行已删（外部删容器不阻断 delete 收尾）
    expect(await ctx.prisma.container.findUnique({ where: { name: 'nv-ext-del' } })).toBeNull()
  })

  it('flag 开启：run 失败且容器未驻留（外部已删）→ finalizeFailedCreate 连带删卷', async () => {
    const fl = nvFleet()
    const inst = await fl.orch.createReserve('nv-fail-ext', ownerId)
    fl.runtime.failRunFor.add('nv-fail-ext') // run 抛非 bind 错 → finalizeFailedCreate
    await expect(fl.orch.createComplete(inst, true)).rejects.toThrow()
    expect(fl.runtime.removedVolumes).toEqual([
      volNames(inst.id).wiki,
      volNames(inst.id).workspace,
      volNames(inst.id).home,
    ])
  })

  it('flag 开启：delete 跳过 chown 前置（卷随删，chown 只服务宿主 bind 目录清理）', async () => {
    const fl = nvFleet()
    const inst = await fl.orch.createReserve('nv-nochown', ownerId)
    await fl.orch.createComplete(inst, true)
    await fl.orch.delete('nv-nochown')
    expect(fl.runtime.execCalls).toEqual([]) // 无 chown execSync（flag 关时必有一条）
    expect(fl.runtime.removedVolumes).toHaveLength(3)
  })

  it('显式 false（旧 bind）：delete 不删卷（旧行为）', async () => {
    const fl = oldBindFleet()
    const inst = await fl.orch.createReserve('old-del', ownerId)
    await fl.orch.createComplete(inst, true)
    await fl.orch.delete('old-del')
    expect(fl.runtime.removedVolumes).toEqual([])
  })
})
