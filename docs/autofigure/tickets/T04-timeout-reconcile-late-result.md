# T04 — Timeout / reconcile / late-result

## Parent specification

Reference: `docs/autofigure/spec.md`（§2 状态机 · §5 异步执行）
Source of truth: `docs/autofigure/grilling-decisions.md` §5

## What to build

在 T03 的执行核心之上叠加**硬化**：超时到期、启动对账、迟到结果围栏。这是状态机「终态不可逆」的关键不变量。

- **超时**：running 中的 Job 超过 `AUTOFIGURE_JOB_TIMEOUT_MS`（自**进入 running 起算**，不含 queued 等待）→ **确定性 failed**，不停留 running。超时经 config 注入短值测试，**绝不等待真实 30 分钟**。
- **启动 reconcile**：启动时遗留 running → failed（携带稳定的中断/reconcile 原因）；succeeded/failed 终态保留；queued 不因重启丢失。
- **迟到结果围栏（关键不变量）**：Job 已进入 failed（超时/中断/reconcile）后，Port 迟到的成功 XML/PNG **不得**把终态 failed 转回 succeeded，也**不得**把迟到产物发布为成功 Figure；迟到结果一律丢弃、状态不变。
- **超时不删除 Figure**：Figure 独立于 Job 终态持续存在（spec §2 / grilling §6）。

## Blocked by

**T03**（runner + `startedAt`/`finishedAt` + Port fake）。

## Why this ticket exists

崩溃恢复与资源保护：超时防止 running 永久悬挂、reconcile 保证重启不卡状态机、迟到围栏保证**终态即终态**。T06 的「产物仅 succeeded 提交」建立在本票围栏之上（T06 阻塞于 T04）。

## Acceptance criteria

- [ ] **超时→failed**：注入短超时，Job 进入 running 后推进过截止 → 确定性 failed，不停留 running。
- [ ] **超时从 running 起算**：queued 等待时间不计入超时。
- [ ] **启动 reconcile**：预置 running 行后启动 app → 该 Job → failed（稳定中断/reconcile 原因）；succeeded/failed 保留；queued 保留。
- [ ] **迟到结果围栏**：Job 已 failed 后 Port 返回成功 → 状态**保持 failed**、不转 succeeded、不发布产物。
- [ ] 超时**不删除** Figure：超时后 Figure 仍存在且可查询（配合 T05 验收路径验证）。
- [ ] 超时后**无自动重试**：failed 不自动重跑。
- [ ] 测试全程经 config 短超时 + fake Port 编排，**不真实等待 30 分钟**。

## Relevant global invariants

- **终态不可逆**：succeeded/failed 为终态；唯一 reconcile 例外 = 启动时遗留 running→failed（spec §2）。
- **迟到结果围栏**：failed 后迟到成功结果一律丢弃、状态不变（spec §2 关键不变量）。
- **无自动 retry**；**无 BullMQ AutoFigure 依赖**。
- **V1 无 Figure 删除**：超时 / reconcile 均**不删除** Figure（spec §2）。
- **SQLite/Prisma 唯一事实源**；succeeded/failed 状态 survive 重启。
- **凭证不落盘/不入日志**：reconcile / timeout 原因不携带任何 provider 凭证。

## Explicitly out of scope for this ticket

- **幂等 → T02**；**列表/详情/归属门 → T05**；**产物持久化 → T06**（本票只保证「迟到产物不发布」，不实现产物写入）。
- **HTTP adapter 生产实现 → T07**；前端 → T09；dev/prod 打包 → T10 / T11。
- **自动重试 / 删除 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **runner/application 接缝**：超时 / reconcile / 围栏均为应用层行为，runner 单测覆盖。
- **`AutoFigureGenerationPort` fake 接缝**：编排「running 后迟到的成功返回」，断言围栏生效。
- **config 接缝**：注入短超时（绝不真实等待）。

## Completion evidence

- **implementation summary**（固定点 6a17294，未提交工作树，4 文件 +445/−6）:
  - config：`AUTOFIGURE_JOB_TIMEOUT_MS` → `config.autofigure.jobTimeoutMs`（默认 30 分钟，**config boundary 唯一声明处**，
    runner 逻辑不硬编码生产超时）；非法值 fail-fast（对齐 readDefaultMaxContainers）。不暴露公开 API。
  - runner（`server/src/figures/runner.ts`）：`JOB_TIMEOUT_REASON`/`JOB_RECONCILE_REASON` 稳定非敏感原因；
    `reconcileRunningJobs`（CAS `WHERE status='running'` → failed+finishedAt+reconcile 原因，幂等）与
    `timeoutRunningJobs(prisma, now, ms)`（CAS `WHERE status='running' AND startedAt < now-ms`，now 注入=确定性可测）
    两个 seam；`GenerationRunnerDeps` 扩 `timeoutMs`（默认 0=关）/`timeoutSweepIntervalMs`；sweeper interval
    独立于 pump（pump 被挂起 port.generate 阻塞时仍能超时终止）；`ensureReconcile` 一次性守卫在 pump 首周期
    claim 前与 sweeper 首跑前都先执行（启动序：孤儿 running→failed 先于任何新 claim）；迟到结果围栏复用
    T03 `persistTerminalState` 的 `WHERE status='running'` 条件写（sweeper/reconcile 先翻 failed → 迟到写 count=0
    被丢弃，不转 succeeded、不发布产物）。
  - 职责分界保持：T03 的 `status='running'` 条件写 = 本地终态完整性；T04 在其上复用为迟到围栏。**无通用
    JobStateMachine、无取消 API、不改 Port**（`generate(input, credential)` 原样）、无 T07 HTTP 假定。
  - 无 schema delta（status/errorMessage/startedAt/finishedAt 已就绪，`user_version` 保持 5）。
- **targeted tests**: `server/test/figuresRunner.test.ts` 30/30（15 条 T03 回归 + 15 条 T04 新增：超时自 running 起算
  queued 不计入 / 未超期不触碰 / 短超时确定性 failed+finishedAt+稳定原因 / 不删 Figure / 不自动重试 / 迟到成功围栏 /
  迟到失败不覆盖终态 / reconcile 竞态围栏 / 启动对账孤儿→failed 不重执行 / reconcile 保留 queued 与终态 / 幂等 /
  重启不重复执行 / sweeper 装配 / 无 running→queued 回迁）；`server/test/config.test.ts` 76/76（含 T04 新增 4：
  默认 30min / 显式值 passthrough / 0 与 abc fail-fast）。
- **typecheck/build**: `tsc --noEmit` 干净；`npm run build` 干净（Node v22.23.2 经 `npx node@22.23.2 npm-cli.js run build`
  绕过 @prisma/dev×zeptomatch ESM bug——与 T03 同法）。
- **broader tests**: `vitest run` 全量 639 passed / 6 skipped（2 个失败 suite = containers/pairing docker smoke 基线，
  需真 daemon，`/var/run/docker.sock` ENOENT，未触碰相关文件）；figures（T01/T02 回归）37/37；schemaUpgrade 2/2。
- first code review: 固定点 6a17294 双轴（Standards + Spec）并行。
  - Standards 轴：**1 硬问题**——sweeper interval 回调 `void this.timeoutSweep()` 无 rejection 守卫
    （DB 瞬时错误 → unhandled rejection → 进程崩溃，且正砸在「DB 故障交 T04 兜底」安全网上；pump 同文件
    已有 `.catch` 惯例）。其余干净：config boundary 合规（唯一读 env、默认 30min 唯一在 config.ts、fail-fast
    对齐 readDefaultMaxContainers、不暴露 API）、CAS 竞态正确（updateMany+count 对齐 users/tokens 惯例）、
    凭证纪律干净（原因不携带凭证/内部栈/时间戳）、计时器纪律（start 幂等/stop 清双 timer/unref）、确定性测试达标。
    5 判断点：两处过时注释（T03 残留）、`timeoutMs` 默认 0 的静默关闭隐患、ensureReconcile 提前置位、
    stop() 不 await 在飞 sweep。
  - Spec 轴：**0 违规**，7 个 AC 全部 MET，10/10 检查项通过（超时自 startedAt 起算、终态 CAS 围栏不依赖取消、
    启动对账幂等且先于任何 claim、无 running→queued、无越界 T05/T06/T07/重试/BullMQ、无凭证泄漏、无真实 30 分钟等待）。
    4 判断点均不阻塞（runner 默认 timeoutMs=0 vs config 30min 的装配责任、全量 reconcile 的 V1 单进程假定、
    配置 eager 校验、reconciled 前置位）。
- fixes: 应用 5 处修复（聚焦测试 106/106 + typecheck 干净复核）——
  1) **硬问题**：sweeper 回调加 `.catch(() => {})` 空吞（对齐 pump 惯例；DB 瞬时故障下一轮 sweep 重扫兜底）。
  2) 修正 tick 过时注释「（本票无超时/reconcile）」（T03 残留，T04 已实现）。
  3) 修正 LEGAL_TRANSITIONS 过时注释「T04 转换不在此列」（现改述：T04 转换经自有 CAS 直接写 failed，不经此守卫）。
  4) `ensureReconcile` 的 `reconciled` 置位于成功 await 之后（DB 瞬时故障不永久禁用对账，下一 tick/sweep 幂等重试；
     启动序不变量不变）。
  5) `JOB_RECONCILE_REASON` 改述为「生成任务因服务重启/中断被终止」（去「对账」内部术语；仍稳定非敏感，测试经常量引用不受影响）。
  接受不修（记录在案）：stop() 不 await 在飞 sweep（单次快写，无害）；config.test.ts 的 delete-env 惯例
  （全文件既有家风格，非 T04 偏差）；`timeoutMs` 默认 0 与 J2/J3 判断点——T07 装配点须显式传
  `config.autofigure.jobTimeoutMs`，V1 单进程假定，eager 校验对齐 readDefaultMaxContainers。
- second code review: 双轴第二轮复核（修复后，针对当前工作树）。
  - Standards 轴：硬问题已消解（sweeper `.catch` 对齐 pump 惯例；reconcile 失败重试 + timeout 每轮重扫，注释准确）。
    5 处修复零新硬违规；两项接受不修项（stop() 不 await 在飞 sweep / config.test.ts delete-env 惯例）均获同意。
    新增两条非阻塞记录：a) 启动后 claim 后 DB 故障的兜底只由 sweeper 提供、且仅当 timeoutMs>0——T07 装配须传正
    timeoutMs（runner DI 默认 0），否则该兜底不存在；b) fix 4「并发双跑 reconcile 无害（DB 幂等）」依赖
    better-sqlite3 同步驱动——若未来换异步/远程驱动，双首跑可能都过守卫、二次 reconcile 落于 claim 之后误伤新
    claim 的 running job；V1 钉死驱动下不阻塞，备选为 memoize 在飞 reconcile Promise。
  - Spec 轴：7/7 AC 仍 MET，零新违规；修复严格增强健壮性（sweeper rejection 卫生、reconcile 失败可重试），
    围栏 / CAS 交错 / 超时语义未动。非阻塞 ensureReconcile 注释精度已按建议补改。
- commit: `76b43e5`（`feat: AutoFigure T04 — timeout reconcile and late-result hardening`）——实现/config/测试
  4 文件，固定点 `6a17294`（实现前工作树 vs 固定点审查，实现后仅提交源码+测试，doc 单独提交）。
