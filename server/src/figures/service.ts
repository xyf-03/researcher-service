// AutoFigure 域 —— 事务 seam + 幂等编排（T01 + T02，docs/autofigure/tickets/T01-authenticated-figure-creation.md /
// T02-idempotent-figure-creation.md）。
// T01 交付「原子创建 Figure + 其 1:1 queued GenerationJob」这一最小写契约；
// T02 在其上加入幂等：seam 创建时落 (ownerId, idempotencyKey)，并新增 createOrReplayFigure
// 编排「先查后建 + P2002 并发仲裁」。runner/状态机（T03）不在本文件范围；
// T05 读路径（历史列表 + 详情归属门 + 失败原因护栏）见下方「T05 读路径」段。

import { CODE } from '../codes'
import { fail } from '../envelope'
import type { PrismaClient, GenerationJobStatus } from '../generated/prisma/client'
import type { FigurePngBytes } from './port'
import type { AuthUser } from '../types'
// 失败原因白名单单源：runner 写入的稳定非敏感原因（T03/T04 契约），读路径据此做透出护栏。
import { GENERATION_EXECUTION_ERROR, JOB_RECONCILE_REASON, JOB_TIMEOUT_REASON } from './runner'

export interface CreateFigureInput {
  ownerId: string // 只由认证的 researcher-service 身份（JWT）派生，永不来自客户端提交
  prompt: string
  idempotencyKey: string // Idempotency-Key 请求头（必带，T02）
}

// Idempotency-Key 防御上限（路由层强制，见 routes.ts requireIdempotencyKey）。
// spec/grilling 未定义 key 格式；上限只挡滥用——Node header 上限 ~16KB 可被整段索引落库
//（每行 ~16KB 索引项，永久膨胀 DB）。对合法客户端 key（如 32-hex）远足够；超限 → 90002
//（与缺头同码 + data null，确定性）。
export const IDEMPOTENCY_KEY_MAX_LENGTH = 256

export interface FigureCreated {
  figureId: string
  jobId: string
  // 持久化契约回读（Standards code-review：路由不得硬编码 'queued' 作为第二来源）：
  // 首建 = generationJob.create 返回的 DB 行（默认 'queued'）；幂等重放 = 既有 Job 行当前
  // 应用级状态（queued/running/succeeded/failed）——二者都来自 DB，绝不硬编码。
  status: string
}

// 最小事务接缝（对齐 users.ts resetPasswordInTx 先例）：FigureCreateTx 只暴露本 seam
// 需要的两个 delegate，测试可注入 fake tx（第二次写失败 → 原子性验收）。
// 生产实参为 prisma.$transaction 回调的 TransactionClient（结构兼容，见 routes.ts）。
export interface FigureCreateTx {
  figure: {
    create(data: {
      data: { ownerId: string; prompt: string; idempotencyKey: string }
    }): Promise<{ id: string }>
  }
  generationJob: {
    create(data: { data: { figureId: string } }): Promise<{ id: string; status: string }>
  }
}

// 同一逻辑原子边界内持久化 Figure + 其 1:1 queued GenerationJob：
// Job 落库失败 → 抛错，调用方事务整体回滚（无孤儿 Figure，绝不返回成功 queued）。
// status 由 DB 默认 'queued'（本票不实现任何状态转换，T03 runner 负责）；返回行回读的
// status，而非调用方硬编码——响应反映实际落库值。幂等键随 Figure 同事务落库（唯一索引
// (ownerId, idempotencyKey) 是并发重复创建去重的最终仲裁）。
export async function createFigureWithJobInTx(
  tx: FigureCreateTx,
  input: CreateFigureInput,
): Promise<FigureCreated> {
  const figure = await tx.figure.create({
    data: { ownerId: input.ownerId, prompt: input.prompt, idempotencyKey: input.idempotencyKey },
  })
  const job = await tx.generationJob.create({
    data: { figureId: figure.id },
  })
  return { figureId: figure.id, jobId: job.id, status: job.status }
}

// 幂等查询结果：命中 (ownerId, idempotencyKey) 的唯一 Figure 及其 1:1 Job（读当前持久化状态）。
export interface IdempotentFigure {
  id: string
  prompt: string // 规范化创建输入（zod trim 后）——确定性输入比较的存储基准
  job: { id: string; status: string } | null
}

// 幂等编排依赖：routes 用 req.prisma 适配；测试可注入 fake（确定性竞态分支）。
export interface IdempotencyDeps {
  findByIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<IdempotentFigure | null>
  createInTransaction(input: CreateFigureInput): Promise<FigureCreated>
}

// 幂等 check-or-create（grilling §17）：
//   1. 先查 (ownerId, idempotencyKey)：命中 → 同输入重放（返回当前 Job 状态）/ 异输入 70041。
//   2. 未命中 → 原子创建。撞唯一索引 P2002（并发重复）→ 复读 winner → 同输入重放 / 异输入 70041。
//   3. 只把已知 P2002（唯一约束冲突）走复读路径；其余持久化/锁/事务错误一律原样上抛
//      ——绝不把无关错误吞成成功重放（并发约束的最终仲裁是 DB 唯一索引，不是错误映射）。
// 不变量：任意并发重复逻辑创建至多一个 Figure + 至多一个初始 GenerationJob（P2002 复读只读不写）。
export async function createOrReplayFigure(
  deps: IdempotencyDeps,
  input: CreateFigureInput,
): Promise<FigureCreated> {
  const existing = await deps.findByIdempotencyKey(input.ownerId, input.idempotencyKey)
  if (existing) return resolveReplay(existing, input.prompt)

  try {
    return await deps.createInTransaction(input)
  } catch (e) {
    // 已知唯一约束冲突（并发 duplicate 的输家）：复读 winner 按输入同异重放/冲突。
    // 精确到 P2002 —— P2003/P2028/SQLITE_BUSY/未知错都原样上抛（见 createOrReplayFigure 头注）。
    const code = (e as { code?: string }).code
    if (code === 'P2002') {
      const winner = await deps.findByIdempotencyKey(input.ownerId, input.idempotencyKey)
      if (winner) return resolveReplay(winner, input.prompt)
      // 复读落空（理论不可达）：winner 已消隐则不可安全重放——上抛原始 P2002，不吞。
    }
    throw e
  }
}

// 幂等命中裁决：输入相同 → 重放（返回既有 Figure/Job 及 Job 当前应用级状态，零写入）；
// 输入不同 → 稳定幂等冲突（70041），零写入。
//
// ⚠️ 幂等身份（fingerprint）扩展点：比较基准是规范化存储字段 figure.prompt（zod trim 后，
// 即 §17.9 的「规范化创建载荷」——V1 唯一请求字段）。未来 T03+ 若新增「影响生成结果的请求
// 字段」（format/style 等），必须同步扩展此比较（连同 figure 行的持久化），否则该字段会
// 静默掉出幂等身份（同 key 异值误判为重放而非 70041）。这是本函数与 schema 的契约注释，非本票范围。
function resolveReplay(existing: IdempotentFigure, prompt: string): FigureCreated {
  if (existing.prompt !== prompt) throw fail(CODE.IDEMPOTENCY_CONFLICT)
  if (!existing.job) {
    // 理论不可达（T01 起 Figure 与 Job 恒同事务创建；legacy 行 key 为 NULL 查不到）：
    // 防御性失败——不返回缺 Job 的畸形响应。
    throw fail(CODE.INTERNAL, '幂等命中 Figure 缺关联 Job')
  }
  return { figureId: existing.id, jobId: existing.job.id, status: existing.job.status }
}

// ---------------------------------------------------------------------------
// T05 读路径（docs/autofigure/tickets/T05-figure-history-ownership.md）
// ---------------------------------------------------------------------------

// 应用级状态（Public API 只暴露这些，不泄露 queue/worker/Python/BullMQ 实现细节）。
export type FigureAppStatus = GenerationJobStatus

// 列表项：以 Figure 为单位（非 Job）的公开投影——Figure metadata + 其 1:1 Job 的应用级状态。
export interface FigureSummary {
  figureId: string
  jobId: string
  prompt: string
  status: FigureAppStatus
  createdAt: string
}

// 详情：在列表项之上追加非敏感失败原因与更新时间。errorMessage 仅 failed 时非空
//（runner 契约：成功态恒清空；公开投影只在 failed 透出持久化的稳定非敏感原因）。
export interface FigureDetail extends FigureSummary {
  errorMessage: string | null
  updatedAt: string
}

// 公开投影读取的 Job 最小形状：list 只取 id/status；detail 追加 errorMessage（只读这几列，
// 不拉整行——与 listFigures 的 select 对称，见 getFigureForUser）。
interface FigureJobProjection {
  id: string
  status: GenerationJobStatus
  errorMessage: string | null
}

// 失败原因读路径护栏（T05 + 安全审查）：公开层只透出 runner 写入的稳定非敏感原因
//（JOB_TIMEOUT_REASON / JOB_RECONCILE_REASON / GENERATION_EXECUTION_ERROR，单源见 runner.ts）；
// 未知/异常内容一律归为通用非敏感原因（GENERIC_FAILURE_REASON），原始值只存服务端——
// runner 契约本应只写非敏感值，此处为纵深防御（即使持久化行异常带敏感值也不外泄）。
// 新增稳定原因须同步更新 KNOWN_STABLE_REASONS（public API 只展示白名单原因）。
// 非 failed 恒 null（成功态 runner 清空 errorMessage，此处再防御一道）。
const KNOWN_STABLE_REASONS = new Set<string>([
  JOB_TIMEOUT_REASON,
  JOB_RECONCILE_REASON,
  GENERATION_EXECUTION_ERROR,
])
const GENERIC_FAILURE_REASON = GENERATION_EXECUTION_ERROR

function publicFailureReason(job: FigureJobProjection): string | null {
  if (job.status !== 'failed') return null
  if (!job.errorMessage || !KNOWN_STABLE_REASONS.has(job.errorMessage)) {
    return GENERIC_FAILURE_REASON
  }
  return job.errorMessage
}

// list 与 detail 共用的 Figure→公开摘要投影（避免同一映射写两遍，见 listFigures/getFigureForUser）。
function toSummary(
  figure: { id: string; prompt: string; createdAt: Date },
  job: { id: string; status: GenerationJobStatus },
): FigureSummary {
  return {
    figureId: figure.id,
    jobId: job.id,
    prompt: figure.prompt,
    status: job.status,
    createdAt: figure.createdAt.toISOString(),
  }
}

// 历史列表（T05 AC1/AC2 · 已批准排序规则）：当前认证用户自己的 Figure（admin = 所有用户）。
// 排序 = 已批准 V1 规则：createdAt DESC（最新在前），确定性；createdAt 撞车用 id DESC 作
// 稳定二级 tiebreaker（cuid 不可变标识；不暴露任何公开排序选项——无分页/过滤/搜索/用户排序）。
export async function listFigures(prisma: PrismaClient, user: AuthUser): Promise<FigureSummary[]> {
  const where = user.role === 'admin' ? {} : { ownerId: user.id }
  // T06 二次 review（Spec (c)2 / Standards 4）：select 只取列表投影所需标量列，排除 xml/png/evaluation
  // 产物列——列表 N 行时避免整段 BLOB/大文本从 SQLite 拉进内存（投影本就不含产物，见 toSummary）。
  // job 关系并入 select（Prisma 禁 select+include 混用）。
  const rows = await prisma.figure.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, prompt: true, createdAt: true, job: { select: { id: true, status: true } } },
  })
  return rows.map((r) => {
    if (!r.job) throw fail(CODE.INTERNAL, 'Figure 缺关联 Job') // 理论不可达（T01 原子创建）
    return toSummary(r, r.job)
  })
}

// 共享归属门（T05 单点 + T06 复用）：figure 域单点归属前置，镜像 getInstanceForUser
//（containers/orchestrator.ts）——admin 全放行 / user 仅本人；「不存在 vs 越权」同码 70040，
// 对外逐字节一致，区分仅进服务端日志（not_found vs owner_mismatch）。
// ownerId 只由认证身份派生：本函数只按 id 查行，不接收任何客户端 userId 作为授权覆写。
// detail（getFigureForUser）与 png（getFigurePngForUser）两读路径共用同一实现——不建第二套
// 归属逻辑（T06 约束；admin PNG 授权依据 spec §3 归属防探测段 + T06 AC「非 owner（含 admin 以外
// 角色）→ 70040」+ grilling §3「admin 跨用户全部可见」）。
interface FigureOwnedRow {
  id: string
  ownerId: string
  prompt: string
  createdAt: Date
  updatedAt: Date
  // T06：PNG 读路径需要产物列；detail 投影（toSummary/publicFailureReason）不用，但归属门共享
  // 同一查询——公开投影不含产物，字段只在内部读取（list/detail 响应不暴露 PNG/xml/evaluation）。
  png: FigurePngBytes | null
  job: FigureJobProjection | null
}

async function findFigureForUser(
  prisma: PrismaClient,
  user: AuthUser,
  id: string,
): Promise<FigureOwnedRow> {
  // select 只取归属门消费者需要的列：detail 投影列 + PNG 路径所需的 png（单行）；排除 xml/evaluation
  // 大文本列（T06 二次 review，Spec (c)2：detail 读路径不拉产物大文本；png 路径本就需回读 png BLOB）。
  // job 关系并入 select（Prisma 禁 select+include 混用）。
  const figure = await prisma.figure.findUnique({
    where: { id },
    select: {
      id: true,
      ownerId: true,
      prompt: true,
      createdAt: true,
      updatedAt: true,
      png: true,
      job: { select: { id: true, status: true, errorMessage: true } },
    },
  })
  if (!figure) {
    // eslint-disable-next-line no-console
    console.warn(`[figures] not_found: id=${id} uid=${user.id}`)
    throw fail(CODE.FIGURE_NOT_FOUND)
  }
  if (user.role !== 'admin' && figure.ownerId !== user.id) {
    // eslint-disable-next-line no-console
    console.warn(`[figures] owner_mismatch: id=${id} uid=${user.id} owner=${figure.ownerId}`)
    throw fail(CODE.FIGURE_NOT_FOUND)
  }
  return figure
}

export async function getFigureForUser(
  prisma: PrismaClient,
  user: AuthUser,
  id: string,
): Promise<FigureDetail> {
  const figure = await findFigureForUser(prisma, user, id)
  if (!figure.job) {
    // 理论不可达（T01 起 Figure 与 Job 恒同事务创建）：防御性失败——不返回缺 Job 的畸形详情。
    throw fail(CODE.INTERNAL, 'Figure 缺关联 Job')
  }
  return {
    ...toSummary(figure, figure.job),
    // 非敏感失败原因仅在 failed 透出稳定白名单原因；未知/敏感内容归通用非敏感原因（见 publicFailureReason）。
    errorMessage: publicFailureReason(figure.job),
    updatedAt: figure.updatedAt.toISOString(),
  }
}

// T06 PNG 读路径（docs/autofigure/tickets/T06-artifact-persistence-png.md · spec §3）：
// 复用共享归属门（admin 全放行 / user 仅本人；不存在 vs 越权同码 70040 防探测）。状态门仅放行
// succeeded 且 png 非空；未完成（queued/running）→ 70042 明确「未就绪」应用级响应，失败 →
// 70043 明确「不可用」应用级响应——二者都不返回模糊 500（spec §3 下载契约）。
// succeeded 但 png 为 null（T06 升级前遗留成功行 / 数据完整性防御）→ 70043 确定性不可用。
// 返回 PNG 字节（Uint8Array 对齐 Prisma Bytes；路由层 Buffer.from 后按既有下载契约直发字节）。
export async function getFigurePngForUser(
  prisma: PrismaClient,
  user: AuthUser,
  id: string,
): Promise<Uint8Array> {
  const figure = await findFigureForUser(prisma, user, id)
  const status = figure.job?.status
  if (status !== 'succeeded') {
    // queued/running → 未就绪（仍在生成，可稍后重试）；failed / 缺 Job（理论不可达）→ 不可用。
    if (status === 'queued' || status === 'running') throw fail(CODE.FIGURE_PNG_NOT_READY)
    throw fail(CODE.FIGURE_PNG_NOT_AVAILABLE)
  }
  if (!figure.png) {
    // succeeded 但无产物：升级前遗留成功行 / 数据完整性异常——确定性应用级「不可用」，不模糊 500。
    throw fail(CODE.FIGURE_PNG_NOT_AVAILABLE)
  }
  return figure.png
}
