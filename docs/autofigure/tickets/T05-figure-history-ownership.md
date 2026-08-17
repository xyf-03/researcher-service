# T05 — Figure history / ownership

## Parent specification

Reference: `docs/autofigure/spec.md`（User Stories 3 / 6 / 7 / 8 / 15 · §3 公开 API · §4 错误码）
Source of truth: `docs/autofigure/grilling-decisions.md` §3 / §9

## What to build

交付 AutoFigure 的**读路径**：历史列表、详情、归属门与 admin 跨用户可见性。状态值经持久化 fixture 布置，不依赖 runner。

- **`GET /figures`**：当前认证用户自己的 Figure 历史（以 Figure 为单位，非 Job）。**admin 角色**返回**所有用户**的 Figure（跨用户可见——spec User Story 15 / grilling §3 显式规范）。
- **`GET /figures/:id`**：Figure metadata + 应用级生成状态 + **非敏感**失败原因。
- **归属门**：`ownerId` 只由认证身份派生；`GET /figures/:id` 对「不存在 vs 他人资源」复用既有 `getInstanceForUser` 同款模式**同码防探测**（70040）。
- **应用级状态渲染**：从持久化的 `status` 值渲染 queued/running/succeeded/failed（含 fixture 布置的各状态）；不泄露 queue/worker/Python 实现细节。
- **admin 可见性**：角色级覆写（对齐面板 admin 语义与既有 admin 绕过 owner 检查先例）。

## Blocked by

**T01**（两表 schema + POST 骨架）。状态布置经持久化 fixture；**不依赖 T03 runner**（详见 tickets.md「依赖边只表示真实代码/契约前置」）。

## Why this ticket exists

交付已批准的**读/历史规则**（spec US3/6/7/8）：用户可查询自己的生成与详情，admin 可监督所有用户的生成；归属门同码防探测是既有安全模式在 AutoFigure 域的复用。T06 的 PNG 下载（阻塞于本票）复用本票归属 helper。

## Acceptance criteria

- [ ] 用户 `GET /figures`：只返回**自己**的 Figure 历史；无数据 → 空列表 code 0。
- [ ] admin `GET /figures`：返回**所有用户**的 Figure（spec US15 跨用户可见；种子两个用户验证 admin 全见、user 仅见自己）。
- [ ] `GET /figures/:id`：本人 Figure → metadata + 应用级状态（fixture 覆盖 queued/running/succeeded/failed 四态渲染正确）。
- [ ] 详情含**非敏感**失败原因（fixture 布置 `errorMessage`）；不泄露 provider secret / raw stack trace / Python internals。
- [ ] 他人 Figure（非 admin）→ **70040**（与「不存在」同码，防枚举）。
- [ ] 不存在的 id → **70040**（同码）。
- [ ] 未认证 → 鉴权错误（10001）。
- [ ] 响应为 #312 信封；只暴露应用级状态，不泄露实现细节。
- [ ] 测试经 REST 接缝 + 持久化 fixture（不依赖 runner）。

## Relevant global invariants

- **ownerId 只来自认证身份**，永不来自客户端提交（grilling §3 / spec §3）。
- **归属门同码防探测**：不存在 vs 越权同码（70040），对齐 `getInstanceForUser`（spec §3 / §4）。
- **admin 跨用户可见**（spec US15 / grilling §3）；**V1 无 Figure 删除（含 admin 删除）**——本票 read-only，无任何删除/变更路径。
- **#312 信封**；**应用级状态**暴露（不泄露 queue/worker/Python）。
- **失败保留非敏感错误信息**（grilling §9 / spec §3）。

## Explicitly out of scope for this ticket

- **状态产生 → T03**：本票只渲染 fixture 布置的状态，不实现状态迁移。
- **幂等 → T02**；**超时/reconcile → T04**；**产物/PNG → T06**。
- **删除**：V1 无 Figure 删除（owner 或 admin）；本票与任何 V1 票均不含删除端点/行为。
- **前端列表/详情 → T09**；dev/prod 打包 → T10 / T11。

## Testing seams

- **REST 信封接缝（复用）**：`setupTestApp` + `seedUser`/`seedAdmin` + `bearer` + 信封断言 + 归属断言（越权同码）。
- **持久化 fixture**：直接种子 Figure+Job 各状态（**fixture 是测试技术，不是依赖边**）。
- 不引入新架构接缝。

## Completion evidence

- **implementation summary**（固定点 0992afcc，未提交工作树，源码/测试 + 文档组，各单独提交）:
  - 读路径（`server/src/figures/service.ts`）：`listFigures`（user 仅自己 / admin 全用户，spec US15 / grilling §3；
    排序 = 已批准 V1 规则 createdAt DESC + id DESC 稳定 tiebreaker，确定性，无分页/过滤/搜索/用户排序）+ `getFigureForUser`
    （单点归属门镜像 `getInstanceForUser`：不存在 vs 越权同码 70040 防枚举，区分仅进服务端日志）。
  - 状态投影：`FigureAppStatus` = 应用级 queued/running/succeeded/failed（不泄露 queue/worker/Python/BullMQ）；
    failed 态经 `publicFailureReason` **白名单护栏**（只透出 runner 三条稳定原因 JOB_TIMEOUT_REASON / JOB_RECONCILE_REASON /
    GENERATION_EXECUTION_ERROR，未知/敏感内容归通用非敏感原因，单源见 runner.ts）——安全审查 + 首轮 Spec 轴最坏问题的修复。
  - 共享 `toSummary` 投影（消重复映射）+ detail select 对称收窄（只读 id/status/errorMessage 三列）。
  - 路由（`server/src/figures/routes.ts`）：GET / 列表 + GET /:id 详情（`req.params.id as string` 对齐 Express 5 cast 惯例）；
    经顶部 `router.use(requireAuth, mustChangePasswordGate)` 鉴权（GET 与 POST 同款，未认证 10001 已断言）。
  - 码：`CODE.FIGURE_NOT_FOUND: 70040`（T05 读路径激活）+ DEFAULT_MESSAGE；AGENTS.md 码段图「70040 预留」→「T05 生效」。
  - 无 schema delta（Figure/GenerationJob 全列 T01/T03 已就绪）。
- **targeted tests**: `server/test/figuresHistory.test.ts` 21/21（20 首轮 + 1 护栏新增）——5 describe：仅自己列表（他人不出现 /
  createdAt DESC / id tiebreaker / 空列表 code 0）· 四态投影（list+detail，errorMessage 仅 failed 非空）· 归属门防枚举
  （他人 70040 / 不存在 70040 / 逐字节一致 / 本人放行 / 未认证 10001）· admin 跨用户（全见仅读、DELETE→90005 行仍在、
  详情不暴露 ownerId）· 越界与 flag 关（无 PNG 端点 90005、flag 关 GET 90005）+ 护栏（未知/敏感 errorMessage→通用非敏感，不外泄）。
- **typecheck/build**: `tsc --noEmit` 干净；`npm run build` EXIT=0（Node v22.23.2 经 `npx node@22.23.2 npm-cli.js run build`
  绕过 @prisma/dev×zeptomatch ESM bug——与 T03/T04 同法）。
- **broader tests**: `vitest run` 全量 660 passed / 6 skipped（2 个失败 suite = containers/pairing docker smoke 基线，
  需真 daemon，`/var/run/docker.sock` ENOENT，未触碰相关文件；must-change-gate 并行 flaky 单跑 4/4 恢复）；figures
  （T01/T02 回归）37/37 + runner（T03/T04 回归）30/30。
- **first code review**: 固定点 0992afcc 双轴（Standards + Spec）并行。
  - Standards 轴：**1 硬问题**——AGENTS.md 码段图「70040 预留 T05」未随本票激活更新（Shotgun Surgery：codes.ts + 码段图应同步）；
    镜像核验通过（getFigureForUser 与 getInstanceForUser 逐项一致）；5 判断点（figure→投影映射写两遍 / 同码门第 5 份复制可接受 /
    detail 投影未收窄 / 测试顺序依赖弱 / FigureAppStatus 别名）。
  - Spec 轴：AC 无缺项、无越界；**1 部分保护**——failed 态 errorMessage 只做状态门、无内容级护栏，「非敏感」保证完全依赖 T03 写侧纪律；
    1 文档张力（spec §3 L105/L109 未注 admin 例外，与 US15 / grilling §3 内部不一致）。
  - 安全审查补充（背景自动）：GET 缺 requireAuth 属误报（router.use 已覆盖，未认证 10001 已断言）；errorMessage 透传为 MEDIUM，并入护栏修复。
- fixes: 应用 6 处修复（复验：focused 21/21 + figures/runner 67/67 + typecheck 干净 + build EXIT=0）——
  1) AGENTS.md 码段图「70040 预留 T05」→「70040 不存在/越权同码防探测（T05 读路径）」；codes.ts 头注释补 6xxxx/7xxxx 段；
     service.ts 头注释「读路径不在本文件范围」过时改正。
  2) **护栏**：`publicFailureReason` 白名单透出（service.ts），`GENERATION_EXECUTION_ERROR` 从 runner.ts 导出（单源，service→runner
     单向无循环）；未知/敏感内容归通用非敏感原因；新增护栏测试（AC4+）。
  3) 共享 `toSummary` 投影（消重复映射）+ detail select 对称收窄（id/status/errorMessage）。
  4) spec.md §3 两处补 admin carve-out（与 US15 / grilling §3 一致）。
  5) AGENTS.md 5xxxx 改「非信封段（错误经 WS close codes）」——消除与 spec §4 / codes.ts 的矛盾（二轮 Standards 残留）。
  6) spec.md §3 补一句「读路径仅透出白名单稳定原因，其余归通用」（对齐已批准护栏取舍；二轮 Spec 残留）。
  接受不修（记录在案）：`GENERIC_FAILURE_REASON = GENERATION_EXECUTION_ERROR` 命名别名（注释已解释）；测试顺序依赖（既有 fixture 家风格）；
  同码门第 5 份复制（repo「每域自持单点门」约定覆盖 baseline）。
- **second code review**: 双轴第二轮复核（修复后，针对当前工作树）。
  - Standards 轴：首轮硬问题与判断项全部确认已修复（码段图双向吻合 / toSummary 共用 / detail 收窄注释化）；新引入核查干净——
    无循环依赖（service→runner 单向、runner 零运行时导入，单源纪律同构 codes.ts）、护栏正确惯用、护栏测试命中真实读路径。
    残留 1（judgement）：AGENTS.md 5xxxx 仍列信封段——已随本轮修复（见 fixes 5）。
  - Spec 轴：护栏不遮蔽已批准稳定原因（三条逐字节透传有测试；AC4+ 折叠路径有测试）；admin carve-out 编辑与 US15/grilling §3 一致；
    9 AC 全覆盖；排序决策保留；无删除/PNG/分页越界。非阻塞：白名单把「非敏感错误」收窄为三字符串，与 Port 写侧契约（任意非敏感原因）
    不对称——已通过 spec §3 补注声明（fixes 6），T07 适配器须显式映射到白名单。
- commit: `fb1d475`（`feat: AutoFigure T05 — figure history and ownership read path`）——源码/测试 5 文件
  （codes/routes/service/runner + figuresHistory.test.ts），固定点 `0992afcc`；文档（AGENTS.md + spec.md + 本票）单独提交。
