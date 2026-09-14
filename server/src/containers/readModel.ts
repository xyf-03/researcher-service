// 读侧聚合（平移 backend/containers/fleet/read_model.py，#334）。
// list：DB 记账 + runtime 实时状态 + gateway 健康探测聚合；并发健康探测（有界 worker 池，Codex 第五轮④）。
// reconcileCreating：list 读路径上的 lazy-repair 对账（崩溃中断的 creating 行按 runtime 实况收敛）。
// running/stopped 由 runtime 实况动态推导（DB 只持久化 creating/removing/error + 创建成功后 running）。

import type { PrismaClient, Container } from '../generated/prisma/client'
import {
  HEALTH_HEALTHY,
  HEALTH_PENDING,
  HEALTH_REMOVING,
  HEALTH_STOPPED,
  HEALTH_UNHEALTHY,
} from './values'
import { UPGRADE_MAX_ATTEMPTS } from './constants'
import type { FleetDeps } from './deps'

// 有界并发 map（Codex 第五轮④[P2]）：admin 大 fleet 下 Promise.all 每个容器并发一次 docker inspect +
// 一次 HTTP 健康探测，池最大 1000 容器时一次轮询可开数百 socket/timer——耗尽 fd 或打挂 daemon。
// 保留并行（总延迟仍 bound 于最慢项）但经小型 worker 池（8）限流。
const PROBE_CONCURRENCY = 8

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next
      next += 1
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

// ContainerSummary（契约 §2.3）：{name, port, status, health, image, container_id, created_at}
// #699 增加 needs_upgrade：判定式 = 容器记录镜像 ≠ 当前目标镜像（config.fleet.image），schema 零改动。
export interface ContainerSummary {
  name: string
  port: number
  status: string
  health: string
  image: string
  container_id: string
  created_at: Date
  needs_upgrade: boolean
}

export class FleetReadModel {
  constructor(
    private readonly deps: FleetDeps,
    private readonly prisma: PrismaClient,
    // 重新入队 delete 回调（Codex C6 + 第四轮①[P1]）：reconcileRemoving 对「removing 行 + runtime 仍驻留容器」
    // 经此回调重新入队 delete 继续清理。Orchestrator 注入 cmd.submitDelete；不直接依赖 FleetCommand。
    // rowId = 被观察 removing 行的 ID（代系绑定，Codex 第四轮①）：requeue 携带旧行 ID，delete 执行时校验
    // 目标行仍是该代系——stale job 在用户 recreate 同名后到达时跳过清理，不误删新行/新容器。
    private readonly requeueDelete?: (name: string, rowId: string) => Promise<void>,
  ) {}

  private item(inst: Container, status: string, health: string): ContainerSummary {
    return {
      name: inst.name,
      port: inst.port,
      status,
      health,
      image: inst.image,
      container_id: inst.containerId,
      created_at: inst.createdAt,
      // #699 升级检测（spec §2.1）：容器记录镜像 ≠ 当前目标镜像 → 需升级。方向无关（降级拒绝下沉
      // 编排层 upgradeReserve）；升级成功记回 target 后自然转 false。
      needs_upgrade: inst.image !== this.deps.config.image,
    }
  }

  private async buildItem(inst: Container): Promise<ContainerSummary> {
    // creating/removing/error 瞬态透传（不探健康，避免暴露错误生命周期）。
    if (inst.status === 'creating') return this.item(inst, 'creating', HEALTH_PENDING)
    if (inst.status === 'removing') return this.item(inst, 'removing', HEALTH_REMOVING)
    if (inst.status === 'error') return this.item(inst, 'error', HEALTH_STOPPED)
    // #699 升级状态瞬态透传（spec §2.2）：upgrading 同 creating 不探健康（升级在飞、容器可能停机）；
    // upgrade_failed 终态 health 显示 stopped（容器已停/不可用，仅可删除重建）。
    if (inst.status === 'upgrading') return this.item(inst, 'upgrading', HEALTH_PENDING)
    if (inst.status === 'upgrade_failed') return this.item(inst, 'upgrade_failed', HEALTH_STOPPED)
    // runtime.get 可能因 daemon 不可用抛异常——单项抖动降级透传，不隐藏其它正常容器。
    // fallback 保留 DB 记账状态（Codex 第四轮⑤[P2]）：修前硬编码 status:'running'，把「已对账/存储
    // 为 stopped」的行在 daemon 故障期间返回成 running+health:stopped 矛盾组合，客户端误判为活动。
    let info
    try {
      info = await this.deps.runtime.get(inst.name)
    } catch {
      return this.item(inst, inst.status, HEALTH_STOPPED)
    }
    // label guard（Codex 第五轮⑤[P2]，对齐 reconcileCreating/reconcileRemoving/delete）：仅
    // openclaw.instance label 匹配本行名的容器才被采纳为本行拥有——受管容器消失后，外来同名
    // 容器会让 stale 行被误报为 running/healthy；不匹配 → 视为已停（stopped），并存的健康探测
    // 不执行。
    const owned = Boolean(info && info.instanceName === inst.name)
    const running = Boolean(info && info.running)
    if (!owned || !running) return this.item(inst, 'stopped', HEALTH_STOPPED)
    const health = (await this.deps.health.isReachable(inst.port)) ? HEALTH_HEALTHY : HEALTH_UNHEALTHY
    return this.item(inst, 'running', health)
  }

  // 主流程对账 creating 行：非活动持有（崩溃中断）者按 runtime 实况收敛，不再永久 pending 占名/占端口。
  // 活动持有判定经进程内 lock.isHeld（取代旧 Redis 锁探测）：本进程 create 在飞 → 跳过。
  private async reconcileCreating(insts: Container[]): Promise<void> {
    for (const inst of insts) {
      if (inst.status !== 'creating') continue
      // 有在飞 create（本进程持锁）→ 跳过对账；崩溃中断（无持有）→ 进入收敛。
      if (this.deps.lock.isHeld(inst.name)) continue
      let info
      try {
        info = await this.deps.runtime.get(inst.name)
      } catch {
        // daemon 临时不可用 → 逐行降级（保持 creating/pending，下次 list 再对账）。
        continue
      }
      // label guard：仅 openclaw.instance label 匹配本行名的容器才被采纳为本行拥有（防误采纳外来同名容器）。
      let next: { status: Container['status']; containerId?: string }
      if (info && info.running && info.instanceName === inst.name) {
        next = { status: 'running', containerId: info.containerId || undefined }
      } else if (info && info.instanceName === inst.name) {
        next = { status: 'stopped', containerId: info.containerId || undefined }
      } else {
        next = { status: 'error' }
      }
      try {
        await this.prisma.container.update({
          where: { id: inst.id },
          data: { status: next.status, ...(next.containerId ? { containerId: next.containerId } : {}) },
        })
        inst.status = next.status
        if (next.containerId) inst.containerId = next.containerId
      } catch {
        // 落盘失败不阻断本次出参（内存对象已收敛，下次 list 再对账）
      }
    }
  }

  // #699 升级行对账（spec §2.5）：服务重启后卡「升级中」的行在 list 路径收敛（镜像 reconcileCreating 的
  // lazy-repair）。活动升级判定经进程内 lock.isHeld——本进程升级在飞 → 跳过。
  // - owned 容器 running → running（image 补记 runtime 实况：升级已完成的新镜像在跑 → 记 target；
  //   崩在拉镜像前的旧镜像在跑 → 保持旧 image，needsUpgrade 仍为 true——按实况记录保证一致性）。
  // - 否则（容器已停/消失）→ stopped + 计 1 次失败 attempt（≥3 → upgrade_failed 终态，仅可删除）。
  // - daemon 不可达 → 保持 upgrading，下次 list 再对账。
  private async reconcileUpgrading(insts: Container[]): Promise<void> {
    for (const inst of insts) {
      if (inst.status !== 'upgrading') continue
      if (this.deps.lock.isHeld(inst.name)) continue
      let info
      try {
        info = await this.deps.runtime.get(inst.name)
      } catch {
        // daemon 临时不可用 → 逐行降级（保持 upgrading，下次 list 再对账）。
        continue
      }
      if (info && info.running && info.instanceName === inst.name) {
        const next: { status: Container['status']; image?: string; containerId?: string } = { status: 'running' }
        if (info.image) next.image = info.image
        if (info.containerId) next.containerId = info.containerId
        try {
          await this.prisma.container.update({ where: { id: inst.id }, data: next })
          inst.status = 'running'
          if (next.image) inst.image = next.image
          if (next.containerId) inst.containerId = next.containerId
        } catch {
          // 落盘失败不阻断本次出参（内存对象已收敛，下次 list 再对账）
        }
      } else {
        const attempts = inst.upgradeAttempts + 1
        const status: Container['status'] = attempts >= UPGRADE_MAX_ATTEMPTS ? 'upgrade_failed' : 'stopped'
        try {
          await this.prisma.container.update({
            where: { id: inst.id },
            data: { status, upgradeAttempts: attempts },
          })
          inst.status = status
        } catch {
          // 落盘失败不阻断本次出参（内存对象已收敛，下次 list 再对账）
        }
      }
    }
  }

  // removing 行对账（Codex C6）：进程重启后 BullMQ worker 的 tasks map 丢失，stalled/queued job
  // 经 processor 时 if(!task) return 被当成功移除但 lifecycle 操作未执行 → delete 中断的行卡 removing
  // 永不收敛（reconcileCreating 只处理 creating）。镜像 reconcileCreating 的 lazy-repair：
  // - 有在飞 create（本进程持锁）→ 跳过（不该此时删）。
  // - runtime 仍驻留容器（delete 未跑完）→ 经 requeueDelete 重新入队继续清理（串行幂等）。
  // - runtime 无容器（delete 已 stop+remove，仅删行没跑到）→ 删行收敛，不进 list 结果。
  // - daemon 不可达 → 保持 removing，下次 list 再对账。
  private async reconcileRemoving(insts: Container[]): Promise<Container[]> {
    const survivors: Container[] = []
    for (const inst of insts) {
      if (inst.status !== 'removing') {
        survivors.push(inst)
        continue
      }
      if (this.deps.lock.isHeld(inst.name)) {
        survivors.push(inst)
        continue
      }
      try {
        await this.deps.runtime.get(inst.name)
      } catch {
        // daemon 临时不可用 → 保持 removing，下次 list 再对账。
        survivors.push(inst)
        continue
      }
      // 经 requeueDelete 走 delete 本体收尾（Codex 第七轮 #5[P1]）：修前「无容器」分支在读路径直接
      // dirRemover + 删行，缺 delete 本体（command.ts delete() 的 current.id !== inst.id）代系 recheck
      // ——dirRemover（rm -rf 慢遍历）期间旧行被并发 delete 收尾删、用户同名 recreate 建新代系并写入
      // 新 home 数据时，此处的 rm 会误删新代系数据。统一「容器驻留 / 已不在」两分支经 requeueDelete
      // （携带 inst.id 代系绑定）交 delete 本体仲裁：行未换新则正常清容器/目录/删行（含 orphan 目录
      // 清理）；换新则跳过清理。
      // detach（void）：list 读路径不阻塞在删除完成上（Redis 不可达更糟），行异步收敛、下次 list 复见。
      void this.requeueDelete?.(inst.name, inst.id)
      survivors.push(inst)
    }
    return survivors
  }

  // 聚合 DB 记账 + runtime 实时状态 + gateway 健康探测。ownerId 过滤由路由层注入（隔离）。
  async list(where: { ownerId?: string } = {}): Promise<ContainerSummary[]> {
    const { items } = await this.listWithIds(where)
    return items
  }

  // list + 行 ID（Codex 第五轮③[P2]）：路由层 pairing 预取按 containerId 代系 join——
  // 仅按 name join 时，删除后同名 recreate 的竞态窗口会把新 owner 的 pairing 附到旧行摘要上。
  // id 是内部记账字段（不进 ContainerSummary API 契约），路由层用完即弃。
  async listWithIds(where: { ownerId?: string } = {}): Promise<{ items: ContainerSummary[]; ids: Map<string, string> }> {
    const insts = await this.prisma.container.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    })
    if (insts.length === 0) return { items: [], ids: new Map() }
    await this.reconcileCreating(insts)
    await this.reconcileUpgrading(insts)
    const survivors = await this.reconcileRemoving(insts)
    // 并发健康探测（有界 worker 池，bound 总延迟而非 N×timeout 串行、亦不无界并发）。
    return {
      items: await mapWithConcurrency(survivors, PROBE_CONCURRENCY, (inst) => this.buildItem(inst)),
      ids: new Map(survivors.map((inst) => [inst.name, inst.id])),
    }
  }

  // 由刚预占的 Container 构造 POST 响应（creating 态快照；不做二次 runtime 查询）。
  createdItem(inst: Container): ContainerSummary {
    return this.item(inst, inst.status, HEALTH_PENDING)
  }
}
