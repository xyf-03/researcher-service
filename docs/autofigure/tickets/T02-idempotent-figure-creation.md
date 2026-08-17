# T02 — Idempotent Figure creation

## Parent specification

Reference: `docs/autofigure/spec.md`（§3 幂等契约子节 · Testing Decisions 幂等验收）
Source of truth: `docs/autofigure/grilling-decisions.md` §17（完整幂等契约，V1 已批准，15 条）

## What to build

在 `POST /figures` 上交付 **grilling §17 的完整幂等契约**：`Idempotency-Key` 必带、按 `(userId, key)`
作用域去重、持久化 survive 重启、确定性比较语义、成本保护不变量。

- **`Idempotency-Key` 请求头必带**（缺失 → 校验错误，90002）。
- **幂等关联**：按认证用户作用域 `(userId, idempotencyKey)` 唯一；`userId` 只由认证上下文派生，客户端不得把 userId 作为幂等身份发送；不同用户可独立使用同一 key。
- **持久化**：幂等关联落 SQLite/Prisma（survive 重启）；**不得**用进程内存 map。schema 演进经 `upgrade-schema.mjs`（幂等键列 + `(ownerId, idempotencyKey)` 唯一索引），并补 `schemaUpgrade.test.ts` 幂等覆盖。
- **同一逻辑原子创建边界**：首次有效 POST = 校验认证 → 校验 prompt → 持久化 Figure → 持久化 1:1 queued Job → 持久化幂等关联（全部一起成功）。
- **确定性比较语义**：同 key + 语义相同输入 → 返回已创建的 Figure/Job 及当前应用级状态；同 key + 不同输入 → 稳定幂等冲突（「41 冲突」锁式落 7xxxx 段），不得覆盖/改写原 Figure 或 prompt、不得建第二个 Figure/Job。比较输入 = 规范化创建载荷（不含 userId / 凭证 / 时间戳 / 内部字段 / 服务端 ID）；实现可存规范化字段或确定性 fingerprint。
- **成本保护不变量**：同 key 多次投递/重试/双击 ⇒ **至多一个 Figure、至多一个初始 GenerationJob**。

## Blocked by

**T01**（POST /figures 骨架 + 两表 schema）。

## Why this ticket exists

幂等是防重复扣费的成本保护不变量（grilling §5 / §17），且是已批准契约的全部行为面。
本票证明：重放无论原始 Job 处于 queued/running/succeeded/failed 任一状态都返回同一 Figure/Job——**状态经持久化 fixture 布置，不依赖 runner**。

## Acceptance criteria

（对应 grilling §17.15 验收清单，全部经 **persisted fixture 布置状态** 后走 REST 接缝验证，不依赖 runner）

- [x] 缺失 `Idempotency-Key` → 校验错误，不建任何行。
- [x] 首次有效创建 → code 0，一个 Figure + 一个 queued Job + 幂等关联。
- [x] 同用户 + 同 key + 同输入重放（原始 Job 状态 = queued）→ 返回同一 Figure/Job，**零新增行**。
- [x] 同用户 + 同 key + 同输入重放（原始 Job 状态 = **running / succeeded / failed**，经 fixture 布置）→ 返回同一 Figure/Job 及**当前应用级状态**，**零新增行**。
- [x] 同用户 + 同 key + **不同输入** → 稳定幂等冲突错误（7xxxx 段），原 Figure/prompt 不被改写，**不建第二个 Figure/Job**。
- [x] **不同用户 + 同一 key** → 独立幂等作用域，各自建自己的 Figure。
- [x] **survive 重启**：在同一 DB 上重建 app 实例后重放同 key + 同输入 → 仍返回同一 Figure/Job。
- [x] **成本保护**：所有重放场景断言数据库不出现第二个 GenerationJob。
- [x] 幂等比较确定性：同输入重放判定相同、不同输入判定不同；判定不依赖 userId/凭证/时间戳/内部字段。
- [x] schema 升级幂等：`upgrade-schema.mjs` 可重入；`schemaUpgrade.test.ts` 覆盖新列与唯一索引。

## Relevant global invariants

- **Figure 1:1 GenerationJob**；幂等关联不改变 1:1（grilling §17.6 / §17.14）。
- **ownerId 只来自认证身份**；幂等身份不含 userId（§17.3）。
- **#312 信封**；幂等冲突也走信封（HTTP 200 + 冲突 code），不引入 202/409 特例。
- **幂等键仅 POST /figures 必填**；不引入平台级通用幂等框架（§17.11）。
- **V1 无删除**；删除后的幂等键复用语义 V1 不定义（§17.13）——本票不实现删除场景。
- **无自动重试**：重放不等于重试，不触发任何 runner 行为。
- **凭证不落盘/不入 payload**：幂等比较输入明确**不含** provider 凭证（§17.9）。

## Explicitly out of scope for this ticket

- **状态产生（runner）→ T03**：本票只**读** fixture 布置的状态，不实现状态迁移。
- **超时 / reconcile → T04**；列表/详情/归属门 70040 → T05；产物/PNG → T06。
- **删除语义**：V1 无删除，幂等键在删除后的复用不定义（不在任何 V1 票内实现）。
- **前端幂等键发送** → T09。

## Testing seams

- **REST 信封接缝（复用）**：`setupTestApp` + `seedUser`/`seedAdmin` + `bearer` + 信封断言。
- **持久化 fixture**：直接布置既有 Figure+Job 于各状态——**fixture 是测试技术，不是依赖边**（不因此依赖 T03/T04）。
- **schema 升级接缝**：`runUpgrade()` 幂等断言（对齐 `schemaUpgrade.test.ts` 先例）。
- 不引入新架构接缝。

## Completion evidence

- **targeted tests**: `server/test/figures.test.ts` 37/37（含 T01 回归 14 + T02 幂等 23：缺失/空白/超长 key、首建、
  同输入四状态重放、异输入 70041、并发去重、跨用户同 key、survive 重启、seam 确定性 7 分支）；`schemaUpgrade.test.ts` 2/2。
- **typecheck/build**: `tsc --noEmit` 干净；`npm run build` 干净。
- **broader tests**: `vitest run` 全量 600 passed / 6 skipped（2 个失败 suite = docker smoke 基线，需真 daemon）；T01 回归全绿。
- **first code review**（对固定点 897957a）: 5 findings —
  - **F1 修正**（key 无长度上界）→ `IDEMPOTENCY_KEY_MAX_LENGTH = 256`，`requireIdempotencyKey` 超长 → 90002（data null）。
  - **F2 说明不修**（prompt 单一字段作 fingerprint 的扩展风险）→ `resolveReplay` 契约注释标注 T03+ 新字段须同步扩展比较（V1 合规，无新字段）。
  - **F3 修正**（缺 key 的 90002 被 body 校验掩盖，两种形状）→ `requireIdempotencyKey` 提到 `validateBody` 之前，缺/超长 key 恒 90002 + data null；AC5 测试加头硬化断言两形状分形。
  - **F4 说明不修**（check-then-create 先查读成本）→ lookup-first 对重放为主的幂等正确；create-first 令每次重放都付一次失败写。
  - **F5 修正**（7xxxx 未入 CLAUDE.md 码段图）→ AGENTS.md 码段图补 `7xxxx` figures（70041 幂等冲突 · 70040 预留 T05）。
- **fixes**: F1+F3 合成前置 `requireIdempotencyKey` 中间件（routes.ts）；F2/F4 注释留痕（service.ts）。修复后重跑：
  typecheck ✅ · figures.test.ts 37/37 ✅（新增超长 key 用例）· schemaUpgrade 2/2 ✅ · 全量 600/6 ✅ · build ✅。
- **second code review**（用户 /implement 批准后触发，固定点 897957a）: **Standards 轴无硬违规**（F1/F3/F5 复核通过，
  7xxxx 码段/#312 信封/0-trust/40 同码/41 冲突/测试接缝均合规）；6 项判断项——已修 #4（codes.ts:42 注释补
  「Idempotency-Key 缺/超长特例 data=null」），其余 DDL 双份重复（schema.prisma/init.sql/upgrade-schema.mjs 4 处同步）、
  P2002 字符串嗅探（对齐 models/service.ts rethrowKnown 先例）、findFirst（功能等价 findUnique）、AC8 better-sqlite3
  串行化（P2002 分支由 seam 7 分支确定性覆盖）均既有模式/等价/非本票范围。**Spec 轴零发现**（无缺失/无越界/无实现错；
  三不变量——重放回读当前状态、P2002-only 复读、异输入 70041 零写入——无回归）。
- **commit**: 首轮 + 第二轮 review 均通过后，提交到 `af/t01-authenticated-figure-creation`（固定点 897957a 上全部改动）。
