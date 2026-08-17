# T06 — Artifact persistence + PNG

## Parent specification

Reference: `docs/autofigure/spec.md`（User Stories 4 / 5 / 13 · §1 领域模型 · §3 公开 API）
Source of truth: `docs/autofigure/grilling-decisions.md` §6

## What to build

交付**产物持久化**与 **PNG 下载**：生成成功那一刻的 XML / PNG / evaluation 落 Figure，以及仅 owner、仅 succeeded 的下载端点。

- **产物 schema**：Figure 增加产物列——`xml`（文本）、`png`（SQLite BLOB）、`evaluation`（文本 JSON）——经 `upgrade-schema.mjs` + 幂等测试。面板无对象存储、V1 不引入；未来可迁移（预留扩展点，不建抽象层）。
- **产物提交时机**：XML/PNG 仅在 Job **提交 succeeded 终态时**一并持久化；running/failed **不落成功产物**。
- **迟到结果围栏（T04 保证，本票阻塞于 T04）**：Job 已进入 failed 后迟到的成功产物**不得**回写为 Figure 成功产物（丢弃、状态不变）——产物提交路径必须尊重围栏。
- **`GET /figures/:id/png`**：仅 owner、仅 succeeded 可下载；未完成/失败给**明确应用级响应**（非模糊 500）；非 owner / 不存在 → **70040**（复用 T05 归属 helper，本票阻塞于 T05）。
- **survive restart**：产物落 SQLite，重启后仍可下载。

## Blocked by

**T04**（迟到结果围栏）**、T05**（归属 helper / 70040）。

## Why this ticket exists

交付 V1 的价值闭环：用户拿到自己的 PNG（spec US4/5），且产物生命周期与终态强绑定——只有 succeeded 才落成功产物、failed 后迟到成功绝不复写。产物提交正确性依赖 T04 围栏与 T05 归属，故双阻塞。

## Acceptance criteria

- [ ] Port fake 返回成功结果 → Job succeeded 时，Figure 落 `xml` / `png`（BLOB）/ `evaluation`。
- [ ] running / failed → **无**成功产物落库。
- [ ] **迟到围栏**：Job 已 failed 后 fake 迟到返回成功 → 状态保持 failed，**不落产物**、不转 succeeded。
- [ ] `GET /figures/:id/png`：owner + succeeded → 返回 PNG 字节。
- [ ] owner + 未完成/失败 → 明确应用级「未就绪」响应（不模糊 500）。
- [ ] 非 owner（含 admin 以外角色）→ 70040（同「不存在」码）；不存在 id → 70040。
- [ ] **survive restart**：重启 app 后，owner 仍可下载已成功 Figure 的 PNG。
- [ ] 产物列 schema 升级幂等（`upgrade-schema.mjs` + `schemaUpgrade.test.ts`）。
- [ ] 响应为 #312 信封（下载成功路径除外——PNG 字节按既有下载契约）；错误面走信封。

## Relevant global invariants

- **Figure 1:1 GenerationJob**；产物属于 Figure（用户面对的聚合），不改基数。
- **产物存储 SQLite BLOB(PNG) + 文本(XML)**；FileArchive 非 v1 产物机制（grilling §6 / §14）。
- **迟到结果围栏**：failed 后迟到成功产物丢弃、状态不变（spec §2）。
- **70040 同码防探测**（复用 T05 归属门）。
- **V1 无 Figure 删除**：产物随 Figure 存续，无删除路径。
- **无自动重试**；**无 BullMQ AutoFigure 依赖**。
- 下载契约：仅 owner 且仅 succeeded（grilling §6 / spec §3）。

## Explicitly out of scope for this ticket

- **超时/reconcile 本身 → T04**（已交付；本票只消费围栏）。
- **列表/详情/归属门 → T05**（已交付；本票只复用其 helper）。
- **幂等 → T02**；**HTTP adapter 生产实现 → T07**（产物经 Port 结果归一化返回，本票不接 sidecar）。
- **前端预览/下载 UI → T09**；dev/prod 打包 → T10 / T11。
- **删除 / 自动过期 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **`AutoFigureGenerationPort` fake 接缝**：返回成功结果（含迟到成功编排），断言提交时机与围栏。
- **runner/application 接缝**：产物提交发生在 succeeded 提交路径（应用层）。
- **REST 信封接缝（复用）**：PNG 下载 + 70040（复用 T05 归属 helper）。
- **schema 升级接缝**：产物列幂等添加。
- 不引入新架构接缝；产物存储为 SQLite 列，不建存储抽象层。

## Completion evidence

- **implementation summary**（固定点 25133af，未提交工作树，源码/测试 + 文档组，各单独提交）:
  - 产物 schema：`Figure` 新增 `xml`（TEXT）/ `png`（BLOB）/ `evaluation`（TEXT）三列（schema.prisma + init.sql +
    upgrade-schema.mjs user_version 5→6 + schemaUpgrade.test.ts）；全 nullable，仅 Job 提交 succeeded 终态时由 runner 原子写入。
  - Port：`AutoFigureGenerationSuccess` 成功类型扩展 `xml/png/evaluation` 三字段必填；`FigurePngBytes = Uint8Array<ArrayBuffer>`
    = Prisma Bytes 结构等价，顶层独立声明避免引用 Prisma 命名空间。
  - Runner 原子提交：`persistSucceededWithArtifacts` 把 CAS `WHERE status='running'` 的 succeeded 终态写与 `figure.update`
    产物写包进同一 `$transaction`——count!==1（T04 围栏：超时/reconcile 已翻 failed）→ 不写任何产物、状态不变（迟到成功丢弃）；
    figure.update 抛错 → 事务整体回滚（Job 保持 running 交 reconcile），无「succeeded 但无产物」中间态。
  - 共享归属门：`findFigureForUser`（service.ts）单点镜像 getInstanceForUser，detail 与 png 两读路径共用，不建第二套；
    不存在 vs 越权同码 70040 逐字节一致。`getFigurePngForUser` 状态门：queued/running → 70042「未就绪」；failed/缺 Job →
    70043「不可用」；succeeded 但 png null（升级前遗留行防御）→ 70043。
  - 路由：`GET /figures/:id/png`（在 GET /:id 后）——成功返原生 PNG 字节 + `Content-Type: image/png`（`Buffer.from(png)` +
    `res.send`，成功路径豁免 #312 信封、不 base64-in-JSON）；错误面仍走信封。
  - 码：70042 FIGURE_PNG_NOT_READY / 70043 FIGURE_PNG_NOT_AVAILABLE（x40 不存在/41 冲突/42+ 域专用锁式，20042/20043 先例）+
    DEFAULT_MESSAGE；AGENTS.md 码段图补 42/43 + #312 信封段记二进制成功豁免。
  - evaluation 只持久化 Port 边界已归一化的非敏感 JSON 载荷（runner 原样落，不落 raw provider/Python 响应/栈/凭证）。
  - list/detail 投影不含 xml/png/evaluation（无泄漏）。
- **targeted tests**: focused 66/66 —— `server/test/figuresPng.test.ts`（新，11）5 describe：owner+succeeded 精确字节 +
  Content-Type image/png（豁免信封，Buffer.isBuffer + 字节相等）/ 归属门防枚举（他人 70040、不存在 70040 逐字节一致、
  未认证 10001）/ 状态门（queued+running 70042、failed 70043、succeeded+png null 70043）/ admin 跨用户下载 + admin 对他人
  failed 70043（状态门独立不因 admin 特免）/ survive restart（双 prisma+app 同 dbUrl 字节精确）。
  `figuresRunner.test.ts` 33（含 T06 产物原子提交 3：CAS 命中 true + 三产物落库 / CAS 不命中 false + 不写产物 +
  原因不被覆盖 / figure.update P2025 → 事务回滚 Job 保持 running）；`figuresHistory.test.ts` 20（移除越界 png→90005 测试）；
  `schemaUpgrade.test.ts` 2（三列 nullable + user_version 6）。
- **typecheck/build**: `tsc --noEmit` 干净；`npm run build` EXIT=0（Node v22.23.2 经 `npx node@22.23.2 npm-cli.js run build`
  绕过 @prisma/dev×zeptomatch ESM bug——与 T03/T04/T05 同法）。
- **broader tests**: `vitest run` 全量 673 passed / 6 skipped（2 失败 suite = containers/pairing docker smoke 基线，
  需真 daemon，`/var/run/docker.sock` ENOENT，未触碰相关文件）。
- **first code review**: 固定点 25133af 双轴（Standards + Spec）并行（工作树 diff +283/−44，未提交）。
  - Standards 轴：0 硬违规、0 安全/契约缺陷（原子提交边界、单归属门、防枚举逐字节、精确字节路径、凭证/raw 卫生、无 T07+ creep、
    升级脚本幂等全部核验通过）。4 判断项：1) AGENTS.md 无条件「所有 REST 一律 HTTP 200」未记 PNG 二进制成功豁免（doc gap）；
    2) figuresPng seedFigure 与 figuresHistory seedFigure fixture 重复（低严重，可抽 helpers）；3) AutoFigureArtifacts 重复声明
    产物三元组（可用 Pick）；4) listFigures/detail 拉整行含 PNG BLOB（fetch 成本，投影不泄漏）。
  - Spec 轴：AC 无缺项、无 scope creep（无 T07/T08/frontend/object-store/删除/共享/重试/BullMQ/V2；list/detail 不暴露产物）。
    1 真实不一致 (c)1：upgrade-schema.mjs 的 `CREATE TABLE "figures"` 未补三列（init.sql 补了），T06 注释「上方 CREATE TABLE
    已带列」对脚本不成立——功能经 ALTER guard 收敛幂等，但破坏 T02/T03 先例。1 效率回归 (c)2：list/detail 拉 PNG BLOB。
    1 决策标记（非缺陷）：admin PNG 授权——下载契约字面「仅 owner」（T06 L10/L15、spec §3 L107、grilling §6 L75）与
    T06 AC L33「非 owner（含 admin 以外角色）→ 70040」括号显式排除 admin + grilling §3「admin 跨用户全部可见」存在张力，
    实现按 preflight 已核验方向朝 admin 放行落地（可辩护决策，非纯 T05 推断）。
- fixes: 应用 5 处修复（复验：focused 66/66 + 全量 673 passed + typecheck 干净 + build EXIT=0）——
  1) **upgrade-schema.mjs** `CREATE TABLE "figures"` 补 `xml/png/evaluation` 三列（与 init.sql 列集/列序逐字节一致）+ 修正
     T06 注释（fresh 直带列、既有部署走 ALTER guard）；修复 Spec (c)1。
  2) **service.ts `listFigures`** `select` 只取列表投影列（id/prompt/createdAt + job{id,status}），排除产物列——N 行列表
     不再拉 BLOB/大文本（修复 Spec (c)2 / Standards 4）。
  3) **service.ts `findFigureForUser`** `select` 收窄（id/ownerId/prompt/createdAt/updatedAt/png + job{id,status,errorMessage}），
     排除 xml/evaluation 大文本列；png 保留（PNG 路径所需，单行成本可接受，归属门单点代价记录在案）。
  4) **runner.ts `AutoFigureArtifacts`** 改 `Pick<AutoFigureGenerationSuccess,'xml'|'png'|'evaluation'>`（单一来源，消重复声明；
     修复 Standards 3）。
  5) **AGENTS.md** #312 信封段补二进制成功路径豁免（PNG 成功返原生字节、错误面仍走信封；修复 Standards 1）。
  接受不修（记录在案）：figuresPng seedFigure 与 figuresHistory seedFigure fixture 重复（签名不同、多产物列，抽公共 fixture
  收益有限，保留两文件各自局部 fixture 的既有家风格；Standards 2）。
- **second code review**: 双轴第二轮复核（修复后，针对当前工作树）。
  - Standards 轴：4 处 fixes 全部 confirmed——upgrade-schema 列集/序与 init.sql 精确一致 + 注释准确 + 幂等保持 +
    user_version 仍 6；listFigures/findFigureForUser select 恰好覆盖各自消费者（toSummary/publicFailureReason/png/status），
    FigureOwnedRow 与 select 形状匹配；Pick 单源、导入无残留（service.ts 保留 FigurePngBytes 正当）；AGENTS.md 豁免与 routes.ts
    精确一致（无其他二进制字节路径豁免）。无新违规/无新 smell。非阻塞（pre-existing，非本 diff）：generation_jobs CREATE TABLE
    仍缺 startedAt/finishedAt（依赖 T03 ALTER guard），功能正确。
  - Spec 轴：upgrade-schema fresh-vs-upgrade 列一致为真（schema.prisma/init.sql/upgrade-schema 三文件列集一致）、ALTER guard
    幂等、user_version=6 不变、schemaUpgrade.test.ts 匹配（notnull===0 + version 6）；listFigures/findFigureForUser select
    排除产物列且无消费者读 xml/evaluation（grep 核验；runner 仅 succeeded 提交路径写）、PNG 仍字节精确（Uint8Array→Buffer.from）、
    70040/70042/70043 门不变、list/detail 行为无回归。两处 finding 全部 RESOLVED、无新 spec 问题。
- implementation commit: `d38dde6` (`feat: AutoFigure T06 — artifact persistence and PNG download`)
- completion-evidence commit: `309ca62` (`docs: record T06 completion evidence`)
- fixed point: `25133af`
