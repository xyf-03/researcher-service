// AutoFigure 单 worker 生成生命周期（T03，docs/autofigure/tickets/T03-single-worker-generation-lifecycle.md）。
//
// 职责：queued GenerationJob → 原子领取（queued→running，startedAt 置位）→ AutoFigureGenerationPort
// → 终态（succeeded|failed，finishedAt 置位，errorMessage 仅失败非敏感原因）。concurrency=1
//（进程内 active 守卫 + 原子领取双保险）；无自动重试（终态不可逆，失败即 failed；重新生成走 T02
// 幂等创建的新 Figure+Job 路径）。
//
// 本文件明确不做（防越界）：
//   - 生产 HTTP 适配器 / sidecar / 凭证传输形态：T07。
//   - 幂等：T02（本 runner 不触碰 idempotencyKey 逻辑）。
//   - 通用 JobStateMachine：只保留 AC5 所需的最小局部转换守卫（assertLegalTransition）。
//   - T04 超时 / 启动 reconcile / 迟到结果围栏：本文件已实现（见下方 T04 段）。职责分界——
//     T03 的 persistTerminalState `status='running'` 条件写 = 本地终态完整性；T04 在其上复用同一
//     CAS 条件写作为迟到结果围栏（sweeper/reconcile 先翻 failed → 迟到写 count=0 被丢弃）。
//   - 产物持久化：T06（见 persistSucceededWithArtifacts）——成功终态 + 产物在同一事务边界原子
//     提交，CAS `WHERE status='running'` 复用 T04 围栏：failed 后迟到成功产物丢弃、状态不变。
//
// SQLite/Prisma 是 Job 状态的唯一持久化真相源：本 runner 的一切状态变化都经
// updateMany({ where: { id, status }, ... })+count 判定，绝不依赖进程内存状态做裁决。

import type { GenerationJobStatus, PrismaClient } from '../generated/prisma/client'
import type {
  AutoFigureGenerationPort,
  AutoFigureGenerationResult,
  AutoFigureGenerationSuccess,
} from './port'

// ---------------------------------------------------------------------------
// 局部转换守卫（AC5）
// ---------------------------------------------------------------------------

// 合法转换表：queued→running（原子领取）、running→succeeded|failed（终态）。终态（succeeded/failed）
// 不可再转换——四个非法终态转换（failed→succeeded / failed→running / succeeded→running /
// succeeded→failed）一律拒绝。这是 T03 局部的转换完整性，不是通用状态机（T04 的超时/reconcile
// 转换不经此守卫：由下方自有 `WHERE status='running'` CAS 直接写 failed）。
const LEGAL_TRANSITIONS: Readonly<Record<GenerationJobStatus, readonly GenerationJobStatus[]>> = {
  queued: ['running'],
  running: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
}

export function assertLegalTransition(from: GenerationJobStatus, to: GenerationJobStatus): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`非法 GenerationJob 状态转换: ${from} -> ${to}（终态 succeeded/failed 不可逆）`)
  }
}

// ---------------------------------------------------------------------------
// 持久化状态转换（原子，SQL 判定）
// ---------------------------------------------------------------------------

// 原子领取（AC3）：单条 UPDATE ... WHERE id=? AND status='queued'，count===1 证明本调用是唯一赢家
//（并发重复领取时至多一个成功）。state 由持久化状态守卫，SQL 单语句 + SQLite 单 writer 保证判定
// 原子——对齐代码库既有 CAS 模式（users/auth/tokens 的 updateMany+count）。startedAt 随领取置位，
// 即「进入 running 的时刻」。
export async function claimQueuedJob(prisma: PrismaClient, jobId: string): Promise<boolean> {
  const claimed = await prisma.generationJob.updateMany({
    where: { id: jobId, status: 'queued' },
    data: { status: 'running', startedAt: new Date() },
  })
  return claimed.count === 1
}

// 终态写入（AC2/AC5 持久化 + AC6 无重试）：以 WHERE status='running' 为条件写 succeeded|failed。
// Job 已非 running（被并发/外部改为终态）→ count=0 返回 false，绝不覆盖既有终态、绝不重试。
// finishedAt 随终态置位；成功清 errorMessage（契约：errorMessage 仅失败原因）。
export async function persistTerminalState(
  prisma: PrismaClient,
  jobId: string,
  status: 'succeeded' | 'failed',
  errorMessage?: string,
): Promise<boolean> {
  const done = await prisma.generationJob.updateMany({
    where: { id: jobId, status: 'running' },
    data: {
      status,
      finishedAt: new Date(),
      errorMessage: status === 'failed' ? errorMessage : null,
    },
  })
  return done.count === 1
}

// ---------------------------------------------------------------------------
// T06 产物持久化（docs/autofigure/tickets/T06-artifact-persistence-png.md · grilling §6）
// ---------------------------------------------------------------------------

// 成功产物三元组 = Port 成功契约的产物子集（单一来源，二次 review 后 Pick 消除重复声明）：
// evaluation 为 Port 边界已归一化的非敏感 JSON 载荷；png 精确对齐 Figure.png（Prisma Bytes 等价）。
export type AutoFigureArtifacts = Pick<AutoFigureGenerationSuccess, 'xml' | 'png' | 'evaluation'>

// T06 原子产物提交：Job 到 succeeded 与产物可见性在**同一事务边界**内提交——绝不出现
// 「succeeded 但无产物」或「产物已写但 Job 仍 running」的中间态。CAS `WHERE status='running'`
// 复用 T04 迟到结果围栏：执行期间 Job 已被超时 sweeper / reconcile 翻为 failed → count=0 →
// 事务整体不写任何产物、状态不变（failed 后迟到成功产物丢弃，spec §2）。产物只在 count=1
// 时随事务写入 Figure（原子：两写同生共灭；figure.update 抛错则连同 succeeded 一并回滚，
// Job 保持 running 交由 reconcile 终态化）。返回是否成功提交（false = 围栏丢弃）。
export async function persistSucceededWithArtifacts(
  prisma: PrismaClient,
  jobId: string,
  figureId: string,
  artifacts: AutoFigureArtifacts,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const done = await tx.generationJob.updateMany({
      where: { id: jobId, status: 'running' },
      data: { status: 'succeeded', finishedAt: new Date(), errorMessage: null },
    })
    if (done.count !== 1) return false
    await tx.figure.update({
      where: { id: figureId },
      data: { xml: artifacts.xml, png: artifacts.png, evaluation: artifacts.evaluation },
    })
    return true
  })
}

// ---------------------------------------------------------------------------
// T04 硬化：超时 / 启动 reconcile / 迟到结果围栏（docs/autofigure/tickets/
// T04-timeout-reconcile-late-result.md）。三个 CAS 写者各守自己的 where：
//   claim（queued→running）、persistTerminalState（running→succeeded|failed）、
//   下方 timeout/reconcile（running→failed）。并发交错时至多一个赢家，任何交错都不产生
//   非法终态（无 failed→succeeded / running→queued / 重复执行）。
// ---------------------------------------------------------------------------

// 稳定非敏感原因（T04：超时/reconcile 原因不携带凭证/内部栈/时间戳；Public API 展示的失败原因）。
export const JOB_TIMEOUT_REASON = '生成超时（执行超过时限）'
export const JOB_RECONCILE_REASON = '生成任务因服务重启/中断被终止'

// 启动 reconcile（T04 AC3）：遗留 running（崩溃/重启孤儿）→ failed，携带稳定 reconcile 原因。
// CAS `WHERE status='running'`：succeeded/failed/queued 均不受影响；幂等（重复执行 count=0）。
// 与 claim 的竞态由各自 CAS 保证安全——已翻 failed 的 Job 不再被 claim（where status='queued'
// 不命中）、迟到 terminal write 也不再生效（where status='running' 不命中）。返回翻转行数。
export async function reconcileRunningJobs(prisma: PrismaClient): Promise<number> {
  const updated = await prisma.generationJob.updateMany({
    where: { status: 'running' },
    data: { status: 'failed', finishedAt: new Date(), errorMessage: JOB_RECONCILE_REASON },
  })
  return updated.count
}

// 超时 sweeper（T04 AC1/AC2）：running 且 startedAt + timeout < now 的 Job → failed，携带稳定
// 超时原因。startedAt 由 claim 置位 =「进入 running 的时刻」，故超时自 running 起算；queued 的
// startedAt 恒 null，Prisma 对 nullable 字段的 lt 过滤排除 NULL → 排队等待不计入超时。
// CAS `WHERE status='running'`：已被并发 reconcile/超时翻为 failed 的 Job 不重复写。
// `now` 由调用方传入 = 确定性可测（测试注入「超截止」时刻，不靠 wall-clock 等 30 分钟）。
export async function timeoutRunningJobs(
  prisma: PrismaClient,
  now: Date,
  jobTimeoutMs: number,
): Promise<number> {
  const cutoff = new Date(now.getTime() - jobTimeoutMs)
  const updated = await prisma.generationJob.updateMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    data: { status: 'failed', finishedAt: new Date(), errorMessage: JOB_TIMEOUT_REASON },
  })
  return updated.count
}

// ---------------------------------------------------------------------------
// GenerationRunner：start/stop/tick
// ---------------------------------------------------------------------------

export interface GenerationRunner {
  start(): void
  stop(): Promise<void>
  /** 单次 pump 周期（确定性测试接缝）；已在执行时为 no-op（concurrency=1） */
  tick(): Promise<void>
}

export interface GenerationRunnerDeps {
  prisma: PrismaClient
  port: AutoFigureGenerationPort
  /** 服务端凭证（config.autofigure.llmKey）；只注入 Port，不落盘/不入 Job payload/不入日志 */
  llmKey: string
  pollIntervalMs?: number
  /** 执行超时（T04）：自进入 running（startedAt 置位）起算；默认 0 = 关闭超时。runner 逻辑
   *  不硬编码生产超时（30 分钟默认只在 config.autofigure.jobTimeoutMs 声明，装配层注入此处）。 */
  timeoutMs?: number
  /** 超时 sweeper 轮询间隔（T04，确定性测试可注入）；默认与 pump 同 pollInterval */
  timeoutSweepIntervalMs?: number
}

// Port 抛异常（执行体崩溃/网络异常）→ 归一为 failed（非敏感消息；不暴露内部栈/凭证）。
// 读路径（service.ts publicFailureReason）以本常量作为已知稳定原因之一 + 未知内容的通用兜底。
export const GENERATION_EXECUTION_ERROR = '生成执行异常（内部错误）'

const DEFAULT_POLL_INTERVAL_MS = 1000

class DefaultGenerationRunner implements GenerationRunner {
  private readonly prisma: PrismaClient
  private readonly port: AutoFigureGenerationPort
  private readonly llmKey: string
  private readonly pollIntervalMs: number
  // T04：执行超时（自 running 起算）；0 = 关闭。sweeper 独立于 pump——pump 被挂起的
  // port.generate 阻塞（active=true）时仍能翻转超期 running→failed（不依赖取消）。
  private readonly timeoutMs: number
  private readonly timeoutSweepIntervalMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeperTimer: ReturnType<typeof setInterval> | undefined
  // concurrency=1 守卫：tick 进入即同步置位（无 await 间隙，事件循环内原子），退出才复位——
  // 任何并发 tick（interval 重入 / 测试 Promise.all）在置位后立即 no-op，杜绝同一进程内不同
  // queued Job 的重叠执行。
  private active = false
  private currentTick: Promise<void> | null = null
  // T04 启动对账一次性守卫：pump 首周期 claim 前 / sweeper 首跑前都先执行 reconcile——孤儿
  // running→failed 先于本进程任何新 claim / 超时翻转（启动序不变量；见 ensureReconcile）。
  private reconciled = false
  // T07 扩 Scope（shutdown-driven abort）：stop() 一次性闩——置位后不再领取新 Job、tick 为 no-op。
  private stopping = false
  // 当前 in-flight invocation 的 AbortController（runner 持有；stop() 借其立即 abort 在飞生成——
  // 与 T04 超时 timer 共用同一 controller，不建两套互相竞争的取消抽象）。
  private currentController: AbortController | undefined

  constructor(deps: GenerationRunnerDeps) {
    this.prisma = deps.prisma
    this.port = deps.port
    this.llmKey = deps.llmKey
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.timeoutMs = deps.timeoutMs ?? 0
    this.timeoutSweepIntervalMs = deps.timeoutSweepIntervalMs ?? this.pollIntervalMs
  }

  start(): void {
    if (this.timer !== undefined) return // 幂等启动
    this.timer = setInterval(() => {
      void this.tick()
    }, this.pollIntervalMs)
    this.timer.unref?.() // 后台 pump 不阻止进程退出；宿主优雅关闭仍走 stop()
    if (this.timeoutMs > 0) {
      // T04 超时 sweeper：独立 interval，pump 挂起时仍能超时终止 running Job。
      this.sweeperTimer = setInterval(() => {
        void this.timeoutSweep().catch(() => {
          // 空吞：DB 瞬时故障由下一轮 sweep 重扫兜底（DB 是事实源，无自动重试）；不产生未处理 rejection。
        })
      }, this.timeoutSweepIntervalMs)
      this.sweeperTimer.unref?.()
    }
  }

  async stop(): Promise<void> {
    // 幂等：二次 stop（含并发）时 timer/controller/tick 均已清理，各分支有守卫。
    // 1) 停止新的 interval/tick + 阻止领取新的 Job（stopping 闩）。
    this.stopping = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.sweeperTimer !== undefined) {
      clearInterval(this.sweeperTimer)
      this.sweeperTimer = undefined
    }
    // 2) shutdown-driven abort：立即取消在飞 invocation——复用同一 AbortController（T04 超时与
    //    shutdown 是同一个 controller 的两个触发源）。stop() 不改 Job 业务终态（不 running→failed；
    //    遗留 running 交由下次 startup 的 T04 reconcile，见 runOne 的 stopping 分支）。
    this.currentController?.abort()
    // 3) await 当前 cycle settle：abort 使在飞 promise 即时 settle → 不等待 T04 timeout 到点。
    const inflight = this.currentTick
    if (inflight) await inflight
    this.currentTick = null
  }

  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve() // stop 后不再领取新的 queued Job（shutdown 语义）
    if (this.active) return Promise.resolve() // concurrency=1：已有周期在执行，本次 no-op
    this.active = true
    // DB 层错误（updateMany 抛错等）：状态由已执行的持久化步骤决定，吞错后由 T04 reconcile/超时兜底
    //（running→failed 终态化）；绝不自动重试。catch 保证 interval 触发不产生未处理 rejection。
    const p = this.runOne()
      .catch(() => {
        // 空吞：T03/T04 不实现任何自动重试；DB 故障时 Job 保持 claim 后的 running，交 reconcile/超时。
      })
      .finally(() => {
        this.active = false
      })
    this.currentTick = p
    return p
  }

  private async runOne(): Promise<void> {
    // T04 启动序：reconcile 先于任何 claim——孤儿 running→failed 在首个 queued 被领取前完成，
    // 本进程绝不会对账到自己刚 claim 的 Job（一次性守卫，幂等）。
    await this.ensureReconcile()
    if (this.stopping) return // shutdown 已开始：不再领取新的 queued Job

    // 取最老的 queued Job（FIFO，确定性顺序），连带其 1:1 Figure 的 prompt 与 id
    //（id 供 T06 产物原子提交定位 Figure 行）。
    const job = await this.prisma.generationJob.findFirst({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, figure: { select: { id: true, prompt: true } } },
    })
    if (!job) return
    if (this.stopping) return // 领取前 shutdown：放弃本周期（Job 仍 queued，留待下个进程）

    assertLegalTransition('queued', 'running')
    const claimed = await claimQueuedJob(this.prisma, job.id)
    if (!claimed) return // 并发重复领取的输家：他人已领，本 writer 放弃（至多一次执行）
    if (this.stopping) {
      // claim 后 shutdown 到达：本 Job 保持 running（不生成、不改终态）——下次 startup 由 T04
      // reconcile 终态化（crash/restart interruption 唯一事实语义）。
      return
    }

    // 凭证只在此处注入 Port；prompt 是域输入，分开传。T07 扩 Scope（shutdown-driven abort）：
    // 每个 in-flight invocation 持有 runner 的 AbortController——同一 controller 可被 (A) T04 应用
    // 超时 (B) graceful shutdown / stop() 触发，不建两套互相竞争的取消抽象；signal 恒透传 Port
    //（shutdown 取消能力不依赖 timeout policy；timeoutMs=0 时无 timer、仅 shutdown 可触发 abort）。
    // 不新增 adapter-local 超时契约（V1 唯一 execution timeout 仍是 timeoutMs）。
    // 时序不变量：promise settle 的微任务先于 timer 宏任务 → 合法成功恒在 clearTimeout 前 settle，
    // 绝不会把成功结果误标超时；仅「settle 晚于 timeoutMs 触发」才归一为超时原因。
    const controller = new AbortController()
    this.currentController = controller
    const abortTimer = this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined
    let result: AutoFigureGenerationResult
    try {
      result = await this.port.generate(
        { prompt: job.figure.prompt },
        { apiKey: this.llmKey },
        { signal: controller.signal },
      )
    } catch {
      result = { ok: false, errorMessage: GENERATION_EXECUTION_ERROR }
    } finally {
      if (abortTimer) clearTimeout(abortTimer)
      if (this.currentController === controller) this.currentController = undefined
    }

    // shutdown-driven abort：不改 Job 业务终态——abort 传输/计算让进程可退出；仍 running 的 Job
    // 交由下次 startup 的 T04 reconcile 终态化（stop() 绝不 running→failed，见 T07 ticket
    // 「Approved scope extension — shutdown-driven abort」约束 4）。shutdown 内部错误（AbortError）
    // 在此被消费，不写成任何 public failure reason（同节约束 6）。
    if (this.stopping) return

    // 超时中止在飞：信号已触发 → 本结果统一为超时原因（JOB_TIMEOUT_REASON，T05 白名单单源）。
    // sweeper 若已先翻转（CAS 不命中）则本写入 no-op，原因仍为 TIMEOUT——两种竞态下原因确定性一致。
    if (controller.signal.aborted) result = { ok: false, errorMessage: JOB_TIMEOUT_REASON }

    // T04 迟到结果围栏：若执行期间 Job 已被超时 sweeper / reconcile 翻为 failed，persistTerminalState
    // 的 WHERE status='running' 不命中 → count=0 返回 false，本结果被丢弃、终态不回滚、不转 succeeded
    //（正确性不依赖取消——即使 port 迟到/挂到超时后才返回，状态围栏照常成立）。
    if (result.ok) {
      assertLegalTransition('running', 'succeeded')
      // T06：succeeded 终态 + 产物在同一事务边界原子提交；围栏同样生效——failed 后迟到成功
      // count=0 → 不写任何产物、状态不变。
      await persistSucceededWithArtifacts(this.prisma, job.id, job.figure.id, {
        xml: result.xml,
        png: result.png,
        evaluation: result.evaluation,
      })
    } else {
      assertLegalTransition('running', 'failed')
      await persistTerminalState(this.prisma, job.id, 'failed', result.errorMessage)
    }
  }

  // T04 启动对账（一次性）：pump 与 sweeper 首跑都先经此——先到者 reconcile；并发首跑同时触发时
  // 二次 reconcile 由 DB 幂等兜底（WHERE status='running' 已清空 → count=0）。与
  // claim/persistTerminalState 的 CAS 竞态安全。
  // reconciled 在成功后置位：DB 瞬时故障时不永久禁用对账，下一 tick/sweep 会重试（幂等无害）。
  private async ensureReconcile(): Promise<void> {
    if (this.reconciled) return
    await reconcileRunningJobs(this.prisma)
    this.reconciled = true
  }

  // T04 超时 sweeper：running 且超过截止的 Job → 确定性 failed（CAS + 稳定原因）。now 用实时钟
  //（生产）；测试直驱 timeoutRunningJobs seam 注入确定时刻，不依赖 wall-clock。
  private async timeoutSweep(): Promise<void> {
    await this.ensureReconcile() // 启动序：sweeper 先到也须先对账，再扫超时
    await timeoutRunningJobs(this.prisma, new Date(), this.timeoutMs)
  }
}

export function createGenerationRunner(deps: GenerationRunnerDeps): GenerationRunner {
  return new DefaultGenerationRunner(deps)
}

// ---------------------------------------------------------------------------
// 装配门（AC8 flag 门）
// ---------------------------------------------------------------------------

export interface AutoFigureRunnerHandle {
  runner: GenerationRunner
  close(): Promise<void> // 优雅关闭（停 pump、等在飞周期）
}

export interface AutoFigureRunnerAssembleDeps extends GenerationRunnerDeps {
  /** flag（装配层 server.ts 传 config.autofigure.enabled；flag 只在装配层消费） */
  enabled: boolean
}

// flag 关 → 不构造不启动（返回 null：无 pump，queued 恒不迁移）；flag 开 → 构造并启动 pump，返回
// 含 close() 的 handle（对齐 assembleFleet 的 close 先例）。T03 不接线 server.ts（无生产 Port，
// T07 才装配 HTTP 适配器），但本门即 T07 的装配点，现即可测两分支。
export function assembleAutoFigureRunner(
  deps: AutoFigureRunnerAssembleDeps,
): AutoFigureRunnerHandle | null {
  if (!deps.enabled) return null
  const runner = createGenerationRunner(deps)
  runner.start()
  return { runner, close: () => runner.stop() }
}
