// 写侧编排（平移 backend/containers/fleet/command.py，#334）——容器生命周期状态机核心。
//
// 与旧实现的两个刻意差异（均 #313 决议）：
//  1. Redis 分布式锁 → 进程内 NameLeaseMap（锁不依赖 Redis，即使 Redis 挂也防双创建/双删除）。
//  2. delete 遇在飞 create：旧「拒删 409（InstanceBusy）」→ 新「置取消标志 + 异步 delete」。
//     取消标志 = 进程内 Map<name,true>；provisioning 在 await 检查点检出即统一回滚后终止，
//     delete 在同 name 串行队列后接手清理（用户立即删、不干等 docker pull / 半建容器）。
//
// 状态机（5 态，DB 持久化 creating/removing/error + 创建成功后 running）：
//   creating → running ⇄ stopped → removing(终) + error（残留）。running/stopped 由读侧 runtime 实况推导。

import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient, Container } from '../generated/prisma/client'
import { TOKEN_URLSAFE_BYTES, HOME_BIND } from './constants'
import { CODE } from '../codes'
import { fail } from '../envelope'
import {
  ConfigurationError,
  InstanceBusy,
  InstanceCleanupError,
  InstanceExists,
  PortAllocationError,
  PortPoolExhausted,
  QuotaExceeded,
} from './errors'
import type { FleetDeps } from './deps'
import {
  namedVolumesFor,
  type ContainerInfo,
  type ContainerSpec,
  type NamedVolumes,
} from './runtime'
import { ConfigRenderer } from './configRenderer'

// 识别 docker 发布端口时的宿主 bind 冲突异常（归一化匹配两种来源措辞）：
// OS 层 bind 失败 "address already in use"；libnetwork portallocator "... port is already allocated"。
function isBindConflict(exc: unknown): boolean {
  const message = exc instanceof Error ? exc.message : String(exc)
  return message.includes('address already in use') || message.includes('already allocated')
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// 取消注册表（进程内）：delete 对在飞 create 的取消信号。provisioning 检查点检出。
export class CancelRegistry {
  private readonly flagged = new Set<string>()
  flag(name: string): void {
    this.flagged.add(name)
  }
  isCancelled(name: string): boolean {
    return this.flagged.has(name)
  }
  clear(name: string): void {
    this.flagged.delete(name)
  }
}

export type DeleteOutcome = 'removed' | 'not-found'

export class FleetCommand {
  private renderer: ConfigRenderer | null = null
  // create_reserve 取得的租约句柄登记表（跨阶段传递到 create_complete finally 释放）。
  private readonly leases = new Map<string, { release(): void }>()

  constructor(
    private readonly deps: FleetDeps,
    private readonly prisma: PrismaClient,
    private readonly cancel: CancelRegistry = new CancelRegistry(),
  ) {}

  // ---- create 阶段一：同步预占（确定性工作，请求线程安全）----
  // LLM key 缺失 → 90003；双创建/撞名 → 20041；端口耗尽 → 90004；超配额 → 20042。
  // ownerId 由路由层（归属已校验）传入；maxContainers 提供时按 owner 串行 count+create 收紧配额竞态。
  async createReserve(name: string, ownerId: string, maxContainers?: number): Promise<Container> {
    const doReserve = async (): Promise<Container> => {
      if (!this.deps.config.llmApiKey) throw new ConfigurationError('LLM_API_KEY')
      // 双创建防护：进程内租约（已被持有 = 并发/在飞 create）→ 快速失败 20041
      const lease = this.deps.lock.tryAcquire(name)
      if (lease === null) throw new InstanceExists(name)
      this.leases.set(name, lease)
      // recreate（删后同名重建）须先清上一轮 delete 可能残留的取消标志，否则本 create 在检查点误中止。
      // 仅在拿到租约（确认本 reservation 是新生命周期、无在飞 create）后才清——
      // 并发 retry 在租约被在飞 create 持有时抛 20041，不得清掉对方的取消标志（Codex 第三轮 ④[P1]）。
      this.cancel.clear(name)
      try {
        const inst = await this.reserveRow(name, ownerId)
        try {
          await this.ensureRenderer() // 模板损坏 fail-fast（确定性配置错误同步暴露）
        } catch (e) {
          // renderer 失败（模板损坏/缺失）→ 回滚刚 reserve 的行，释放名称/端口/配额。
          // 修前只 releaseLease，creating 行残留耗配额/占端口，recreate 被 20041 锁死（Codex 第三轮 ⑥[P2]）。
          await this.prisma.container.delete({ where: { id: inst.id } }).catch(() => {})
          throw e
        }
        return inst
        // 成功路径不释放租约：租约跨到后台 create_complete，finally 释放（覆盖 provisioning 全程）。
      } catch (e) {
        this.releaseLease(name)
        throw e
      }
    }
    if (maxContainers === undefined) return doReserve()
    // 配额 check-then-act 收紧（Codex C4）：按 owner 串行 count + reserve，单进程内消除并发不同名
    // 双双绕过 count、双创建超配额的窗口。串行段只覆盖 reserve（DB count + create），不含后台
    // provisioning（POST 不阻塞——provisioning 在 submitCreate 后台续跑）。
    return this.deps.quotaSerializer.enqueue(ownerId, async () => {
      const count = await this.prisma.container.count({ where: { ownerId } })
      if (count >= maxContainers) throw new QuotaExceeded(name)
      return doReserve()
    })
  }

  // ---- create 阶段三提交：入队后台完成（按 name 串行 + 队列并发上限）----
  // 返回的 Promise 在 provisioning 完成时 settle（供测试/同步语义 await）；路由层不 await（异步）。
  submitCreate(inst: Container): Promise<void> {
    return this.deps.serializer.enqueue(inst.name, async () => {
      try {
        await this.deps.queue.submit(() => this.runCreateComplete(inst))
      } catch (e) {
        // 队列不可达补偿（Codex C8）：queue.add reject 时 createComplete 从不执行，其 finally 不会
        // 释放 name lease → 路由 detach 的 catch 吞掉唯一失败信号后，lease 永久持有、行卡 creating，
        // recreate 被 InstanceExists(20041) 锁死。补偿：释放 lease + 标 error 行（均幂等）。
        this.releaseLease(inst.name)
        await this.markError(inst)
        throw e
      }
    })
  }

  // 同步语义封装（reserve + complete），供需要同步结果的调用方/测试。
  async create(name: string, ownerId: string): Promise<Container> {
    const inst = await this.createReserve(name, ownerId)
    return this.createComplete(inst, false)
  }

  // 事务预占 creating 行：name/port 冲突由 DB 唯一约束仲裁。
  // port 冲突（并发选同 port）→ 重试下一空闲 port；name 冲突 → InstanceExists（20041，不重试）。
  private async reserveRow(name: string, ownerId: string, extraUsed?: Set<number>): Promise<Container> {
    // gateway token 真值不落盘（AGENTS.md §5.2 / Codex C1）：DB 存 AES-GCM 密文，
    // createComplete 用时 decrypt 供 spec.gatewayToken（docker env 注入明文）。
    const token = this.deps.crypto.encrypt(randomBytes(TOKEN_URLSAFE_BYTES).toString('base64url'))
    // 重试预算 = 端口池候选数（Codex 第四轮⑥[P2]）而非固定 MAX_PORT_RETRIES：并发不同 owner 都选中
    // 同一最小空闲端口时，SQLite 唯一约束只放行一个，其余须重试下一候选——固定 8 次预算在并发 ≥9
    // 时耗尽（第 9 个请求 8 次全撞已分配端口 → 误报 90004 池耗尽），而池实际大量空闲。候选数上限
    // 保证每个候选端口至多尝试一次（DB 已用集每次重算），并发再多也不会假耗尽。
    const poolSize = this.deps.config.portEnd - this.deps.config.portStart + 1
    for (let attempt = 0; attempt < poolSize; attempt += 1) {
      // 代系 id（#360）：每代唯一，homeDir = instances/<id>/home 绑定代系——delete+同名 recreate
      // 用不同物理目录，防在飞 wiki/长扫描期间容器被删+同名重建给他人时读写新 owner 数据。
      // 循环内每次新生成（P2002 后换新 id+port，无死循环；UUID 碰撞概率忽略）。
      const id = randomUUID()
      const home = path.join(this.deps.config.root, 'instances', id, 'home')
      const port = this.deps.allocator.nextFree(await this.usedPorts(extraUsed))
      try {
        return await this.prisma.container.create({
          data: {
            id,
            name,
            port,
            token,
            tokenEncrypted: true,
            homeDir: home,
            containerId: '',
            status: 'creating',
            image: this.deps.config.image,
            ownerId,
          },
        })
      } catch (e) {
        if (this.isUniqueViolation(e)) {
          const nameTaken = await this.prisma.container.findUnique({ where: { name } })
          if (nameTaken) throw new InstanceExists(name)
          continue // 否则 port 冲突 → 重试下一 port
        }
        throw e
      }
    }
    throw new PortAllocationError(name)
  }

  private isUniqueViolation(e: unknown): boolean {
    return (e as { code?: string }).code === 'P2002'
  }

  // 已用端口 = DB 记账 ∪ daemon fleet label 端口 ∪ daemon 宿主发布端口 ∪ 宿主 bind 实测 ∪ extra（学习集）。
  private async usedPorts(extraUsed?: Set<number>): Promise<Set<number>> {
    const used = new Set<number>(
      (await this.prisma.container.findMany({ select: { port: true } })).map((r) => r.port),
    )
    if (extraUsed) for (const p of extraUsed) used.add(p)
    try {
      for (const info of await this.deps.runtime.listFleet()) {
        if (typeof info.port === 'number') used.add(info.port)
      }
    } catch {
      // daemon 不可达不阻断分配：DB 记账 + 宿主实测仍可给出候选
    }
    try {
      for (const p of await this.deps.runtime.hostPublishedPorts()) used.add(p)
    } catch {
      // 同上
    }
    for (let port = this.deps.config.portStart; port <= this.deps.config.portEnd; port += 1) {
      if (!used.has(port) && (await this.deps.portInUse(port))) used.add(port)
    }
    return used
  }

  // ---- create 阶段二：后台/同步完成 provisioning（mkdir + cp -a + 原子写 config + docker run）----
  // bind 端口冲突就地换端口重试（预算 = 池大小）；取消标志检查点检出即统一回滚后终止。
  async createComplete(inst: Container, preserveErrorRow: boolean): Promise<Container> {
    const name = inst.name
    // 代系绑定（#360）：instanceDir 基于 inst.id（每代唯一），非可复用的 name。
    const instanceDir = path.join(this.deps.config.root, 'instances', inst.id)
    const home = path.join(instanceDir, 'home')
    // bind 冲突重试预算 = 端口池候选数（非 reserveRow 的 DB 并发冲突预算——那是另一处独立预算）。
    const poolSize = this.deps.config.portEnd - this.deps.config.portStart + 1
    const learnedConflicts = new Set<number>()
    let directoryCreated = false
    let runAttempted = false
    let preexisting = false
    let current = inst
    try {
      for (let i = 0; i < poolSize; i += 1) {
        // 取消检查点：delete 已置取消标志 → 统一回滚后终止（不干等）。
        if (this.cancel.isCancelled(name)) {
          await this.finalizeFailedCreate(name, instanceDir, current, runAttempted, preexisting, directoryCreated, preserveErrorRow, new InstanceBusy(name))
        }
        try {
          preexisting = (await this.deps.runtime.get(name)) !== null
          if (!directoryCreated) {
            // instanceDir 基于 inst.id 每代全新（#360），无 name 时代的 orphan 冲突——直接建。
            // 先确保父目录 instances/ 存在，再非递归建叶子（对齐 Python parents=True + exist_ok=False）。
            await mkdir(path.dirname(instanceDir), { recursive: true })
            await mkdir(instanceDir, { recursive: false })
            directoryCreated = true
            // provision 只在目录首次创建时执行（bind 冲突重试复用已 provision 的 home）
            await this.deps.provisioner.provision(home)
          }
          // config 渲染（模板损坏 fail-fast 在此暴露，容器尚未创建——runAttempted 保持 false，
          // 失败走「未 run」清理分支）；#385：allowedOrigins 强制含面板 origin（隧道 Origin 校验
          // + 生产 ChatView 开箱可聊）
          const rendered = (await this.ensureRenderer()).render(this.deps.config.panelOrigin)
          // 取消检查点（render 后、create 前——覆盖随后 docker create / image pull 阻塞 IO 前的最后窗口）
          if (this.cancel.isCancelled(name)) {
            await this.finalizeFailedCreate(name, instanceDir, current, runAttempted, preexisting, directoryCreated, preserveErrorRow, new InstanceBusy(name))
          }
          runAttempted = true
          const spec: ContainerSpec = {
            name,
            image: this.deps.config.image,
            hostPort: current.port,
            // DB 存密文，docker env 须注入明文 gatewayToken——用时 decrypt（Codex C1）。
            gatewayToken: this.deps.crypto.decrypt(current.token),
            homeDir: home,
            // #590 named volume 拓扑（flag 开）：三卷 Mounts 替代 home host bind（buildRunOptions
            // 按 volumes 存在与否分支）；空卷首挂由镜像内 ~/.openclaw 骨架自动初始化（#588）。
            // config 无独立 bind（#591：落容器内默认路径，经 archive.writeConfig 写）
            volumes: this.volumesFor(inst.id),
            llmApiKey: this.deps.config.llmApiKey,
          }
          // #591 静态 config 顺序（对 #366「宿主 rename + ro bind 热加载」回退）：create（不启动）
          // → putArchive 写容器内 ~/.openclaw/openclaw.json → start——首启 gateway 即读渲染配置，
          // 无需重启；config 零宿主路径（named volume / bind home 内）。
          const containerId = await this.deps.runtime.create(spec)
          // #6xx named volume 拓扑：provision 的宿主树不进容器（卷首挂由镜像骨架初始化），
          // 模板 workspace（researcher 各项 md + skills）经 putArchive 灌卷补上——create 后
          // start 前（同 writeConfig 时序，putArchive 对 created 容器可用），首启 agent 即见
          // 完整 workspace。旧 bind 模式 provision 已宿主预填充 home，不重复灌。
          if (spec.volumes !== undefined) {
            await this.deps.archive.seedWorkspace(name, path.join(this.deps.config.templateDir, 'workspace'))
          }
          await this.deps.archive.writeConfig(inst.name, rendered)
          // 按 id 启动（#591）：create 返回的 id 精确指向本代容器——按 name 启动在外部 actor
          // 删/重建同名容器的窗口会错启他人容器
          await this.deps.runtime.startById(containerId)
          // 取消检查点（Codex 第七轮 #2）：DELETE 可能在 create（拉镜像/建容器）/ writeConfig /
          // start 期间到达——render 后检查点已过。start 后、持久化 running 前重查取消：检出即
          // finalizeFailedCreate（runAttempted=true 清已起/已 created 的容器），不覆盖
          // deleteReserve 已持久化的 removing、list 全程不显示 running。
          if (this.cancel.isCancelled(name)) {
            await this.finalizeFailedCreate(
              name,
              instanceDir,
              current,
              runAttempted,
              preexisting,
              directoryCreated,
              preserveErrorRow,
              new InstanceBusy(name),
            )
          }
          current = await this.prisma.container.update({
            where: { id: current.id },
            data: { containerId, status: 'running' },
          })
          return current
        } catch (exc) {
          if (isBindConflict(exc)) {
            // docker run bind 冲突 → 就地更新行端口、继续循环重试下一端口。
            learnedConflicts.add(current.port)
            // 残留容器清理不能吞：残留让下一轮撞 name 冲突。不清目录（行/目录/配置保留复用）。
            if (runAttempted && !preexisting) {
              try {
                const created = await this.deps.runtime.get(name)
                if (created?.containerId) {
                  await this.prisma.container.update({
                    where: { id: current.id },
                    data: { containerId: created.containerId },
                  })
                }
                await this.deps.runtime.remove(name, this.volumesFor(inst.id))
                await this.prisma.container.update({
                  where: { id: current.id },
                  data: { containerId: '' },
                })
              } catch {
                await this.markError(current)
                throw new InstanceCleanupError(name, instanceDir)
              }
            }
            let nextPort: number
            // 端口换选 + 落库（Codex 第六轮②[P2]）：update(port) 也可能撞 P2002——并发不同名 create 的
            // 各自 usedPorts 快照选了同一替换端口，port @unique 仲裁放行一个、拒另一个。旧实现不重试
            // 直接中止、行卡 creating；对齐 reserveRow 把 P2002 视作 learned conflict、重选下一候选。
            // 内层循环重选直至落库成功；learned 涨满池时 nextFree 抛 PortPoolExhausted 终止（有界）。
            // eslint-disable-next-line no-constant-condition
            while (true) {
              try {
                nextPort = this.deps.allocator.nextFree(await this.usedPorts(learnedConflicts))
              } catch (poolErr) {
                if (poolErr instanceof PortPoolExhausted) {
                  await this.finalizeFailedCreate(name, instanceDir, current, runAttempted, preexisting, directoryCreated, preserveErrorRow, new PortAllocationError(name))
                }
                throw poolErr
              }
              try {
                current = await this.prisma.container.update({
                  where: { id: current.id },
                  data: { port: nextPort },
                })
                break
              } catch (e) {
                if (this.isUniqueViolation(e)) {
                  learnedConflicts.add(nextPort) // 并发抢注 → 学下一候选重选
                  continue
                }
                throw e
              }
            }
            continue
          }
          // 非 bind 冲突 → 统一失败终态
          await this.finalizeFailedCreate(name, instanceDir, current, runAttempted, preexisting, directoryCreated, preserveErrorRow, exc)
        }
      }
      throw new PortAllocationError(name)
    } finally {
      // 租约随 createReserve 持有至此；统一在此释放（成功/回滚/重试耗尽/取消都释放）。
      this.releaseLease(name)
    }
  }

  // 后台入口：provisioning 失败仅记日志不传播（行已标 ERROR 供 list+delete 感知/重试）。
  private async runCreateComplete(inst: Container): Promise<void> {
    try {
      await this.createComplete(inst, true)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[fleet] background create failed for ${inst.name}`, e)
    }
  }

  // create_complete 失败的统一收尾（非 bind 分支 + bind 池耗尽 + 取消检出共用）。总以 throw 结尾。
  // 清残留容器 → 清目录（失败保留 ERROR 行 + raise InstanceCleanupError）→ 落失败终态 → raise 原异常。
  private async finalizeFailedCreate(
    name: string,
    instanceDir: string,
    inst: Container,
    runAttempted: boolean,
    preexisting: boolean,
    directoryCreated: boolean,
    preserveErrorRow: boolean,
    exc: unknown,
  ): Promise<never> {
    // remove 是否确认成功。false 且「本 create 尝试跑了新容器」→ 跳过目录清理（容器可能仍驻留、
    // 其 bind-mount home 数据在跑；删目录即删活数据，Codex 第三轮 ③[P1]）。
    let removeConfirmed = false
    // 是否观测到挂本行 instance label 的「自有」容器（Codex 第六轮①[P2]）：run 撞外部同名容器（另一
    // Docker actor 在慢 pull 期间抢先建 openclaw-gw-<name>、不带我们的 label、抛非 bind 名冲突）时，
    // 旧实现 get(name) 返回外部容器 → 按 name force-remove 误删外部、并把外部 containerId 冒领进本行。
    // 仅「挂本行 instance label」才视作 ours 并 remove/认领，对齐 delete 的 instanceName 所有权守卫。
    let ownedContainerObserved = false
    if (runAttempted && !preexisting) {
      try {
        const created = await this.deps.runtime.get(name)
        if (created && created.instanceName === inst.name) {
          ownedContainerObserved = true
          if (created.containerId) {
            await this.prisma.container.update({
              where: { id: inst.id },
              data: { containerId: created.containerId },
            })
          }
          await this.deps.runtime.remove(name, this.volumesFor(inst.id))
          await this.prisma.container.update({ where: { id: inst.id }, data: { containerId: '' } })
          removeConfirmed = true
        }
        // created 不符（外部同名容器 / 无 label / null）→ 非 ours：不 remove、不冒领 id。
        // #590 named volume 模式：created 为 null（run 失败未驻留/外部已删）时卷仍须清理——
        // remove 容器 404 幂等、仍尽力删卷（对齐 flag 关 dirRemover 无条件清宿主目录的语义）。
        if (created === null) {
          await this.deps.runtime.remove(name, this.volumesFor(inst.id))
        }
      } catch {
        // 清容器失败（daemon 故障/remove 抛错）：保留观测到的 id 供 ERROR 行后续 delete 证明所有权。
        // removeConfirmed 保持 false → 下方跳过目录清理（Codex 第三轮 ③[P1]）。
      }
    }
    // 仅「观测到自有容器且 remove 未确认」时保目录；其余（取消于 run 前 / 仅外部同名容器 / 无容器）
    // 保持原清理语义（不留 orphan 目录）。ownedContainerObserved 取代旧的 runAttempted&&!preexisting
    // 近似——后者在外部同名容器场景误判「可能仍有自有容器在跑」、留下本应清理的 orphan 目录。
    const containerMayStillRun = ownedContainerObserved && !removeConfirmed
    if (directoryCreated && !containerMayStillRun) {
      try {
        await this.deps.dirRemover(instanceDir)
      } catch {
        await this.markError(inst)
        throw new InstanceCleanupError(name, instanceDir)
      }
    }
    if (preserveErrorRow) {
      // 后台：POST 已返 creating 快照、行对客户端可见——失败保留 ERROR 行供 list+delete 感知。
      await this.markError(inst)
    } else {
      // 同步 create()：历史契约——失败删行回滚，调用方感知异常。
      await this.prisma.container.delete({ where: { id: inst.id } }).catch(() => {})
    }
    throw exc
  }

  private async markError(inst: Container): Promise<void> {
    await this.prisma.container
      .update({ where: { id: inst.id }, data: { status: 'error' } })
      .catch(() => {})
  }

  // stop + remove 已验证归属的容器。chown 前置（容器以 root 跑、bind-mount home 属主 root，
  // host 非 root 删会权限错）。volumes（#590 named volume 模式）透传 remove 连带删卷，且跳过
  // chown——卷随容器删（docker volume rm 不受属主约束），chown 只服务宿主 bind 目录清理；跳过
  // 也避免已停容器 chown 失败抛 InstanceCleanupError 卡 REMOVING、连卷都不删（防卷泄漏）。
  // 按 live.running 分叉（Codex 第四轮②[P2]）：
  // - 容器在跑：chown best-effort。ro 挂载的 openclaw.json 会让 chown -R 报错（Read-only file system，
  //   属预期——该文件宿主侧属控制面 uid、可删）；其余 home 内容已 chown 至控制面 uid，目录清理照常成功。
  // - 容器已停（外部 stop / exited）：docker 无法在 stopped 容器内 exec chown，但容器 root 进程可能
  //   已在 home 留 root 属主文件——直接 remove 会让非 root 控制面永久删不掉目录、行卡 REMOVING 重试
  //   无解。删除前置修复 root 属主文件的唯一机会 = start 恢复容器 → chown → 再 stop；修复失败 →
  //   抛 InstanceCleanupError 保留容器 + REMOVING 行（可重试），不 remove（保留下次修复机会）。
  private async stopAndRemove(name: string, live: ContainerInfo, volumes?: NamedVolumes): Promise<void> {
    if (!volumes) {
      if (live.running) {
        await this.deps.runtime
          .execSync(name, ['chown', '-R', String(process.getuid?.() ?? 0), HOME_BIND])
          .catch(() => {})
      } else {
        try {
          await this.deps.runtime.start(name)
          await this.deps.runtime.execSync(name, ['chown', '-R', String(process.getuid?.() ?? 0), HOME_BIND])
        } catch {
          throw new InstanceCleanupError(name, 'chown root-owned home failed before container removal')
        }
      }
    }
    await this.deps.runtime.stop(name)
    await this.deps.runtime.remove(name, volumes)
  }

  private releaseLease(name: string): void {
    this.leases.get(name)?.release()
    this.leases.delete(name)
  }

  // #590/#592 named volume 拓扑（ADR 0011，OPENCLAW_NAMED_VOLUMES）：默认开启，为代系 id（#360）
  // 派生三卷名（spec 挂载 / 删除连带 volume rm 共用）；显式关闭 → undefined（旧 bind）。
  // 卷名每代唯一——删容器连卷删、同名 recreate 用新卷组（防代系串读）。
  private volumesFor(instId: string): NamedVolumes | undefined {
    return this.deps.config.namedVolumes ? namedVolumesFor(instId) : undefined
  }

  // ---- delete：异步化（按 name 串行入队）----
  // 同步段：查行（归属已在路由层校验）；遇在飞 create 置取消标志；标 removing；入队后台清理。
  // 清理失败 → InstanceCleanupError（行留 REMOVING 可重试），由后台入口记日志。
  // 返回被删除行 ID（Codex 第五轮①[P1]）：路由层提交后台 delete 时携带，delete 执行时代系校验。
  async deleteReserve(name: string): Promise<{ id: string; status: string }> {
    const inst = await this.prisma.container.findUnique({ where: { name } })
    // 不应到达（路由层归属前置已 20040）；防御分支沿用同码（20040 = 不存在），非 20043 busy。
    if (!inst) throw fail(CODE.CONTAINER_NOT_FOUND)
    // 在飞 create：置取消标志（provisioning 检查点检出即统一回滚），不干等。
    this.cancel.flag(name)
    // 标 removing（终态前奏），list 轮询可见。
    await this.prisma.container.update({ where: { id: inst.id }, data: { status: 'removing' } })
    return { id: inst.id, status: 'removing' }
  }

  // delete 后台执行（按 name 串行——排在同 name 在飞 create 之后）。完成时 settle 供测试 await。
  // expectedId（Codex 第四轮①[P1]，代系绑定）：reconcileRemoving 的 requeueDelete 携带被观察 removing
  // 行的 ID。stale duplicate job 在用户 recreate 同名后到达时，delete 校验目标行代系，不匹配即跳过——
  // 否则 job 用 name 解析到新行、误删用户重建的容器/目录/数据。
  submitDelete(name: string, expectedId?: string): Promise<DeleteOutcome> {
    return this.deps.serializer.enqueue(name, async () => this.delete0(name, expectedId))
  }

  // 经队列跑 delete 本体并取回结果（inline 队列直接返回；BullMQ 经共享 Promise）。
  private async delete0(name: string, expectedId?: string): Promise<DeleteOutcome> {
    let outcome: DeleteOutcome = 'removed'
    await this.deps.queue.submit(async () => {
      outcome = await this.delete(name, expectedId)
    })
    return outcome
  }

  // delete 本体：容器 + 连数据删。home 清理失败不吞——保留行 + 标 REMOVING + raise（可重试）。
  async delete(name: string, expectedId?: string): Promise<DeleteOutcome> {
    const inst = await this.prisma.container.findUnique({ where: { name } })
    if (!inst) {
      this.cancel.clear(name)
      return 'not-found'
    }
    // 代系防护（Codex 第四轮①[P1]）：requeue 携带的 expectedId（被观察 removing 行 ID）与当前行不符
    // → 目标已被 recreate 换代。跳过全部清理（容器/目录/行），只清取消标志——stale duplicate job
    // 不误删用户重建的新行。直接 DELETE（无 expectedId）不受影响，按当前行正常清理。
    if (expectedId !== undefined && inst.id !== expectedId) {
      this.cancel.clear(name)
      return 'not-found'
    }
    // container_id 是本行拥有 runtime 容器的正向证据。先验证再 stop/remove（防误删外来同名容器）。
    // 崩溃窗口（Codex 第三轮 ②[P1]）：runtime.run() 已起容器，但进程在「prisma.update 存 containerId」
    // 前崩溃 → 行 creating + containerId=''。此时不能因 ID 为空就跳过清理（否则 docker 容器泄露）；
    // 改为 inspect runtime，用 instance label 匹配本行名来确认所有权，匹配则 stop+remove。
    const live = await this.deps.runtime.get(name)
    const volumes = this.volumesFor(inst.id)
    if (inst.containerId) {
      if (!live || live.containerId !== inst.containerId) {
        await this.prisma.container
          .update({ where: { id: inst.id }, data: { containerId: '' } })
          .catch(() => {})
        // #590 named volume 模式：实况容器不存在（外部已删）或不属本行 → 卷仍须显式清理
        // （flag 关时该路径由下方 dirRemover 无条件清宿主目录；remove 容器 404 幂等、仍尽力删卷）
        await this.deps.runtime.remove(name, volumes)
      } else {
        await this.stopAndRemove(name, live, volumes)
      }
    } else if (live && live.instanceName === inst.name) {
      // 无 containerId 但 runtime 实况容器 instance label 匹配本行 → 视为本行拥有，清理。
      await this.stopAndRemove(name, live, volumes)
    } else {
      // 无 containerId 且实况无本行容器（崩溃窗口后外部删/未起）：卷仍须清理（同上）
      await this.deps.runtime.remove(name, volumes)
    }
    // 优先由 DB home_dir 派生 instance_dir（创建时固化的 instances/<id> 绝对路径，代系绑定 #360）；
    // 信任本行 homeDir 末段、校验 grandparent=='instances' 防逃逸；占位/篡改回退 instances/<inst.id>。
    const recorded = path.dirname(inst.homeDir)
    const instanceDir =
      path.basename(path.dirname(recorded)) === 'instances'
        ? recorded
        : path.join(this.deps.config.root, 'instances', inst.id)
    // rmtree 前重查行身份：行已被并发 delete 删除或 recreate 替换 → 跳过目录清理（资源不属本行）。
    const current = await this.prisma.container.findUnique({ where: { name } })
    if (!current || current.id !== inst.id) {
      await this.prisma.container.delete({ where: { id: inst.id } }).catch(() => {})
      this.cancel.clear(name)
      return 'removed'
    }
    // 容器已被确认 stop+remove（或本就不存在）→ 立即逐出 chat pool（Codex 第五轮②[P2]）：
    // 放行下方 dirRemover 之前，目录清理失败（throw InstanceCleanupError）也不跳过逐出——
    // 否则容器已不复存在、gateway 已死，而 cached client 仍持续重连已消失的网关。
    // onEvict 幂等（M2 空挂点），重复调用无害。
    await this.deps.onEvict({ name: inst.name, port: inst.port })
    // 目录已不存在（外部清理/建行前崩溃）视为清理成功——否则行卡 REMOVING 重试永远撞同一路径。
    if (await pathExists(instanceDir)) {
      try {
        await this.deps.dirRemover(instanceDir)
      } catch {
        await this.prisma.container
          .update({ where: { id: inst.id }, data: { status: 'removing' } })
          .catch(() => {})
        throw new InstanceCleanupError(name, instanceDir)
      }
    }
    await this.prisma.container.delete({ where: { id: inst.id } })
    this.cancel.clear(name)
    return 'removed'
  }

  // 惰性构造 renderer：模板 JSON 仅供 create 使用，list/delete 不应因其损坏而失败。
  private async ensureRenderer(): Promise<ConfigRenderer> {
    if (this.renderer === null) {
      const templateText = await readFile(this.deps.config.templateJson, 'utf8')
      this.renderer = new ConfigRenderer(templateText)
    }
    return this.renderer
  }
}
