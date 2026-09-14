// 容器列表/创建/删除（#334 M2 · /api/v1/containers/*）。
// 隔离（#312）：user 仅见自己、admin 跨用户全部；归属前置 getInstanceForUser 越权 20040 同码防探测。
// 并发（#313）：create/delete 按 name 串行入队、进程内互斥、端口入队前分配、delete 异步 + 取消标志。

import { Router, type Request, type Response } from 'express'
import { ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { containerCreateSchema, CONTAINER_NAME_REGEX } from '../validation/schemas'
import { fail } from '../envelope'
import { getInstanceForUser, type Orchestrator } from '../containers/orchestrator'
import type { ContainerSummary } from '../containers/readModel'
import type { ContainerRuntime } from '../containers/runtime'
import { AesGcmCrypto } from '../crypto'
import { config } from '../config'

// Pairing 状态快照（契约 §2.4）。M2 pairing 表无写入方 → 恒 unpaired 默认；
// M4 配对切片落库后经批量预取替换（本函数签名已按预取设计，避免 list N+1）。
interface PairingStatusView {
  status: string
  device_id: string
  scopes: string[]
  pairing_request_id: string
}
function defaultPairing(): PairingStatusView {
  return { status: 'unpaired', device_id: '', scopes: [], pairing_request_id: '' }
}

// 防御解码持久化 scopesJson（Codex 第六轮 P2）：迁移/半写入的坏 JSON 让裸 JSON.parse 抛错、整个
// container-list 请求 500；合法 JSON 但非 string[]（含数字/null 等元素）也违反 string[] 响应契约。
// 仅当「全为字符串的数组」才放行，其余一律回退 []。
function decodeScopes(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]')
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v
  } catch {
    // 坏 JSON → 回退 []
  }
  return []
}

type SummaryWithPairing = ContainerSummary & { pairing: PairingStatusView }

// 路径参数 name 非法 → 90002 + data.name（区别于「合法但不存在/越权 → 20040」，两码不可混）。
// DELETE 与 bootstrap-token 共用（#369）。
function assertValidContainerName(name: string): void {
  if (!CONTAINER_NAME_REGEX.test(name)) {
    throw fail(CODE.VALIDATION_FAILED, undefined, { name: ['name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'] })
  }
}

// requestId 字符集（对齐 backend/chat/pairing.py _REQUEST_ID_RE）：网关 pending 请求 id 为
// URL-safe 的字母/数字/._~-（RFC 3986 unreserved + ~）。非法 → 90002(data.requestId) 防注入
// （dockerode exec 本就走 argv 数组无 shell，此为正则纵深防御 + 契约校验）。
const REQUEST_ID_REGEX = /^[A-Za-z0-9_.~-]+$/

// 容器内 approve CLI（对齐 backend/chat/pairing.py ExecPairingApprover）：gateway 据 requestId
// 批准该 pending 设备配对请求（spec §8.1 宿主侧动作）。argv 数组直传 docker exec，无 shell 拼接。
const OPENCLAW_APPROVE_CMD = ['openclaw', 'devices', 'approve']

export function createContainersRouter(orch: Orchestrator, runtime: ContainerRuntime): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // GET / —— user 自己 / admin 全部；ContainerSummary + pairing 预取。
  router.get('/', async (req: Request, res: Response) => {
    const user = req.user!
    const where = user.role === 'admin' ? {} : { ownerId: user.id }
    const { items, ids } = await orch.listWithIds(where)
    // pairing 批量预取（M2 恒空 → default；M4 落库后注入真实快照）。
    // 按 containerId 代系 join（Codex 第五轮③[P2]）：仅按 name join 时，删除后同名 recreate 的
    // 竞态窗口会把新 owner 的 pairing 附到旧行摘要——containerId 唯一跨代系，name 可复用。
    const pairings = await req.prisma.pairing.findMany({
      where: { containerId: { in: [...ids.values()] } },
      select: { containerId: true, status: true, deviceId: true, scopesJson: true, pairingRequestId: true },
    })
    const byContainerId = new Map(pairings.map((p) => [p.containerId, p]))
    const data: SummaryWithPairing[] = items.map((i) => {
      const id = ids.get(i.name) // list 内 name 唯一；对应行 ID（代系）
      const p = id !== undefined ? byContainerId.get(id) : undefined
      return {
        ...i,
        pairing: p
          ? {
              status: p.status,
              device_id: p.deviceId,
              scopes: decodeScopes(p.scopesJson),
              pairing_request_id: p.pairingRequestId,
            }
          : defaultPairing(),
      }
    })
    ok(res, data)
  })

  // POST / —— 同步返 creating 快照；端口入队前分配；配额/撞名/残留目录/端口耗尽前置。
  router.post('/', validateBody(containerCreateSchema), async (req: Request, res: Response) => {
    const user = req.user!
    const { name } = req.body as { name: string }
    // 配额检查内化进 createReserve（按 owner 串行 count+reserve，消除并发不同名绕过——Codex C4）。
    const inst = await orch.createReserve(name, user.id, user.maxContainers)
    // 先构造 creating 快照（不做二次 runtime 查询），再入队后台 provisioning。
    const item: SummaryWithPairing = { ...orch.createdItem(inst), pairing: defaultPairing() }
    // detach 后台 provisioning（Codex C2）：POST 立即返 creating 快照，不等 docker pull/run 完成——
    // BullMQ 生产下 await 会阻塞到 worker 完成才响应（慢 pull/Redis 故障致请求超时 + 客户端重试冲突）。
    // 后台失败已由 createComplete 标 ERROR 行；catch 防 unhandled rejection，客户端经 list 轮询感知。
    void orch.submitCreate(inst).catch(() => {})
    ok(res, item)
  })

  // DELETE /<name> —— 异步信封（已入队）；遇在飞 create 置取消标志；归属前置 20040 同码。
  router.delete('/:name', async (req: Request, res: Response) => {
    const name = req.params.name as string
    // 路径参数 name 非法 → 90002 + data.name（区别于「合法但不存在/越权 → 20040」，两码不可混）。
    assertValidContainerName(name)
    // 归属前置：admin 全放行 / user 仅本人；不存在 vs 越权同码 20040。
    await getInstanceForUser(req.prisma, req.user!, name)
    await orch.deleteReserve(name) // 置取消标志 + 标 removing + 入队
    // detach 后台 delete（Codex C2，同 POST 理由）：DELETE 立即返 removing 信封，不等后台清理完成。
    // 失败已由 delete 标 REMOVING 行（可重试），catch 防 unhandled rejection，客户端经 list 轮询感知。
    void orch.submitDelete(name).catch(() => {})
    ok(res, { status: 'removing' })
  })

  // POST /<name>/upgrade —— #699 容器升级编排（spec §2.3，异步信封，对齐 POST/DELETE 先例）。
  // 归属前置：owner 本人或 admin（普通用户可升级自己的容器，#687 决策，无需管理员介入）。
  // 同步段：守卫/幂等/置 upgrading，返回「升级中」快照；后台六步编排 detach（异步信封）。
  // 幂等/守卫语义在 upgradeReserve 内（已 upgrading → 同快照；upgrade_failed/creating/removing →
  // 20043；镜像已对齐 → 200 no-op；bind 模式 → 20043「请删重建」）。
  router.post('/:name/upgrade', async (req: Request, res: Response) => {
    const name = req.params.name as string
    assertValidContainerName(name)
    await getInstanceForUser(req.prisma, req.user!, name)
    const { inst, triggered } = await orch.upgradeReserve(name)
    // detach 后台六步编排（对齐 POST provisioning / DELETE 清理）：同步段立即返「升级中」快照，
    // 不等 docker pull/备份/doctor/recreate 完成；后台失败已由 runUpgrade 收敛行状态，
    // catch 防 unhandled rejection，客户端经 list 轮询感知。
    if (triggered) void orch.submitUpgrade(name).catch(() => {})
    ok(res, { ...orch.createdItem(inst) })
  })

  // POST /<name>/bootstrap-token —— ADR 0006 D1（#369 接线前置）：所有权门控发放容器 bootstrap token。
  // 协议机首连须 bootstrap auth（ADR 事实 2：无 token 首连在配对前即失败）；token 真值只下发属主浏览器
  // （bootstrap 后可经网关配对换 deviceToken，真值仍不落前端以外的盘/日志）。
  router.post('/:name/bootstrap-token', async (req: Request, res: Response) => {
    const name = req.params.name as string
    // 路径参数 name 非法 → 90002 + data.name（区别于「合法但不存在/越权 → 20040」，与 DELETE 同款）。
    assertValidContainerName(name)
    // 归属前置（admin 全放行 / user 仅本人）：越权/不存在同码 20040 防探测。
    const inst = await getInstanceForUser(req.prisma, req.user!, name)
    // #13（第四轮）：仅 running 容器下发 token——隧道侧对非 running（creating/stopped/removing）恒 4402，
    // 端点盲目发 token 会让用户陷入 4402 退避循环。非 running 返 CONTAINER_NOT_RUNNING，前端显示
    // 「容器未运行」而非通用连接失败。
    if (inst.status !== 'running') throw fail(CODE.CONTAINER_NOT_RUNNING)
    // 容器 GATEWAY_TOKEN 存密文（DB 不落明文），用时解密（command.ts 同款模式）；tokenEncrypted=false
    // 为遗留明文行直接透传。
    const bootstrapToken = inst.tokenEncrypted
      ? new AesGcmCrypto(config.fleet.encryptionKeys).decrypt(inst.token)
      : inst.token
    ok(res, { bootstrapToken })
  })

  // POST /<name>/pairing/approve/:requestId —— ADR 0006 B2 / #371-1 后端 approve 编排。
  // 协议机首连(bootstrap token) 遇 PAIRING_REQUIRED{requestId} → 前端自动调本端点；后端在容器内
  // execSync `openclaw devices approve <requestId>`（ExecPairingApprover exec 语义：同步等命令完成、
  // 非 0 退出码抛错——approve 须先落库 gateway 设备表，浏览器重握手才能 hello-ok 拿 deviceToken）。
  // 成功后 Pairing 行 pending→paired + pairingRequestId 记账。校验顺序：name 非法 90002 → 归属 20040
  // → requestId 非法 90002 → 幂等（已 paired 同 requestId → ok 不 exec，含 stopped 容器）→ 非 running
  // 20046 → exec + 落库。
  // deviceToken 不在本端点可得（网关经 hello-ok 直接下发浏览器，见 #371 流程图）→ 响应体仅 status、
  // 无任何 token 字段；Pairing 行 deviceToken/privateKeyPem 恒为密文列（schema 不变量），本端点不改写。
  router.post('/:name/pairing/approve/:requestId', async (req: Request, res: Response) => {
    const name = req.params.name as string
    assertValidContainerName(name)
    // 归属前置（admin 全放行 / user 仅本人）：越权/不存在同码 20040 防探测（与 bootstrap-token 同款）。
    const inst = await getInstanceForUser(req.prisma, req.user!, name)
    const requestId = req.params.requestId as string
    if (!REQUEST_ID_REGEX.test(requestId)) {
      throw fail(CODE.VALIDATION_FAILED, undefined, { requestId: ['requestId 仅允许字母、数字及 ._~-'] })
    }
    // 幂等前置（Spec review #374）：同一 requestId 已 paired → 直接 ok，不重复 exec、不报错——即便容器
    // 已 stopped（该 approve 早已完成，重复提交是幂等 ok 而非 20046）。网关是 approve 的事实源——并发
    // 双发时第二个 exec 由 CLI 判 requestId 已消费而失败，前端重连自愈。
    const existing = await req.prisma.pairing.findUnique({ where: { containerId: inst.id } })
    if (existing?.status === 'paired' && existing.pairingRequestId === requestId) {
      ok(res, { status: 'paired' })
      return
    }
    // 非 running 同 bootstrap-token：approve CLI 须在容器内连本地 gateway，stopped/removing 无法 exec。
    if (inst.status !== 'running') throw fail(CODE.CONTAINER_NOT_RUNNING)
    // execSync 抛错（CLI 退出码非 0：requestId 已过期/无效、token 不匹配、网关断连）→ 包一层明确
    // message（默认 90000 是「服务器内部错误」，对可重试的「requestId 失效」误导）；失败不落 paired。
    // warn 保留底层错误供生产排查（exec 输出含容器名/CLI 退出码，不落响应体）。
    try {
      await runtime.execSync(name, [...OPENCLAW_APPROVE_CMD, requestId])
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[containers] pairing approve exec failed: ${name} requestId=${requestId}`, (e as Error)?.message)
      throw fail(CODE.INTERNAL, '容器内 approve 执行失败（requestId 无效或网关不可达）')
    }
    // 配对状态落库：pending→paired + pairingRequestId 记账；deviceId/scopesJson 保留（记账不丢）。
    await req.prisma.pairing.upsert({
      where: { containerId: inst.id },
      create: { containerId: inst.id, status: 'paired', pairingRequestId: requestId },
      update: { status: 'paired', pairingRequestId: requestId },
    })
    ok(res, { status: 'paired' })
  })

  // GET/PUT /<name>/pairing/token 已删除（方向 A 回归 ADR 0006）：deviceToken 持久化回归浏览器 localStorage
  //（前端 chat/deviceAuth.ts 的 createContainerTokenStore，按 container+deviceId 隔离），不再经服务端 DB。
  // 历史：#425 曾上移服务端（Pairing.deviceToken 密文列），违背 ADR 0006 行 53 否决且致切换浏览器匹配
  // 不上——已回退。Pairing.deviceToken 列保留（@deprecated，见 schema），不再读写。

  return router
}
