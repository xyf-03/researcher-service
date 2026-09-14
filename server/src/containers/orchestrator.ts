// 容器生命周期编排 facade（平移 backend/containers/fleet/orchestrator.py，#334）。
// 薄组合根：读侧委托 FleetReadModel（list/createdItem + creating 对账），写侧委托 FleetCommand
// （create/delete + 取消标志），共享依赖经 FleetDeps 单点注入。取消注册表读写共享（delete 置标志、
// create 检查点检出）。

import type { PrismaClient, Container } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { fail } from '../envelope'
import { CODE } from '../codes'
import type { FleetDeps } from './deps'
import { FleetCommand, CancelRegistry, type DeleteOutcome } from './command'
import { FleetReadModel, type ContainerSummary } from './readModel'

export class Orchestrator {
  private readonly cmd: FleetCommand
  readonly read: FleetReadModel

  constructor(
    deps: FleetDeps,
    prisma: PrismaClient,
    cancel: CancelRegistry = new CancelRegistry(),
  ) {
    this.cmd = new FleetCommand(deps, prisma, cancel)
    // requeueDelete 回调（Codex C6 + 第四轮①[P1]）：reconcileRemoving 对「removing 行 + runtime 仍驻留
    // 容器」经此重新入队 delete 继续清理。箭头延迟求值 this.cmd（此时已构造）；submitDelete 串行幂等，
    // 携带被观察行 ID（代系绑定）防 stale job 误删 recreate 的新行；catch 防 list 读路径抛错。
    this.read = new FleetReadModel(deps, prisma, async (name, rowId) => {
      await this.cmd.submitDelete(name, rowId).catch(() => {})
    })
  }

  // 写侧
  createReserve(name: string, ownerId: string, maxContainers?: number): Promise<Container> {
    return this.cmd.createReserve(name, ownerId, maxContainers)
  }
  submitCreate(inst: Container): Promise<void> {
    return this.cmd.submitCreate(inst)
  }
  create(name: string, ownerId: string): Promise<Container> {
    return this.cmd.create(name, ownerId)
  }
  createComplete(inst: Container, preserveErrorRow: boolean): Promise<Container> {
    return this.cmd.createComplete(inst, preserveErrorRow)
  }
  // 返回被删除行 ID（Codex 第五轮①[P1]，endpoint 代系绑定）：路由层提交后台 delete 时携带，
  // delete 执行时校验目标行仍是该代系——并发 DELETE 的 duplicate job 在 recreate 后到达时跳过
  // 清理，不误删用户重建的新行（对齐 reconcileRemoving 的 requeue 代系绑定）。
  deleteReserve(name: string): Promise<{ id: string; status: string }> {
    return this.cmd.deleteReserve(name)
  }
  submitDelete(name: string, expectedId?: string): Promise<DeleteOutcome> {
    return this.cmd.submitDelete(name, expectedId)
  }
  delete(name: string, expectedId?: string): Promise<DeleteOutcome> {
    return this.cmd.delete(name, expectedId)
  }
  // #699 升级（守卫/幂等/置 upgrading 同步段 + 后台六步编排异步段；对齐 delete 先例）
  upgradeReserve(name: string): Promise<{ inst: Container; triggered: boolean }> {
    return this.cmd.upgradeReserve(name)
  }
  submitUpgrade(name: string): Promise<void> {
    return this.cmd.submitUpgrade(name)
  }

  // 读侧
  list(where: { ownerId?: string } = {}): Promise<ContainerSummary[]> {
    return this.read.list(where)
  }
  // list + 行 ID（Codex 第五轮③[P2]，pairing 代系 join 用）
  listWithIds(where: { ownerId?: string } = {}): Promise<{ items: ContainerSummary[]; ids: Map<string, string> }> {
    return this.read.listWithIds(where)
  }
  createdItem(inst: Container): ContainerSummary {
    return this.read.createdItem(inst)
  }
}

// 单点归属前置（#312⑤ / #334：供 WIKI/models/chat/pairing 各域复用）。
// 按 name 查容器后追加 owner 判定：admin 全放行 / user 仅本人。
// 「不存在 vs 越权」同码 20040 防探测——对外逐字节一致，区分仅进服务端日志（owner_mismatch vs not_found）。
export async function getInstanceForUser(
  prisma: PrismaClient,
  user: AuthUser,
  name: string,
): Promise<Container> {
  const inst = await prisma.container.findUnique({ where: { name } })
  if (!inst) {
    // eslint-disable-next-line no-console
    console.warn(`[containers] not_found: name=${name} uid=${user.id}`)
    throw fail(CODE.CONTAINER_NOT_FOUND)
  }
  if (user.role !== 'admin' && inst.ownerId !== user.id) {
    // eslint-disable-next-line no-console
    console.warn(`[containers] owner_mismatch: name=${name} uid=${user.id} owner=${inst.ownerId}`)
    throw fail(CODE.CONTAINER_NOT_FOUND)
  }
  return inst
}
