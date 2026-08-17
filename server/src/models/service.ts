// ModelProviderService —— 每容器 model provider CRUD + 写后重渲染（#336）。
//
// 事务语义（对齐 Django models/views._save_and_rewrite / _delete_and_rewrite）：
//   DB mutation（tx）+ 读 tx 全量 providers + writer.rewrite 在同一事务内 —— rewrite 写盘失败
//   抛 ConfigWriteError → 事务回滚 DB 行（90003），DB 与盘上配置绝不发散；
//   unique(containerId, providerId) 并发冲突 → P2002 → 40041；目标行缺失 → P2025 → 40040。
//
// 归属前置（容器级 20040 防探测）由路由层 getInstanceForUser 完成，本服务只操作「已通过归属
// 校验的容器行」。provider 级「不存在 vs 越权」同码 40040（#336 验收）：非 owner 到不了 provider
// 级（容器门已挡），对外两者逐字节一致、区分仅进服务端日志。

import type { Container, ModelProvider, PrismaClient } from '../generated/prisma/client'
import { ConfigWriteError } from '../containers/errors'
import { fail, EnvelopeError } from '../envelope'
import { CODE } from '../codes'
import { type ProviderSpec } from './configBuilder'
import type { ModelConfigWriter } from './configWriter'
import { API_ENUM_TO_WIRE, WIRE_TO_API_ENUM, type ProviderApiWire } from './values'

// 写侧输入（路由层已把 snake_case body 经 zod 校验后映射为 camelCase domain shape）
export interface ModelProviderWriteInput {
  providerId: string
  api: ProviderApiWire
  baseUrl: string
  apiKeyEnvId: string
  authHeader: boolean
  models: Array<Record<string, unknown>>
}

// 读侧输出（snake_case wire，对齐 Django ModelProviderReadSerializer / 前端 models.ts）
export interface ModelProviderView {
  id: string
  provider_id: string
  api: ProviderApiWire
  base_url: string
  api_key_env_id: string
  auth_header: boolean
  models: Array<Record<string, unknown>>
  created_at: Date
}

// 事务内只用到 modelProvider 的投影（对齐 auth.rotateInTx 的 Pick<PrismaClient,…> 接缝写法）；
// container 供 assertWritable 事务内重查状态谓词（#366 codex P2，见下）。
type ProviderTx = Pick<PrismaClient, 'modelProvider' | 'container'>

// 防御解码 modelsJson（对齐 containers.decodeScopes）：坏 JSON 让 list 请求 500；合法 JSON 但
// 非数组也违反 models[] 响应契约 → 回退 []。
function decodeModels(raw: string): Array<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse(raw)
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>
  } catch {
    // 坏 JSON → 回退 []
  }
  return []
}

function toSpec(row: ModelProvider): ProviderSpec {
  return {
    providerId: row.providerId,
    api: API_ENUM_TO_WIRE[row.api],
    baseUrl: row.baseUrl,
    apiKeyEnvId: row.apiKeyEnvId,
    authHeader: row.authHeader,
    models: decodeModels(row.modelsJson),
  }
}

function toView(row: ModelProvider): ModelProviderView {
  return {
    id: row.id,
    provider_id: row.providerId,
    api: API_ENUM_TO_WIRE[row.api],
    base_url: row.baseUrl,
    api_key_env_id: row.apiKeyEnvId,
    auth_header: row.authHeader,
    models: decodeModels(row.modelsJson),
    created_at: row.createdAt,
  }
}

// #366 codex 四轮 P2「serialize recovery with normal per-container writes」：routes 每请求新建
// ModelProviderService 实例，实例级锁跨请求不共享（wiki #346 同款坑）→ 模块级按容器串行化。
// 锁包住「事务 + catch reconcile」整段：失败请求的 reconcile 与并发的成功 mutation 不再交错——
// 否则 reconcile 的「读 DB → fs 写盘」可能读到旧态、在并发 mutation 落盘后把盘覆盖回旧配置
// （静默发散）。DB 侧 better-sqlite3 单连接本就串行，这里同步的是 fs 写盘这一不受事务保护的资源。
const perContainerLocks = new Map<string, Promise<unknown>>()
async function withContainerLock<T>(containerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = perContainerLocks.get(containerId) ?? Promise.resolve()
  const next = prev.then(fn, fn) // 前任失败不毒化链路：fn 照跑
  perContainerLocks.set(containerId, next)
  try {
    return await next
  } finally {
    if (perContainerLocks.get(containerId) === next) perContainerLocks.delete(containerId)
  }
}

export class ModelProviderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly writer: ModelConfigWriter,
  ) {}

  async list(inst: Container): Promise<ModelProviderView[]> {
    const rows = await this.prisma.modelProvider.findMany({
      where: { containerId: inst.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return rows.map(toView)
  }

  async get(inst: Container, pid: string): Promise<ModelProviderView> {
    return toView(await this.requireProvider(inst.id, pid))
  }

  // create/update/delete 共用事务骨架：
  //   tx 内做 DB mutation → 读 tx 全量 providers → writer.rewrite。
  //   rewrite 写盘失败抛 ConfigWriteError → 事务回滚（DB 行不留 orphan）；P2002/P2025 同路径转译。
  // #366 两轮（codex P1/P2）事务加固：
  //   ① 显式 timeout 30s——Prisma 交互式事务默认 5s，rewrite 含 fs 写盘（慢卷/锁时可能超 5s），
  //      超时后 DB 回滚但 fs 操作不可取消仍可能落盘 → 盘上配置领先 DB 发散；30s 让写盘有足够
  //      时间完成（回滚只发生在写盘真失败：fs 已失败未落盘）。
  //   ② 事务内状态谓词 assertWritable——路由层 resolveWrite 的 removing/creating 检查基于请求前
  //      快照（check-then-act，codex P2「removal check is not atomic with mutations」），快照通过后
  //      removing 可被并发 DELETE 标定；事务内重查行状态消除 TOCTOU，removing/creating 拒写 20043
  //      （removing 期间写盘会与 delete 后台 rmtree 竞态 → orphan 目录残留）。
  //   ③ catch reconcile——事务仍可能回滚（超时/commit 失败）而 rewrite 已成功落盘：回滚后 DB 即旧
  //      状态，读回滚后 providers 重写盘上 → 盘=DB 恢复一致（codex P1「rollback-safe」而非仅依赖
  //      「30s 足够长」）。
  // 三写操作共用：按容器串行化「事务 + catch reconcile」整段（withContainerLock 注释），
  // 防失败请求的 reconcile 读-写与并发成功 mutation 交错覆盖（codex 四轮 P2）。
  async create(inst: Container, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    return withContainerLock(inst.id, () => this.createInner(inst, input))
  }

  private async createInner(inst: Container, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    try {
      const row = await this.prisma.$transaction(
        async (tx) => {
          await this.assertWritable(tx, inst.id)
          const created = await tx.modelProvider.create({
            data: {
              containerId: inst.id,
              providerId: input.providerId,
              api: WIRE_TO_API_ENUM[input.api],
              baseUrl: input.baseUrl,
              apiKeyEnvId: input.apiKeyEnvId,
              authHeader: input.authHeader,
              modelsJson: JSON.stringify(input.models),
            },
          })
          await this.rewrite(tx, inst)
          return created
        },
        { timeout: 30_000 },
      )
      return toView(row)
    } catch (e) {
      // #366 codex 四轮 P2：reconcile 只在「rewrite 成功落盘后事务才回滚」（盘上领先 DB）触发——
      // P2002/P2025（mutation 抛错、rewrite 未执行）、ConfigWriteError（fs 真失败、盘未变）、
      // busy（谓词拒写）均盘=DB 一致，跳过（无条件 reconcile 正是 stale-write 竞态面）。
      if (this.needsReconcile(e)) await this.reconcile(inst)
      this.rethrowKnown(e)
    }
  }

  async update(inst: Container, pid: string, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    return withContainerLock(inst.id, () => this.updateInner(inst, pid, input))
  }

  private async updateInner(inst: Container, pid: string, input: ModelProviderWriteInput): Promise<ModelProviderView> {
    try {
      const row = await this.prisma.$transaction(
        async (tx) => {
          await this.assertWritable(tx, inst.id)
          // 复合唯一 where 定位目标行（路径 pid）：不存在 → P2025 → 40040。
          // data.providerId 可为新 pid（PUT 改 provider_id），撞同容器既有 pid → P2002 → 40041。
          const updated = await tx.modelProvider.update({
            where: { containerId_providerId: { containerId: inst.id, providerId: pid } },
            data: {
              providerId: input.providerId,
              api: WIRE_TO_API_ENUM[input.api],
              baseUrl: input.baseUrl,
              apiKeyEnvId: input.apiKeyEnvId,
              authHeader: input.authHeader,
              modelsJson: JSON.stringify(input.models),
            },
          })
          await this.rewrite(tx, inst)
          return updated
        },
        { timeout: 30_000 },
      )
      return toView(row)
    } catch (e) {
      if (this.needsReconcile(e)) await this.reconcile(inst)
      this.rethrowKnown(e, { containerId: inst.id, pid })
    }
  }

  async remove(inst: Container, pid: string): Promise<void> {
    return withContainerLock(inst.id, () => this.removeInner(inst, pid))
  }

  private async removeInner(inst: Container, pid: string): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          await this.assertWritable(tx, inst.id)
          await tx.modelProvider.delete({
            where: { containerId_providerId: { containerId: inst.id, providerId: pid } },
          })
          await this.rewrite(tx, inst)
        },
        { timeout: 30_000 },
      )
    } catch (e) {
      if (this.needsReconcile(e)) await this.reconcile(inst)
      this.rethrowKnown(e, { containerId: inst.id, pid })
    }
  }

  // 读目标行（containerId + provider_id 复合定位）。不存在 → 40040（防探测，data 恒 null）。
  private async requireProvider(containerId: string, pid: string): Promise<ModelProvider> {
    const row = await this.prisma.modelProvider.findFirst({
      where: { containerId, providerId: pid },
    })
    if (!row) {
      // eslint-disable-next-line no-console
      console.warn(`[models] provider_not_found: containerId=${containerId} pid=${pid}`)
      throw fail(CODE.PROVIDER_NOT_FOUND)
    }
    return row
  }

  private async rewrite(tx: ProviderTx, inst: Container): Promise<void> {
    const rows = await tx.modelProvider.findMany({
      where: { containerId: inst.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    await this.writer.rewrite({ name: inst.name, id: inst.id, providers: rows.map(toSpec) })
  }

  // #366 codex P2「事务内状态谓词」：路由层 resolveWrite 的 creating/removing 检查基于请求前快照，
  // 与并发 DELETE（deleteReserve 标 removing → 后台清容器/目录）无共享串行化——快照通过后状态可能已变。
  // 这里在事务内重查行状态，把「removing 拒写」与 DB mutation 收进同一事务，消除 check-then-act
  // TOCTOU：removing 期间放行写盘会与删容器竞态（#591 起写经 putArchive——容器已删则写失败、
  // 未删则写落孤儿容器/目录）。
  // 行不存在（并发删完）与 creating/removing 同拒 20043。
  private async assertWritable(tx: ProviderTx, containerId: string): Promise<void> {
    const inst = await tx.container.findUnique({ where: { id: containerId } })
    if (!inst || inst.status === 'creating' || inst.status === 'removing') {
      throw fail(CODE.CONTAINER_BUSY, '容器正在创建/删除中，暂不能配置模型，请稍候')
    }
  }

  // #366 codex 四轮 P2「reconcile only failures known to occur after a successful rewrite」：
  // 仅「rewrite 成功落盘后事务才回滚」（P2028 交互事务超时 / commit 失败）需要 reconcile——fs 写盘
  // 不可取消、可能已落新配置，盘上领先 DB。P2002/P2025（mutation 抛错、rewrite 未执行）、
  // ConfigWriteError（putArchive 写失败、盘未变）、CONTAINER_BUSY（谓词拒写）均盘=DB 一致，reconcile 是
  // 多余写盘 → 跳过。多余写盘即 stale-write 竞态面：与并发的成功 mutation 交错会覆盖新配置
  // （withContainerLock 已把本恢复与正常写串行化，此处再收窄避免无谓的盘写入）。
  private needsReconcile(e: unknown): boolean {
    if (e instanceof EnvelopeError && e.code === CODE.CONTAINER_BUSY) return false
    if (e instanceof ConfigWriteError) return false
    const code = (e as { code?: string }).code
    return code !== 'P2002' && code !== 'P2025'
  }

  // #366 codex P1「rollback-safe」：事务回滚（P2028 超时/commit 失败）时事务内 rewrite 的 fs 写盘
  // 不可取消、可能已落盘 → DB 回滚但盘上领先发散。回滚后 DB 即旧状态：读回滚后的 providers →
  // rewrite 盘上 → 盘=DB 恢复一致。best-effort——reconcile 自身 fs 失败（同故障面）不掩盖原始错误，
  // 留日志即可，下次任何成功 rewrite 会自然对齐。
  private async reconcile(inst: Container): Promise<void> {
    try {
      const rows = await this.prisma.modelProvider.findMany({
        where: { containerId: inst.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      await this.writer.rewrite({ name: inst.name, id: inst.id, providers: rows.map(toSpec) })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[models] reconcile_failed: containerId=${inst.id} err=${(e as Error).message}`)
    }
  }

  // 已知领域错误转译；其余按原样上抛（ConfigurationError 90003 走错误面 ContainerDomainError 分支）。
  // ctx 供「不存在 vs 越权」的日志区分：对外逐字节同码 40040，区分仅进服务端日志（#336 验收）。
  private rethrowKnown(e: unknown, ctx?: { containerId: string; pid: string }): never {
    const code = (e as { code?: string }).code
    // unique(containerId, providerId) 并发绕校验 / 重复提交 → 40041（非裸 500）
    if (code === 'P2002') throw fail(CODE.PROVIDER_ID_CONFLICT)
    // 目标 provider 行缺失（update/delete，P2025）→ 40040
    if (code === 'P2025') {
      // eslint-disable-next-line no-console
      if (ctx) console.warn(`[models] provider_not_found: containerId=${ctx.containerId} pid=${ctx.pid}`)
      throw fail(CODE.PROVIDER_NOT_FOUND)
    }
    // 写盘失败（卷只读/满）→ 90003；DB 已随事务回滚，配置停留上一份一致状态
    if (e instanceof ConfigWriteError) {
      throw fail(CODE.LLM_NOT_CONFIGURED, '配置写盘失败，已回滚数据库变更')
    }
    // 交互事务超时（P2028）：rewrite 可能已落盘但 DB 回滚——reconcile 已恢复盘=DB；对客户端呈现
    // 配置写盘失败信封（90003）而非裸 90000 内部错误（#366 codex 四轮 P2 收窄 reconcile 的伴生映射）。
    if (code === 'P2028') {
      throw fail(CODE.LLM_NOT_CONFIGURED, '配置写盘超时，已回滚数据库变更')
    }
    throw e
  }
}
