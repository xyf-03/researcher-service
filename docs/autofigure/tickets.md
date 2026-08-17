# AutoFigure V1 —— ticket 计划

> 状态：**已批准，待发布**。本文档固化 AutoFigure V1 的 ticket 分解：DAG / blockers / 执行波次 / 工作流。
> 每个 ticket 一个独立文件（`docs/autofigure/tickets/Txx-*.md`）。
> 发布方式：由用户手动执行 `gh` 逐票发布（当前环境未安装 `gh` CLI），统一加 `ready-for-agent` triage 标签。

## Purpose

把已批准的 AutoFigure V1 集成拆分为 **12 个可独立实施的 ticket**。每个 ticket 面向一个 **fresh Claude Code context**
实施：只做自身范围、验收可观察、显式声明依赖与「不得提前实现」的下游行为。
**本文件是唯一的 DAG / blockers / 执行波次权威**；各 ticket 文件的 `Blocked by` 必须与此一致。

## Source spec（Source of Truth）

- `docs/autofigure/spec.md` —— 规格（PRD），唯一功能来源（Source of Truth #1）。
- `docs/autofigure/grilling-decisions.md` —— 已批准决策记录（§17 幂等契约、§13 Out of Scope、§14 否决方案，Source of Truth #2）。
- `CONTEXT.md` + 适用 ADR —— 宿主架构不变量：#312 全局信封、config boundary（唯一 env 读取）、ADR 0005 凭证只经 env 注入、ADR 0012/0013（FileArchive 语义、零 host 挂载）。
- 已批准 DAG —— 本会话裁决（下表为准，见 [Authoritative DAG](#authoritative-dag)）。

## V1 scope reminder（V1 范围提醒）

- **能力集**：text-to-figure 初始生成 + PNG 下载 + 历史列表 / 详情重开。
- **Figure 1:1 GenerationJob**，两表职责分离，非为未来 1:N 预留。
- **V1 无 Figure 删除（owner 与 admin 均无）**；无硬删、无级联删除公开行为；删除后的幂等键复用语义不定义（grilling §17.13）。
- **无 BullMQ AutoFigure 依赖**；**无自动重试**；**无 V2 功能**（continue / refine / finalize / enhance / PDF 输入 / FigureProject / FigureRevision / draw.io 编辑等，grilling §13）。
- **`AutoFigureGenerationPort` 保持窄边界**：只代表外部 AutoFigure 计算能力；不拥有 Job 生命周期 / 状态机 / 持久化 / 幂等 / 领取 / 超时 / reconcile / 归属 / REST 信封。
- **凭证**：系统级共享 `AUTOFIGURE_*`（含 `AUTOFIGURE_LLM_KEY` 设计方向），服务端注入，**永不经请求体、不入 Job payload、不落盘、不入日志 / 追踪 / 公开错误**；不复用 `LLM_API_KEY`。
- **feature flag** `AUTOFIGURE_ENABLED` 默认关闭；关闭时路由 / worker / sidecar 依赖不装配（90005）。
- **错误码段** `7xxxx`（`70040` 不存在/越权同码防探测；冲突类按「41 冲突」锁式）。
- **测试**：唯一新接缝 = `AutoFigureGenerationPort`（fake 注入）；复用既有 REST 信封接缝 + 门控 smoke；**测试 fixture 不是依赖边**。

## Authoritative DAG

### Visual DAG

```
        ┌─────────────────────────────► T9 ────┐
        │                                     ▼
T1 ──► T3 ──► T4 ──┐                        T12
 │       │     └──► T6 ───────────────────────┘
 │       └─► T7 ──► T8 ─┬─► T10 ────────┐
 │                       └─► T11 ────────┴──► T12
 │
 ├──► T2 ───────────────────► T9
 └──► T5 ───────────────────► T6
```

（若上图歧义，以 [Edge list](#authoritative-edge-list) 为准。）

### Authoritative edge list

```
T1  → T2, T3, T5
T3  → T4, T7
T4  → T6
T5  → T6
T7  → T8
T8  → T10, T11
T2  → T9
T6  → T9
T9  → T12
T10 → T12
T11 → T12
```

### Blockers table

| ID | Title | Blocked by |
|---|---|---|
| T01 | Authenticated Figure creation | None — can start immediately |
| T02 | Idempotent Figure creation | T01 |
| T03 | Single-worker generation lifecycle | T01 |
| T04 | Timeout / reconcile / late-result | T03 |
| T05 | Figure history / ownership | T01 |
| T06 | Artifact persistence + PNG | T04, T05 |
| T07 | AutoFigure HTTP adapter | T03 |
| T08 | Python sidecar | T07 |
| T09 | Vue figure journey | T02, T06 |
| T10 | Dev sidecar smoke | T08 |
| T11 | Production packaging / CD | T08 |
| T12 | V1 E2E verification | T09, T10, T11 |

### Execution waves

```
W0: T1
W1: T2 · T3 · T5
W2: T4 · T7
W3: T6 · T8
W4: T9 · T10 · T11
W5: T12
```

关键并行：T2 / T3 / T5（W1）在 T1 后并行；T10 / T11（W4）在 T8 后并行。
**依赖边只表示真实的代码 / 契约前置**；T2 / T5 的状态布置经持久化 fixture，不构成对 runner 的依赖。

### Ticket summary table

| ID | Title | Delivers | 主要验收面 |
|---|---|---|---|
| T01 | Authenticated Figure creation | 认证原子创建 Figure + queued GenerationJob（1:1）骨架；flag 门 | 10001 / 90002 / 90005 / 原子创建 / ownerId 派生 |
| T02 | Idempotent Figure creation | §17 幂等契约（含四状态重放，经 fixture） | 幂等键全验收清单（grilling §17.15） |
| T03 | Single-worker generation lifecycle | `AutoFigureGenerationPort` + fake；单写者 runner；状态机；startedAt/finishedAt | 原子领取 / concurrency=1 / 转换合法性 / 凭证注入不落盘 |
| T04 | Timeout / reconcile / late-result | 30min 超时、启动 reconcile、迟到结果围栏 | 超时→failed / reconcile / 迟到结果丢弃 / 不删除 |
| T05 | Figure history / ownership | GET /figures（user 列表 + admin 全见）、GET /figures/:id、归属门 70040 | 列表 / 详情 / 反枚举 / admin 可见性（spec US15） |
| T06 | Artifact persistence + PNG | 产物列（xml/png/evaluation）；仅 succeeded 提交；GET /figures/:id/png | 产物提交时机 / 下载 / 非 owner 70040 |
| T07 | AutoFigure HTTP adapter | Port 生产实现（私有 HTTP）+ sidecar 契约文档（凭证传输归本票） | 契约 schema 测试 / 错误映射 / 凭证不外泄 |
| T08 | Python sidecar | sidecar 服务（桥接 text-to-figure、/health、跨调用隔离） | 契约自测 / 隔离行为 / 无 JWT/userId |
| T09 | Vue figure journey | Vue-native 旅程：输入→提交→轮询→预览/下载→历史→详情 | 客户端测试 / 视图测试 / flag 关提示 |
| T10 | Dev sidecar smoke | dev compose 接线 + 门控真实生成 smoke | dev 栈 sidecar up + health / 真生成（门控） |
| T11 | Production packaging / CD | deploy compose + GHCR 镜像管线 + 许可署名 + 健康行为要求 | 镜像推送 / flag 关独立 / flag 开可检测 / 许可 |
| T12 | V1 E2E verification | 最终门控集成验证（无新行为） | 全链路 + 负路径清单 |

## Implementation workflow（实施工作流）

- **每个 ticket 必须在 fresh Claude Code context 中实施**（不跨 ticket 共享上下文状态）。
- **实施上下文**：`CLAUDE.md` + `CONTEXT.md`（全局大上下文）+ **当前 ticket 文件**（含其 Acceptance criteria / Relevant global invariants / Out of scope）。
- 每个 ticket 只实现自身范围；验收标准即完成定义；`Completion evidence` 由实施会话填写。
- 遇到超范围需求 → 记录，不越界实现；是否扩展走决策流程（不开新产品决策）。
- ticket 依赖的模块只以已批准源（spec / grilling / 上级 ticket 交付）为准，不臆造未交付接口。

## Review workflow（评审工作流）

- **代码评审上下文**：全量 spec 上下文（spec.md + grilling-decisions.md + CONTEXT.md）+ **当前 ticket 的 diff**。
- 评审聚焦本 ticket 的 acceptance 是否达成、是否触碰「Explicitly out of scope」、是否违反 Relevant global invariants。
- 不得以「未来 ticket 会用」为由提前实现被列出的下游行为。
- 评审通过后才允许合并 / 推进到依赖它的 ticket。

## Debugging workflow（排障工作流）

- **诊断上下文**：全量架构 / spec / DAG 上下文 + **最小确定性复现**（最小时复现路径优先于猜测）。
- 先按执行波次定位：该行为应由哪个 ticket / 波次交付；确认不是下游行为被提前实现或上游未交付。
- 使用对应接缝（REST 接缝 / Port fake / 门控 smoke）复现，不依赖真实 30min 等待（超时测试经 config 注入短超时）。
- 复现结果如实记录；修复归属到相应 ticket，不跨 ticket 打补丁。

---

## Completion evidence（通用模板）

每个 ticket 文件的 `## Completion evidence` 由实施会话填写：

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:
