# T01 — Authenticated Figure creation

## Parent specification

Reference: `docs/autofigure/spec.md`（Solution · User Stories 1–2 · §1 领域模型 · §3 公开 API · §9 feature flag）
Source of truth: `docs/autofigure/grilling-decisions.md` §1 / §2 / §3 / §9 / §12 / §16

## What to build

本票交付 AutoFigure 域的 **walking skeleton 入口**：在 `AUTOFIGURE_ENABLED` 控制下，认证用户经
`POST /figures` **原子**创建一个 `Figure` + 其 1:1 `queued GenerationJob`，返回 #312 成功信封。

- **feature flag**：`AUTOFIGURE_ENABLED`（默认关闭）入 config 新子域（对齐 `fleet:` 先例）；关闭时 AutoFigure 路由不装配（直达 → 既有 notFound 信封 90005）。
- **基础 schema**：新建 `figures` + `generation_jobs` 两表（PascalCase 单数 + `@@map` snake_case 复数；`@@index([ownerId])`；cuid）。`GenerationJob` 含 `status`（默认 `queued`）与 nullable `errorMessage`——这是**持久化契约**，本票只建列、不实现 runner 产出的失败语义。`Figure.figureId ↔ GenerationJob.figureId` 为 **1:1**（`@unique`）。
- **`POST /figures` 路由**（`requireAuth` 之后）：zod 校验 prompt（90002）→ 在**同一逻辑原子创建边界**内持久化 Figure + queued Job（持久化失败 → 失败信封，绝不返回成功 queued）→ HTTP 200 信封，`data` 含 `{figureId, jobId, status:'queued'}`。语义等价 202，不引入 HTTP 202 特例。
- **归属**：`ownerId` 只由认证的 researcher-service 身份（JWT）派生，永不来自客户端提交。

## Blocked by

**None — can start immediately.**

## Why this ticket exists

证明最小可行骨架：域入口、认证归属、#312 信封、feature flag 装配、以及 **Figure 1:1 GenerationJob** 持久化契约。
后续票（T2 幂等、T3 runner、T5 读路径、T6 产物）全部建立在本票交付的两表与路由骨架之上。

## Acceptance criteria

- [ ] `AUTOFIGURE_ENABLED=false`：`POST /figures` 返回既有 notFound 信封（90005），路由未装配。
- [ ] flag 开、未认证：`POST /figures` → 鉴权错误（10001）。
- [ ] flag 开、已认证、合法 prompt：HTTP 200 信封 code 0，`data` = `{figureId, jobId, status:'queued'}`。
- [ ] 数据库断言：恰好一个 Figure + 恰好一个 GenerationJob；`job.status='queued'`、`job.errorMessage=null`；`figure.ownerId` = 认证用户 id。
- [ ] 非法 prompt（空 / 超长 / 类型错）→ 校验错误（90002），**零行落库**。
- [ ] 原子性：强制 Job 落库失败（如注入第二次写失败）→ 请求失败信封，**无孤儿 Figure**。
- [ ] 客户端随请求提交的 `userId` 被忽略，绝不作为归属来源。
- [ ] 响应为 #312 信封形状 `{code,message,data}`；不泄露内部实现（queue/worker/Python）。
- [ ] config 测试：`AUTOFIGURE_ENABLED` 默认关闭；flag 走 config 边界唯一读取。

## Relevant global invariants

- **Figure 1:1 GenerationJob**：两表职责分离，非为 1:N 预留（grilling §2 / spec §1）。
- **ownerId 只来自认证身份**，永不来自客户端提交（grilling §3 / spec §3）。
- **#312 全局信封**：所有 REST 一律 HTTP 200 + `{code,message,data}`；错误由信封收口（不引入 202 特例）。
- **feature flag 默认关闭**；关闭时路由/worker/sidecar 依赖不装配（90005）（grilling §12 / spec §9）。
- **V1 无 Figure 删除（owner 与 admin 均无）**（grilling §3 / §6 / spec Out of Scope）。
- **凭证**：本票不涉及凭证传递；若触碰 `AUTOFIGURE_*`，遵守「永不经请求体/不落盘/不入日志」。
- **错误码段**：校验复用系统段 90002；未知兜底 90000；`7xxxx` 段在本票后引入。

## Explicitly out of scope for this ticket

- **幂等（`Idempotency-Key`）→ T02**：本票不处理幂等键，不建幂等关联。
- **runner / 状态转换 / errorMessage 填充 → T03**：本票只建 `status` / `errorMessage` 列；不实现任何 queued→running→succeeded|failed 迁移。
- **超时 / reconcile / 迟到结果围栏 → T04**。
- **历史列表 / 详情 / 归属门 70040 / admin 全见 → T05**。
- **产物（xml/png/evaluation）与 PNG 下载 → T06**。
- **HTTP adapter / sidecar → T07 / T08**；前端 → T09；dev/prod 打包 → T10 / T11。
- **V1 无删除**：任何删除行为都不在本票（也不在任何 V1 票）内。

## Testing seams

- **REST 信封接缝（复用）**：`setupTestApp` + `seedUser` / `seedAdmin` + `bearer` + 信封断言（认证 HTTP 测试先例）。
- **config 接缝**：flag 开关注入。
- 不引入新架构接缝；测试替身只替换外部边界，不发明通用抽象。

## Completion evidence

- targeted tests: `test/figures.test.ts` 14/14（flag 开 REST · flag 关 90005 · 认证 10001 · 事务 seam · AC6 真事务回滚）；`test/config.test.ts` AutoFigure flag 6/6；`test/schemaUpgrade.test.ts` 2/2（含 v2→v3 增量幂等）
- typecheck/build: `npm run typecheck` 0 错误；`npm run build`（tsc + prisma generate 产物拷贝）成功
- broader tests: 全量 vitest 577 通过 / 6 skipped；仅 `containers-smoke` + `pairingSmoke` 失败——`connect ENOENT /var/run/docker.sock`（本机 docker daemon DOWN，环境门控，与 T01 无关）
- first code review: /code-review 双轴（Standards + Spec）均过——0 硬 violation、9/9 AC 实现、零 scope creep；仅 judgement-call 项见 fixes
- fixes: (1) 响应 `status` 由 DB 行回读替代路由硬编码 'queued'（消除第二来源，Standards Primitive Obsession + Spec 稳健性备注）；(2) 新增 AC6 真事务回滚测试（job 表中止触发器 → figure insert 回滚无孤儿；补 REST mock 未触达的真实 rollback 路径）
- second code review: blocking —— AC6 真回滚测试空洞通过。root cause：mock 测试对共享 PrismaClient 做 `vi.spyOn(ctx.prisma,'$transaction').mockRejectedValueOnce(...)` 后 `mockRestore()` 无法恢复（PrismaClient 是 Proxy，$transaction 残留为 undefined），后续真回滚测试在进入真事务前即 TypeError → 90000 + 计数未变 = 假绿。
  fix（仅测试隔离/证据，无 production 改动）：两个 AC6 用例各自隔离到独立 `setupTestApp`（独立 client）——mock 用例的 $transaction 污染止步于本 describe；真回滚用例用全新 client（其 $transaction 在其生命周期从未被 mock），并加前置置信断言（`typeof` 检查 + 真实 preflight 读事务 `$transaction(async tx => tx.figure.count())`）。实测真回滚路径错误为 `SQLITE_CONSTRAINT_TRIGGER`，被 driver adapter 归为 ForeignKeyConstraintViolation（P2003，源码 `case SQLITE_CONSTRAINT_TRIGGER` 与 FOREIGNKEY 同分类）——确为 job 表 BEFORE INSERT 中止触发器触发：figure insert 已入真事务、job insert abort → 整体 ROLLBACK 无孤儿。
- tests rerun: focused `test/figures.test.ts` 14/14；重复 `-t "真事务回滚"` 1/1 与 `-t "AC6"` 隔离 3/3；`test/config.test.ts` 67/67 + `test/schemaUpgrade.test.ts` 2/2；全量 vitest 577 passed / 6 skipped（仅 containers-smoke + pairingSmoke 因 docker daemon DOWN 环境门控失败，与 T01 无关）；`npm run typecheck` 0 错误；`npm run build` 成功
- final result: **未标记 ready to merge**（待最终裁决）；无 production 代码改动，仅 test 隔离与证据修复
- commit: `7b94c02`（branch `af/t01-authenticated-figure-creation`，基于 fixed point `75cf596`）
